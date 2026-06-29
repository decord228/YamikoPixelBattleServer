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

let S3Client, PutObjectCommand, GetObjectCommand;
try {
  ({ S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3'));
} catch (e) {
  console.warn('[Timelapse] ⚠ @aws-sdk/client-s3 не найден. Выполни: npm install @aws-sdk/client-s3');
}

const BUCKET = process.env.R2_BUCKET || 'pixel-battle-timelapse';

// ── Бинарный формат события: 9 байт ───────────────────────
//  Offset  Size  Поле
//    0      2    x  (uint16 BE, 0–65535)
//    2      2    y  (uint16 BE, 0–65535)
//    4      1    colorIdx (uint8, 0–31)
//    5      4    ms с начала сессии (uint32 BE, max ~49 дней)
// Итого: 9 B × 1 000 000 событий = 9 МБ (удобно читается DataView на клиенте)

function encodeEvent(x, y, c, offsetMs) {
  const b = Buffer.allocUnsafe(9);
  b.writeUInt16BE(x, 0);
  b.writeUInt16BE(y, 2);
  b[4] = c;
  b.writeUInt32BE(offsetMs >>> 0, 5); // >>>0 = clamp to uint32
  return b;
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

// ── Состояние ─────────────────────────────────────────────
// Параметры экономии: настрой под свою нагрузку
const FLUSH_EVERY_MS      = 5 * 60 * 1000; // раз в 5 минут (= 2016 Class A ops за 7 дней)
const FLUSH_EVERY_EVENTS  = 10_000;         // или если буфер набрал 10k событий

let session     = null; // активная сессия
let flushTimer  = null;
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

  session = { id, startedAt: Date.now(), buffer: [], chunkIndex: 0, totalEvents: 0 };
  flushTimer = setInterval(_flushBuffer, FLUSH_EVERY_MS);

  console.log(`[Timelapse] ▶  Начата запись: ${id}`);
  return id;
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
  };

  await r2Put(`timelapse/${s.id}/index.json`, JSON.stringify(index), 'application/json');
  await _updateSessionList(index);

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

    // Последний шанс: сканируем чанки напрямую
    if (typeof totalChunks === 'undefined') {
      console.warn(`[Timelapse] getEvents: index не найден для ${sessionId}, сканируем чанки...`);
      totalChunks = 0;
      while (true) {
        const key = `timelapse/${sessionId}/chunk_${String(totalChunks).padStart(4, '0')}.bin`;
        try { await r2GetBytes(key); totalChunks++; }
        catch (_) { break; }
      }
      console.log(`[Timelapse] getEvents: найдено сканированием: ${totalChunks} чанков`);
    }
  }

  if (!totalChunks) return Buffer.alloc(0);

  // Загружаем все чанки параллельно
  const keys = Array.from({ length: totalChunks }, (_, i) =>
    `timelapse/${sessionId}/chunk_${String(i).padStart(4, '0')}.bin`
  );
  const parts = await Promise.all(keys.map(k => r2GetBytes(k)));
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
  };
}

function isRecording() { return !!session; }

// ── Приватные хелперы ──────────────────────────────────────

async function _flushBuffer() {
  if (!session || session.buffer.length === 0) return;

  const events = session.buffer.splice(0); // дренируем буфер
  const key = `timelapse/${session.id}/chunk_${String(session.chunkIndex).padStart(4, '0')}.bin`;

  try {
    await r2Put(key, Buffer.concat(events));
    const savedIdx = session.chunkIndex;
    session.chunkIndex++;
    console.log(`[Timelapse] ↑ chunk_${savedIdx} → ${events.length} событий (${(events.length * 9 / 1024).toFixed(1)} КБ)`);
  } catch (e) {
    // Не потеряем данные — вернём в начало буфера
    session.buffer.unshift(...events);
    console.error('[Timelapse] ❌ Ошибка загрузки чанка:', e.message);
  }
}

async function _updateSessionList(newEntry) {
  let list = [];
  try   { list = JSON.parse(await r2GetText('timelapse/sessions.json')); } catch {}
  list.push(newEntry);
  await r2Put('timelapse/sessions.json', JSON.stringify(list), 'application/json');
}

module.exports = { startRecording, stopRecording, recordPixel, recordPixelsBatch, getSessions, getSnapshot, getEvents, getStatus, isRecording };