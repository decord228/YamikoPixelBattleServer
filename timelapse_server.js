'use strict';

// ════════════════════════════════════════════════════════════
//  TIMELAPSE MODULE  (timelapse_server.js)
//
//  Экономия R2 free tier (1M Class A / месяц):
//    - буфер в памяти, flush пачками (10 000 событий ИЛИ раз в 5 минут)
//    - типичная неделя записи ≈ 2 000–5 000 Class A ops — почти ничего
//    - бинарный формат 9 байт/событие → 10M px ≈ 90 МБ (в 10 ГБ влезает легко)
//
//  Env переменные (добавь в .env / Render dashboard):
//    R2_ACCOUNT_ID        — Account ID из Cloudflare Dashboard
//    R2_ACCESS_KEY_ID     — Access Key ID
//    R2_SECRET_ACCESS_KEY — Secret Access Key
//    R2_BUCKET            — имя бакета (по умолч. "pixel-battle-timelapse")
// ════════════════════════════════════════════════════════════

let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand;
try {
  ({ S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3'));
} catch (e) {
  console.warn('[Timelapse] ⚠ @aws-sdk/client-s3 не найден. Выполни: npm install @aws-sdk/client-s3');
}

const BUCKET = process.env.R2_BUCKET || 'pixel-battle-timelapse';

// ── Бинарный формат события: 9 байт ───────────────────────
//  Offset  Size  Поле
//    0      2    x  (uint16 BE, 0–65535)           [resize: newW]
//    2      2    y  (uint16 BE, 0–65535)           [resize: newH]
//    4      1    colorIdx (uint8, 0–31)             — 0xFF = служебное событие RESIZE
//    5      4    ms с начала сессии (uint32 BE, max ~49 дней)
// Итого: 9 B × 1 000 000 событий = 9 МБ (удобно читается DataView на клиенте)
//
// Служебное событие RESIZE (colorIdx===0xFF) позволяет менять размер холста
// ВНУТРИ одной и той же сессии — без необходимости останавливать запись и
// начинать новую. Поля x/y в этом случае несут newW/newH, а не координаты.
// Это единственное, что нужно клиенту, чтобы корректно перестроить tlFrame
// (старые пиксели сохраняются в левом верхнем углу, новая область — белая)
// в момент воспроизведения, когда он доходит до этого timestamp.

const RESIZE_SENTINEL = 0xFF;

function encodeEvent(x, y, c, offsetMs) {
  const b = Buffer.allocUnsafe(9);
  b.writeUInt16BE(x, 0);
  b.writeUInt16BE(y, 2);
  b[4] = c;
  b.writeUInt32BE(offsetMs >>> 0, 5); // >>>0 = clamp to uint32
  return b;
}

function encodeResizeEvent(newW, newH, offsetMs) {
  return encodeEvent(newW, newH, RESIZE_SENTINEL, offsetMs);
}

// ── R2 клиент ─────────────────────────────────────────────
let r2 = null;

function ensureR2() {
  if (r2) return true;
  if (!S3Client) return false;
  const acct   = process.env.R2_ACCOUNT_ID;
  const key    = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  if (!acct || !key || !secret) return false;
  r2 = new S3Client({
    region:   'auto',
    endpoint: `https://${acct}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: key, secretAccessKey: secret },
  });
  console.log('[Timelapse] ✅ R2 клиент инициализирован');
  return true;
}

async function r2Put(key, body, ct = 'application/octet-stream') {
  await r2.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: ct }));
}

async function r2GetText(key) {
  const resp = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return resp.Body.transformToString();
}

async function r2GetBytes(key) {
  const resp = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await resp.Body.transformToByteArray());
}

async function r2Delete(key) {
  await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// ── Состояние ─────────────────────────────────────────────
// Параметры экономии: настрой под свою нагрузку
const FLUSH_EVERY_MS      = 5 * 60 * 1000; // раз в 5 минут (= 2016 Class A ops за 7 дней)
const FLUSH_EVERY_EVENTS  = 10_000;         // или если буфер набрал 10k событий

let session     = null; // активная сессия
let flushTimer  = null;

// Ключ в R2, где хранится "живое" состояние текущей записи (id/chunkIndex/
// totalEvents/размеры). Обновляется при старте записи и после каждого
// успешного flush. Нужен, чтобы после падения/рестарта процесса (напр.
// деплой на Render) сервер мог ПРОДОЛЖИТЬ ту же сессию, а не молча терять
// запись — раньше session хранился только в памяти и рестарт сервера
// останавливал запись без явной остановки (stopRecording ни разу не
// вызывался, поэтому не создавался даже index.json — сессия просто "висела"
// недописанной в R2 и пропадала из истории).
const ACTIVE_SESSION_KEY = 'timelapse/active_session.json';
// Promise-цепочка для сериализации флашей: предотвращает race condition,
// когда два flush запускаются одновременно и оба читают одинаковый chunkIndex
// до того как первый успел его инкрементировать (await r2Put).
let _flushChain = Promise.resolve();
// session: { id, startedAt, buffer: Buffer[], chunkIndex, totalEvents }

// ── Публичное API ──────────────────────────────────────────

/**
 * Начать запись. canvasData — текущий Uint8Array холста.
 * Сохраняет снапшот (1 Class A op).
 */
async function startRecording(canvasData, canvasW, canvasH) {
  if (!ensureR2())    throw new Error('R2 не настроен. Проверь env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  if (session)        throw new Error('Запись уже идёт: ' + session.id);

  const id = 'session_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Снапшот: 4 байта заголовка (w, h) + raw пиксели
  const header = Buffer.alloc(4);
  header.writeUInt16BE(canvasW, 0);
  header.writeUInt16BE(canvasH, 2);
  await r2Put(`timelapse/${id}/snapshot.bin`, Buffer.concat([header, Buffer.from(canvasData)]));

  session = { id, startedAt: Date.now(), buffer: [], chunkIndex: 0, totalEvents: 0, w: canvasW, h: canvasH, currentW: canvasW, currentH: canvasH };
  flushTimer = setInterval(_flushBuffer, FLUSH_EVERY_MS);
  await _persistActiveSession();

  console.log(`[Timelapse] ▶  Начата запись: ${id}`);
  return id;
}

/**
 * Восстановить запись после рестарта сервера. Вызывается один раз при
 * старте процесса. Если в R2 лежит "живая" сессия (сервер упал/перезапустился
 * до stopRecording) — поднимаем её в память и продолжаем флашить новые чанки
 * с того же chunkIndex, вместо того чтобы молча считать запись остановленной.
 * Буфер событий, не успевших зафлашиться до рестарта (максимум
 * FLUSH_EVERY_EVENTS штук или события за последние FLUSH_EVERY_MS), теряется —
 * это неизбежно при потере процесса в памяти, но сама сессия не обрывается.
 */
async function resumeRecording() {
  if (session) return true; // уже что-то пишем — ничего восстанавливать не нужно
  if (!ensureR2()) return false;
  let saved;
  try {
    saved = JSON.parse(await r2GetText(ACTIVE_SESSION_KEY));
  } catch (_) {
    return false; // активной сессии нет — это нормальное состояние
  }
  if (!saved || !saved.id) return false;

  session = {
    id: saved.id,
    startedAt: saved.startedAt,
    buffer: [],
    chunkIndex: saved.chunkIndex || 0,
    totalEvents: saved.totalEvents || 0,
    w: saved.w,
    h: saved.h,
    currentW: saved.currentW || saved.w,
    currentH: saved.currentH || saved.h,
  };
  flushTimer = setInterval(_flushBuffer, FLUSH_EVERY_MS);
  console.log(`[Timelapse] ↻ Запись восстановлена после рестарта сервера: ${session.id} (уже сохранено чанков: ${session.chunkIndex}, событий: ${session.totalEvents})`);
  return true;
}

async function _persistActiveSession() {
  if (!session) return;
  try {
    await r2Put(ACTIVE_SESSION_KEY, JSON.stringify({
      id: session.id,
      startedAt: session.startedAt,
      chunkIndex: session.chunkIndex,
      totalEvents: session.totalEvents,
      w: session.w,
      h: session.h,
      currentW: session.currentW,
      currentH: session.currentH,
    }), 'application/json');
  } catch (e) {
    console.error('[Timelapse] ⚠ Не удалось сохранить состояние активной записи:', e.message);
  }
}

/**
 * Записать пиксель в буфер. Вызывается для КАЖДОГО пикселя — 0 накладных расходов
 * пока буфер не переполнится.
 */
function recordPixel(x, y, c) {
  if (!session) return;
  const offsetMs = Math.min(Date.now() - session.startedAt, 0xFFFFFFFF);
  session.buffer.push(encodeEvent(x, y, c, offsetMs));
  session.totalEvents++;
  if (session.buffer.length >= FLUSH_EVERY_EVENTS) {
    _flushBuffer().catch(e => console.error('[Timelapse] flush error:', e.message));
  }
}

/**
 * Записать несколько пикселей с одним общим timestamp.
 * Используется для admin-инструментов (прямоугольник, круг, заливка и т.д.)
 * чтобы весь батч появился в тайм-лапсе мгновенно, а не по одному пикселю.
 */
function recordPixelsBatch(pixels) {
  if (!session || !pixels || pixels.length === 0) return;
  const offsetMs = Math.min(Date.now() - session.startedAt, 0xFFFFFFFF);
  for (const p of pixels) {
    session.buffer.push(encodeEvent(p.x, p.y, p.c, offsetMs));
  }
  session.totalEvents += pixels.length;
  if (session.buffer.length >= FLUSH_EVERY_EVENTS) {
    _flushBuffer().catch(e => console.error('[Timelapse] flush error:', e.message));
  }
}

/**
 * Записать изменение размера холста ВНУТРИ текущей сессии (без её закрытия).
 * Сохраняет currentW/currentH в самой сессии, чтобы getStatus()/index.json
 * отражали актуальный размер, и пишет служебное событие RESIZE в буфер —
 * клиент при воспроизведении применит его в нужный момент времени.
 */
function recordResize(newW, newH) {
  if (!session) return;
  const offsetMs = Math.min(Date.now() - session.startedAt, 0xFFFFFFFF);
  session.buffer.push(encodeResizeEvent(newW, newH, offsetMs));
  session.totalEvents++;
  session.currentW = newW;
  session.currentH = newH;
  _persistActiveSession().catch(() => {}); // fire-and-forget, не блокируем resize
  if (session.buffer.length >= FLUSH_EVERY_EVENTS) {
    _flushBuffer().catch(e => console.error('[Timelapse] flush error:', e.message));
  }
}

/**
 * Остановить запись. Финальный flush + index.json + обновление списка сессий.
 * Итого: +2 Class A ops при остановке.
 */
async function stopRecording() {
  if (!session) throw new Error('Запись не идёт');
  clearInterval(flushTimer);
  flushTimer = null;

  await _flushBuffer(); // финальный flush

  const s = session;
  const index = {
    id:          s.id,
    startedAt:   s.startedAt,
    stoppedAt:   Date.now(),
    totalEvents: s.totalEvents,
    chunks:      s.chunkIndex,
    w:           s.w,          // размер холста НА МОМЕНТ НАЧАЛА записи (соответствует snapshot.bin)
    h:           s.h,
    finalW:      s.currentW,   // размер холста на момент остановки (после всех resize-событий внутри сессии)
    finalH:      s.currentH,
  };

  await r2Put(`timelapse/${s.id}/index.json`, JSON.stringify(index), 'application/json');
  await _updateSessionList(index);
  try { await r2Delete(ACTIVE_SESSION_KEY); } catch (_) {}

  session = null;
  console.log(`[Timelapse] ■  Остановлена: ${s.id} (${index.totalEvents} событий, ${index.chunks} чанков)`);
  return index;
}

/** Список сессий (читает sessions.json из R2, 1 Class B op). */
async function getSessions() {
  if (!ensureR2()) return [];
  try   { return JSON.parse(await r2GetText('timelapse/sessions.json')); }
  catch { return []; }
}

/** Бинарный снапшот холста для указанной сессии. */
async function getSnapshot(sessionId) {
  ensureR2();
  return r2GetBytes(`timelapse/${sessionId}/snapshot.bin`);
}

/**
 * Удалить сессию полностью: snapshot.bin, index.json, все chunk_*.bin
 * и запись из sessions.json.
 * Нельзя удалить сессию, которая сейчас активно записывается —
 * её нужно сначала остановить (stopRecording).
 */
async function deleteSession(sessionId) {
  if (!ensureR2()) throw new Error('R2 не настроен');
  if (session && session.id === sessionId) {
    throw new Error('Нельзя удалить сессию, которая сейчас записывается. Сначала останови запись.');
  }

  // Определяем количество чанков, чтобы знать что удалять —
  // те же fallback-уровни, что и в getEvents().
  let totalChunks;
  let listEntry = null;

  try {
    const list = JSON.parse(await r2GetText('timelapse/sessions.json'));
    listEntry = list.find(s => s.id === sessionId) || null;
    if (listEntry && typeof listEntry.chunks === 'number') totalChunks = listEntry.chunks;
  } catch (_) {}

  if (typeof totalChunks === 'undefined') {
    try {
      const idx = JSON.parse(await r2GetText(`timelapse/${sessionId}/index.json`));
      totalChunks = idx.chunks;
    } catch (_) {}
  }

  // Удаляем чанки. Если totalChunks неизвестен — сканируем и удаляем,
  // пока не наткнёмся на отсутствующий файл.
  let deletedChunks = 0;
  if (typeof totalChunks === 'number') {
    for (let i = 0; i < totalChunks; i++) {
      const key = `timelapse/${sessionId}/chunk_${String(i).padStart(4, '0')}.bin`;
      try { await r2Delete(key); deletedChunks++; } catch (_) {}
    }
  } else {
    while (true) {
      const key = `timelapse/${sessionId}/chunk_${String(deletedChunks).padStart(4, '0')}.bin`;
      try {
        await r2GetBytes(key); // проверяем что чанк существует
        await r2Delete(key);
        deletedChunks++;
      } catch (_) { break; }
    }
  }

  // Удаляем снапшот и index.json (не страшно, если их нет)
  try { await r2Delete(`timelapse/${sessionId}/snapshot.bin`); } catch (_) {}
  try { await r2Delete(`timelapse/${sessionId}/index.json`); } catch (_) {}

  // Убираем запись из sessions.json
  await _removeFromSessionList(sessionId);

  console.log(`[Timelapse] 🗑 Удалена сессия ${sessionId} (${deletedChunks} чанков)`);
  return { id: sessionId, deletedChunks };
}

/**
 * Все события сессии одним куском.
 * Читает чанки последовательно и возвращает Buffer.
 * Если сессия идёт прямо сейчас — читает только записанные чанки
 * (незафлашенный буфер не включён, чтобы не усложнять логику).
 */
async function getEvents(sessionId) {
  ensureR2();

  // Определяем количество чанков — три уровня fallback:
  //   1. Активная сессия в памяти (запись ещё идёт)
  //   2. sessions.json — есть поле chunks для завершённых сессий
  //   3. index.json   — создаётся только при stopRecording
  //   4. Прямое сканирование чанков в R2 (сессия прервана без stop)
  let totalChunks;

  if (session && session.id === sessionId) {
    totalChunks = session.chunkIndex;
    console.log(`[Timelapse] getEvents: активная сессия, чанков=${totalChunks}`);
  } else {
    // Пробуем sessions.json
    try {
      const list = JSON.parse(await r2GetText('timelapse/sessions.json'));
      const entry = list.find(s => s.id === sessionId);
      if (entry && typeof entry.chunks === 'number') {
        totalChunks = entry.chunks;
        console.log(`[Timelapse] getEvents: из sessions.json, чанков=${totalChunks}`);
      }
    } catch (_) {}

    // Пробуем index.json
    if (typeof totalChunks === 'undefined') {
      try {
        const idx = JSON.parse(await r2GetText(`timelapse/${sessionId}/index.json`));
        totalChunks = idx.chunks;
        console.log(`[Timelapse] getEvents: из index.json, чанков=${totalChunks}`);
      } catch (_) {}
    }

    // Последний шанс: сканируем чанки напрямую, кэшируем байты чтобы не качать дважды
    if (typeof totalChunks === 'undefined') {
      console.warn(`[Timelapse] getEvents: index не найден для ${sessionId}, сканируем чанки...`);
      const scannedParts = [];
      while (true) {
        const key = `timelapse/${sessionId}/chunk_${String(scannedParts.length).padStart(4, '0')}.bin`;
        try { scannedParts.push(await r2GetBytes(key)); }
        catch (_) { break; }
      }
      console.log(`[Timelapse] getEvents: найдено сканированием: ${scannedParts.length} чанков`);
      if (!scannedParts.length) return Buffer.alloc(0);
      return Buffer.concat(scannedParts); // возвращаем сразу — уже всё скачано
    }
  } // конец else (не активная сессия)

  if (!totalChunks) return Buffer.alloc(0);

  // Загружаем чанки последовательно.
  // Если хотя бы один чанк отсутствует (index устарел) — останавливаемся на том что есть.
  const parts = [];
  for (let i = 0; i < totalChunks; i++) {
    const key = `timelapse/${sessionId}/chunk_${String(i).padStart(4, '0')}.bin`;
    try {
      parts.push(await r2GetBytes(key));
    } catch (e) {
      console.warn(`[Timelapse] getEvents: чанк ${i} не найден (${e.message}), отдаём ${i} из ${totalChunks}`);
      break;
    }
  }
  if (!parts.length) return Buffer.alloc(0);
  return Buffer.concat(parts);
}

/** Текущий статус записи. */
function getStatus() {
  if (!session) return { recording: false };
  return {
    recording:   true,
    sessionId:   session.id,
    startedAt:   session.startedAt,
    buffered:    session.buffer.length,
    totalEvents: session.totalEvents,
    flushed:     session.chunkIndex,
    w:           session.currentW,
    h:           session.currentH,
  };
}

function isRecording() { return !!session; }

// ── Приватные хелперы ──────────────────────────────────────

// _flushBuffer ставит задачу в конец promise-цепочки (_flushChain),
// гарантируя строгую последовательность: следующий flush не начнётся,
// пока не завершился r2Put предыдущего. Без этого два параллельных flush
// читали одинаковый chunkIndex → писали в один файл →
// chunkIndex инкрементировался дважды → в R2 образовывались «дыры».
function _flushBuffer() {
  _flushChain = _flushChain.then(_doFlush).catch(e => {
    console.error('[Timelapse] flush chain error:', e.message);
  });
  return _flushChain;
}

async function _doFlush() {
  if (!session || session.buffer.length === 0) return;

  const events = session.buffer.splice(0); // дренируем буфер атомарно (sync)
  const key = `timelapse/${session.id}/chunk_${String(session.chunkIndex).padStart(4, '0')}.bin`;

  try {
    await r2Put(key, Buffer.concat(events));
    if (!session) return; // stopRecording() вызвали пока мы ждали r2Put
    const savedIdx = session.chunkIndex;
    session.chunkIndex++;
    await _persistActiveSession();
    console.log(`[Timelapse] ↑ chunk_${savedIdx} → ${events.length} событий (${(events.length * 9 / 1024).toFixed(1)} КБ)`);
  } catch (e) {
    // Не потеряем данные — вернём в начало буфера
    // ВАЖНО: нельзя делать unshift(...events) при 10k элементах — RangeError: call stack
    if (!session) return; // сессия закрыта, данные уже не нужны
    session.buffer = events.concat(session.buffer);
    console.error('[Timelapse] ❌ Ошибка загрузки чанка:', e.message);
  }
}

async function _updateSessionList(newEntry) {
  let list = [];
  try   { list = JSON.parse(await r2GetText('timelapse/sessions.json')); } catch {}
  list.push(newEntry);
  await r2Put('timelapse/sessions.json', JSON.stringify(list), 'application/json');
}

async function _removeFromSessionList(sessionId) {
  let list = [];
  try   { list = JSON.parse(await r2GetText('timelapse/sessions.json')); } catch { return; }
  const filtered = list.filter(s => s.id !== sessionId);
  if (filtered.length !== list.length) {
    await r2Put('timelapse/sessions.json', JSON.stringify(filtered), 'application/json');
  }
}

module.exports = { startRecording, resumeRecording, stopRecording, recordPixel, recordPixelsBatch, recordResize, getSessions, getSnapshot, getEvents, getStatus, isRecording, deleteSession };