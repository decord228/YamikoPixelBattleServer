'use strict';

// ════════════════════════════════════════════════════════════
//  PIXEL BATTLE — SERVER v2.0
//  Рефакторинг + новые фичи: VIP-роль, магазин, кулдаун-слайдер,
//  сохранение move_area, превью изображений, глобальный чат
// ════════════════════════════════════════════════════════════

const express    = require('express');
const { WebSocketServer } = require('ws');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');

// ── OPTIONAL DEPS ──────────────────────────────────────────
let Redis = null, mongoose = null, cloudinary = null;
try { Redis      = require('@upstash/redis').Redis; }  catch(e) {}
try { mongoose   = require('mongoose'); }              catch(e) {}
try { cloudinary = require('cloudinary').v2; }         catch(e) {}

let tl = null;
try { tl = require('./timelapse_server'); } catch(e) {
  console.warn('[Timelapse] timelapse_server.js не найден');
}

// ── CONFIG ─────────────────────────────────────────────────
const PORT           = process.env.PORT || 3000;
const ADMIN_USERNAME = 'Yamiko';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || '';
// Секрет Turnstile хранится только в окружении хостинга, никогда не в клиенте.
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
console.log(`[ANTI-BOT] Turnstile ${TURNSTILE_SECRET_KEY ? 'enabled' : 'disabled (TURNSTILE_SECRET_KEY is missing)'}`);
const DISCORD_TEST_USER_ID = '409071932244492308';
const CANVAS_FILE       = path.join(__dirname, 'canvas.bin');
const META_FILE         = path.join(__dirname, 'canvas_meta.json');
const PIXEL_OWNERS_FILE = path.join(__dirname, 'pixel_owners.bin');
const PIXEL_IDS_FILE    = path.join(__dirname, 'pixel_owner_ids.json');

// ── CANVAS STATE ───────────────────────────────────────────
let CANVAS_WIDTH  = 256;
let CANVAS_HEIGHT = 256;
let CANVAS_SIZE   = CANVAS_WIDTH * CANVAS_HEIGHT;
let canvasData    = null;
let isDirty       = false;
let canvasPersistPromise = null;
// Наблюдаемое состояние последнего commit холста. Оно не попадает в
// таймлапс и не влияет на его текущую запись.
const boardPersistStatus = { lastSuccessAt:0, lastAttemptAt:0, lastSnapshotId:null, lastError:null, consecutiveFailures:0 };

// ── PIXEL OWNERSHIP ────────────────────────────────────────
// pixelOwners: Uint16Array[CANVAS_SIZE] — у каждого пикселя ID автора (0 = никто)
// ownerIdMap:  username → uint16 id
// ownerDataMap: uint16 id → { username, emoji }
// Размер для 256×256: 128 КБ — ничтожно мало
let pixelOwners  = null; // инициализируется после загрузки размеров холста
const ownerIdMap   = new Map(); // username → id
const ownerDataMap = new Map(); // id → { username, emoji }
let nextOwnerId    = 1;
let ownersDirty    = false;

// ── DISCORD AVATAR URL ──
// Строит CDN-ссылку на аватарку Discord из discord_id + avatar hash аккаунта.
// Возвращает null, если у аккаунта нет привязанного Discord-аватара —
// в этом случае клиент показывает дефолтную заглушку.
function getAvatarUrl(acc) {
  if (!acc || !acc.discord_id || !acc.discord_avatar) return null;
  const ext = acc.discord_avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${acc.discord_id}/${acc.discord_avatar}.${ext}?size=128`;
}

// ── БАННЕРЫ ПРОФИЛЯ (Этап 2) ──
// Единая точка правды для каталога баннеров — и сервер (валидация покупки/
// выбора), и клиент (рисует список) используют ИМЕННО этот массив: сервер
// отдаёт его целиком клиенту в auth_success (поле banners_catalog).
//
// Экономика — строго по ТЗ:
//   'free'     — доступен всем сразу (без owned_banners). ОДНОТОННЫЕ цвета
//                (поле css — просто hex, БЕЗ градиента). Раньше здесь по
//                ошибке лежали градиенты — перепутали с платным тиром,
//                см. запись в REWORK_PLAN про фикс этого места.
//   'gradient' — CSS-градиент (поле css), фиксированная цена 20 монет
//                (цена удвоена по просьбе заказчика от изначальных 10) —
//                НЕ 150-200, это была та же путаница со свободным тиром.
//   'animated' — анимированный баннер, 100-1000 монет по сложности/красоте
//                (ТЗ: "простенькие" от 100 до "сложные" 1000). Два источника
//                в одном тире:
//                  1) встроенные CSS-анимации (PROFILE_BANNERS_ANIMATED_CSS
//                     ниже) — реальная анимация без файлов, доступна сразу
//                     из коробки;
//                  2) картинки/гифки из resources/banners/manifest.json —
//                     админ вручную кладёт файл в папку и дописывает строку
//                     в манифест (id/file/name/cost 100-1000), без правки
//                     кода (правило №5 плана).
const PROFILE_BANNERS_BUILTIN = [
  { id:'banner_none',    tier:'free', name:'Без баннера',   cost:0, css:null },
  { id:'banner_c_white', tier:'free', name:'Белый',         cost:3,  css:'#e4e4e4' },
  { id:'banner_c_slate', tier:'free', name:'Графит',        cost:3,  css:'#3a3a3a' },
  { id:'banner_c_black', tier:'free', name:'Чёрный',        cost:3,  css:'#1a1a1a' },
  { id:'banner_c_red',   tier:'free', name:'Красный',       cost:3,  css:'#e40000' },
  { id:'banner_c_orange',tier:'free', name:'Оранжевый',     cost:3,  css:'#ff9600' },
  { id:'banner_c_yellow',tier:'free', name:'Жёлтый',        cost:3,  css:'#ffd635' },
  { id:'banner_c_green', tier:'free', name:'Зелёный',       cost:3,  css:'#00a368' },
  { id:'banner_c_teal',  tier:'free', name:'Бирюзовый',     cost:3,  css:'#009eaa' },
  { id:'banner_c_blue',  tier:'free', name:'Синий',         cost:3,  css:'#2450a4' },
  { id:'banner_c_indigo',tier:'free', name:'Индиго',        cost:3,  css:'#493ac1' },
  { id:'banner_c_purple',tier:'free', name:'Пурпурный',     cost:3,  css:'#811e9f' },
  { id:'banner_c_pink',  tier:'free', name:'Розовый',       cost:3,  css:'#ff6392' },

  { id:'banner_sunset',  tier:'gradient', name:'Закат',    cost:20, css:'linear-gradient(135deg,#ff9600,#d40078)' },
  { id:'banner_ocean',   tier:'gradient', name:'Океан',    cost:20, css:'linear-gradient(135deg,#00756f,#2450a4)' },
  { id:'banner_forest',  tier:'gradient', name:'Лес',      cost:20, css:'linear-gradient(135deg,#006030,#7eed56)' },
  { id:'banner_royal',   tier:'gradient', name:'Аметист',  cost:20, css:'linear-gradient(135deg,#493ac1,#b44ac0)' },
  { id:'banner_flame',   tier:'gradient', name:'Пламя',    cost:20, css:'linear-gradient(135deg,#8a0022,#ff9600)' },
  { id:'banner_mint',    tier:'gradient', name:'Мята',     cost:20, css:'linear-gradient(135deg,#00a368,#51e9f4)' },
  { id:'banner_candy',   tier:'gradient', name:'Малина',   cost:20, css:'linear-gradient(135deg,#d40078,#ff99aa)' },
  { id:'banner_slate_g', tier:'gradient', name:'Графит',   cost:20, css:'linear-gradient(135deg,#1a1a1a,#3a3a3a)' },
  { id:'banner_indigo_g',tier:'gradient', name:'Индиго',   cost:20, css:'linear-gradient(135deg,#1d2b53,#493ac1)' },
];

// Встроенные анимированные баннеры (CSS keyframes, см. .pbanner-anim-* в
// style.css) — не требуют файлов, доступны сразу. `anim` — имя CSS-класса
// с анимацией, `css` — фон под ней (градиент/цвет, участвует в кадрах).
// Цена растёт по числу "слоёв"/сложности анимации, как просил заказчик.
const PROFILE_BANNERS_ANIMATED_CSS = [
  { id:'banner_a_pulse',    tier:'animated', name:'Пульс',        cost:120,   anim:'pbanner-anim-pulse',    css:'linear-gradient(135deg,#493ac1,#3690ea)' },
  { id:'banner_a_tide',     tier:'animated', name:'Прилив',       cost:150,   anim:'pbanner-anim-tide',     css:'linear-gradient(120deg,#00756f,#2450a4,#00756f)' },
  { id:'banner_a_aurora',   tier:'animated', name:'Аврора',       cost:270,  anim:'pbanner-anim-aurora',   css:'linear-gradient(120deg,#006030,#493ac1,#d40078,#006030)' },
  { id:'banner_a_stardust', tier:'animated', name:'Звёздная пыль',cost:420,  anim:'pbanner-anim-stardust', css:'linear-gradient(135deg,#0a0a14,#1d2b53)' },
  { id:'banner_a_rainbow',  tier:'animated', name:'Радуга',       cost:600,  anim:'pbanner-anim-rainbow',  css:'linear-gradient(90deg,#e40000,#ff9600,#ffd635,#00a368,#2450a4,#811e9f,#e40000)' },
];

// ── ГЕОМЕТРИЧЕСКИЕ БАННЕРЫ (Этап 2, доп. заказ заказчика: +6 баннеров) ──
// Отдельный визуальный тип от переливающихся градиентов выше: анимированные
// ФИГУРЫ поверх/вместо фона (соты/треугольники/полосы/кольца/точки/молния),
// не ещё одно "цветовое пятно". Тот же механизм anim-класса на
// .row-banner-bg/.profile-banner-card-bg (см. PROFILE_BANNERS_ANIMATED_CSS
// выше), просто CSS другая (clip-path/conic-gradient/repeating-linear-
// gradient вместо background-position анимации) — см. .pbanner-geo-* в
// style.css. Цены по той же логике сложности/красоты (100–1000).
const PROFILE_BANNERS_GEOMETRIC = [
  { id:'banner_g_hex',      tier:'animated', name:'Соты',             cost:210, anim:'pbanner-geo-hex',      css:'linear-gradient(120deg,#050308,#12081f,#2b1030,#12081f,#050308)' },
  { id:'banner_g_triangle', tier:'animated', name:'Триангуляция',     cost:150,  anim:'pbanner-geo-triangle', css:'#1d2b53' },
  { id:'banner_g_stripes',  tier:'animated', name:'Диагонали',        cost:120,  anim:'pbanner-geo-stripes',  css:'#2b1e3e' },
  { id:'banner_g_rings',    tier:'animated', name:'Радар',            cost:210, anim:'pbanner-geo-rings',    css:'#0a0a14' },
  { id:'banner_g_dots',     tier:'animated', name:'Пиксельная сетка', cost:120,  anim:'pbanner-geo-dots',     css:'#1a1a1a' },
  { id:'banner_g_bolt',     tier:'animated', name:'Молния',           cost:240, anim:'pbanner-geo-bolt',     css:'#1d2b53' },
];

// ── ПРЕМИУМ-БАННЕРЫ (Этап 3, доп. заказ: "больше сложности, шедевры") ──
// Каждый — минимум два независимых слоя анимации (см. .pbanner-prem-* в
// style.css), а не один плоский градиент/паттерн. Космос/звёзды/аниме/
// пастельная эстетика ("пикми") — как просил заказчик. Цены — по
// визуальной сложности (350 — простейшие частицы, 950 — самые многослойные).
const PROFILE_BANNERS_PREMIUM = [
  { id:'banner_p_starfield',     tier:'animated', name:'Звёздное небо',   cost:270, anim:'pbanner-prem-starfield',     css:'linear-gradient(160deg,#05050f,#1d2b53,#05050f)' },
  { id:'banner_p_galaxy',        tier:'animated', name:'Галактика',       cost:540, anim:'pbanner-prem-galaxy',        css:'radial-gradient(circle at 50% 50%,#1d0f30,#05050a 70%)' },
  { id:'banner_p_sakura',        tier:'animated', name:'Сакура',          cost:300, anim:'pbanner-prem-sakura',        css:'linear-gradient(160deg,#ffd6e8,#ff9ec4,#6a3a7a)' },
  { id:'banner_p_pikmi',         tier:'animated', name:'Пикми',           cost:240, anim:'pbanner-prem-pikmi',         css:'linear-gradient(135deg,#ffd6f0,#c8b6ff,#b6f0ff,#ffe9b6)' },
  { id:'banner_p_matrix',        tier:'animated', name:'Матрица',         cost:270, anim:'pbanner-prem-matrix',        css:'#040a04' },
  { id:'banner_p_supernova',     tier:'animated', name:'Сверхновая',      cost:420, anim:'pbanner-prem-supernova',     css:'radial-gradient(circle at 50% 50%,#2b1000,#05050a 75%)' },
  { id:'banner_p_lava',          tier:'animated', name:'Лава',            cost:330, anim:'pbanner-prem-lava',          css:'linear-gradient(160deg,#1a0505,#3a0a0a)' },
  { id:'banner_p_ocean_deep',    tier:'animated', name:'Глубина океана',  cost:360, anim:'pbanner-prem-ocean',         css:'linear-gradient(180deg,#00343a,#001a20)' },
  { id:'banner_p_constellation', tier:'animated', name:'Созвездие',       cost:570, anim:'pbanner-prem-constellation', css:'linear-gradient(160deg,#05050f,#0d1230,#05050f)' },
];

const BANNERS_DIR          = path.join(__dirname, 'resources', 'banners');
const BANNERS_MANIFEST_FILE = path.join(BANNERS_DIR, 'manifest.json');

// Читает resources/banners/manifest.json → [{id,file,name,cost}] и строит
// из него animated-тир каталога (наравне со встроенными CSS-анимациями
// выше — оба источника пишутся в один тир 'animated'). Файлы раздаются как
// обычные статики — весь корень проекта уже смонтирован через
// express.static (см. ниже), так что никакого отдельного роута/прокси не
// нужно (в отличие от внешних доменов вроде Cloudinary — см.
// getProxiedImageUrl на клиенте).
// Цена (по ТЗ): 100 монет — простенькие гифки, 1000 — сложные/красивые.
// Пример строки манифеста: {"id":"banner_gif_dragon","file":"dragon.gif","name":"Дракон","cost":600}
//
// Поддерживаемые форматы файлов: .gif / .webp — картиночная анимация
// (рисуются клиентом как <img>, см. isVideo:false); .mp4 / .webm — видео
// (клиент рисует <video autoplay loop muted playsinline>, см. isVideo:true
// в profileBannerRowHTML/buildBannerPicker/renderReadOnlyBannerTab в ui.js).
// Определяется автоматически по расширению файла — в манифесте ничего
// дополнительно указывать не нужно.
const BANNER_VIDEO_EXT = new Set(['.mp4', '.webm']);

function loadAnimatedBanners() {
  try {
    if (!fs.existsSync(BANNERS_MANIFEST_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(BANNERS_MANIFEST_FILE, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(e => e && e.id && e.file)
      .map(e => ({
        id:   e.id,
        tier: 'animated',
        name: e.name || e.id,
        cost: Number.isFinite(Number(e.cost)) ? Number(e.cost) : 0,
        url:  `/resources/banners/${e.file}`,
        isVideo: BANNER_VIDEO_EXT.has(path.extname(e.file).toLowerCase()),
      }));
  } catch (e) {
    console.error('❌ loadAnimatedBanners:', e.message);
    return [];
  }
}

// Считаем один раз при старте процесса — если админ добавит баннер в манифест
// без релога сервера, он появится после следующего рестарта/деплоя (то же
// поведение, что и у остального статического конфига проекта).
const PROFILE_BANNERS = PROFILE_BANNERS_BUILTIN.concat(PROFILE_BANNERS_ANIMATED_CSS, PROFILE_BANNERS_GEOMETRIC, PROFILE_BANNERS_PREMIUM, loadAnimatedBanners());

function getBannerById(id) {
  if (!id) return null;
  return PROFILE_BANNERS.find(b => b.id === id) || null;
}

// Случайный ещё не полученный баннер указанного тира — используется наградой
// за звание (RANK_REWARDS: {type:'banner', tier}). Если игрок уже владеет
// всеми баннерами тира — выдаём случайный из тира повторно (не блокируем
// награду), просто ничего нового физически не добавится в owned_banners
// (проверка на дубликат делает вызывающий код в claim_rank_reward).
function pickRandomBannerReward(tier, ownedIds) {
  const owned = new Set(ownedIds || []);
  const pool = PROFILE_BANNERS.filter(b => b.tier === tier && b.cost > 0 && !owned.has(b.id));
  const fallback = PROFILE_BANNERS.filter(b => b.tier === tier && b.cost > 0);
  const list = pool.length ? pool : fallback;
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function getOrCreateOwnerId(username, emoji, avatar) {
  if (ownerIdMap.has(username)) {
    // Обновим emoji/avatar на случай если пользователь их сменил
    const id = ownerIdMap.get(username);
    ownerDataMap.set(id, { username, emoji: emoji || '👾', avatar: avatar || null });
    return id;
  }
  const id = nextOwnerId++;
  ownerIdMap.set(username, id);
  ownerDataMap.set(id, { username, emoji: emoji || '👾', avatar: avatar || null });
  return id;
}

function setPixelOwner(x, y, username, emoji, avatar) {
  if (!pixelOwners || x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) return;
  const id = getOrCreateOwnerId(username, emoji, avatar);
  pixelOwners[y * CANVAS_WIDTH + x] = id;
  ownersDirty = true;
}

// Все служебные операции над доской обязаны менять цвет и владельца вместе.
// Справочник ownerDataMap намеренно не чистим: ID может использоваться в уже
// сохранённых снимках, а неиспользуемая запись безвредна.
function getPixelOwnerId(x, y) {
  if (!pixelOwners || x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) return 0;
  return pixelOwners[y * CANVAS_WIDTH + x] || 0;
}
function setPixelOwnerId(x, y, id) {
  if (!pixelOwners || x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) return;
  pixelOwners[y * CANVAS_WIDTH + x] = id || 0;
  ownersDirty = true;
}
function clearPixelOwner(x, y) {
  setPixelOwnerId(x, y, 0);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const DISCORD_CAMPAIGN_COOLDOWN_MS = 10 * 60 * 1000;
const DISCORD_DUPLICATE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let discordCampaignRunning = false;
let discordCampaignLastStartedAt = 0;
let discordCampaignLastContentHash = '';
let discordCampaignLastContentAt = 0;
let discordApiPauseUntil = 0;

function buildDiscordCampaignPayload(content) {
  return { flags:32768, components:[{ type:17, accent_color:0x6366F1, components:[
    { type:10, content },
    { type:14, divider:true, spacing:1 },
    { type:1, components:[{ type:2, style:1, label:'Присоединиться к Пиксель Батлу', custom_id:'pixel_battle_launch_activity' }] },
  ] }] };
}

async function discordApiRequest(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const pause = discordApiPauseUntil - Date.now();
    if (pause > 0) await wait(pause);
    let response;
    try { response = await fetch(url, options); }
    catch (error) {
      if (attempt === maxRetries) throw error;
      await wait(750 * (attempt + 1));
      continue;
    }
    if (response.status === 429) {
      let body = {}; try { body = await response.json(); } catch (_) {}
      const retryMs = Math.max(250, Math.ceil(Number(body.retry_after || response.headers.get('retry-after') || 1) * 1000) + 120);
      discordApiPauseUntil = Math.max(discordApiPauseUntil, Date.now() + retryMs);
      if (attempt === maxRetries) throw new Error('Discord временно ограничил частоту отправки');
      await wait(retryMs);
      continue;
    }
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'));
    if (remaining === 0 && Number.isFinite(resetAfter) && resetAfter > 0) {
      discordApiPauseUntil = Math.max(discordApiPauseUntil, Date.now() + Math.ceil(resetAfter * 1000) + 80);
    }
    if (response.status >= 500 && attempt < maxRetries) { await wait(750 * (attempt + 1)); continue; }
    return response;
  }
}

async function sendDiscordMessageToUser(recipientId, content) {
  if (!DISCORD_BOT_TOKEN) throw new Error('Не задана переменная DISCORD_BOT_TOKEN');
  const headers = { Authorization:`Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type':'application/json' };
  const channelResponse = await discordApiRequest('https://discord.com/api/v10/users/@me/channels', { method:'POST', headers, body:JSON.stringify({ recipient_id:recipientId }) });
  if (channelResponse.status === 401) throw new Error('Discord отклонил токен бота');
  if (!channelResponse.ok) return false;
  const channel = await channelResponse.json();
  const messageResponse = await discordApiRequest(`https://discord.com/api/v10/channels/${channel.id}/messages`, { method:'POST', headers, body:JSON.stringify(buildDiscordCampaignPayload(content)) });
  if (messageResponse.status === 401) throw new Error('Discord отклонил токен бота');
  return messageResponse.ok;
}

async function sendDiscordCampaign(content) {
  const accountsList = await dbGetAllAccounts();
  const recipientIds = [...new Set(accountsList.map(acc => String(acc.discord_id || '').trim()).filter(Boolean))];
  const result = { total:recipientIds.length, sent:0, failed:0 };
  for (const recipientId of recipientIds) {
    try { if (await sendDiscordMessageToUser(recipientId, content)) result.sent++; else result.failed++; }
    catch (error) { if (/токен бота/.test(error.message)) throw error; result.failed++; }
    await wait(550);
  }
  return result;
}

async function sendDiscordCampaignTest(content) {
  if (!await sendDiscordMessageToUser(DISCORD_TEST_USER_ID, content)) throw new Error('Discord не смог доставить тестовое сообщение');
}

function getPixelOwner(x, y) {
  if (!pixelOwners || x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) return null;
  const id = pixelOwners[y * CANVAS_WIDTH + x];
  if (!id) return null;
  return ownerDataMap.get(id) || null;
}

// ── SERVER SETTINGS ────────────────────────────────────────
let serverSettings = {
  cursorTrackingEnabled: false,
  cooldownMs: 10000,
  globalStencil: null,
  // ── ЛОКАУТ (глобальное закрытие Пиксель Батла) ──
  lockdown: { active: false, until: 0, message: '' },
  // ── РЕКЛАМА ──
  ads: { active: false, type: 'banner', imageUrl: '', link: '', intervalMinutes: 5 }
};

// Проверяет, закрыт ли Пиксель Батл прямо сейчас. Если время истекло —
// автоматически снимает блокировку и рассылает обновлённые настройки
// ВСЕМ клиентам, чтобы экран блокировки исчез ровно в момент истечения
// таймера, даже у тех, кто ничего не делает (не пытается ставить пиксели).
function isLockedNow() {
  const l = serverSettings.lockdown;
  if (!l || !l.active) return false;
  if (l.until && Date.now() >= l.until) {
    l.active = false;
    saveSettings();
    broadcastAll(JSON.stringify({ action: 'server_settings', settings: serverSettings }));
    return false;
  }
  return true;
}
setInterval(() => { try { isLockedNow(); } catch(e) {} }, 3000);

// ── IN-MEMORY STORES ───────────────────────────────────────
let accounts  = {};
let clans     = {};
let templates = [];
let newsItems = []; // ← Новости (слайдшоу + лента), см. NewsSchema ниже
const NEWS_FILE = path.join(__dirname, 'news.json');

// Глобальный чат (хранится только в памяти, сбрасывается при рестарте)
const globalChatHistory = [];
const CHAT_HISTORY_LIMIT = 100;

// Личные сообщения: pairKey ('userA__userB', отсортировано) → { messages:[{from,text,ts}] }
let dmThreads = {};
const DM_FILE = path.join(__dirname, 'dm.json');
const DM_HISTORY_LIMIT = 300;

// ── BATCH SAVE QUEUES ──────────────────────────────────────
const dirtyAccounts = new Set();
const dirtyClans    = new Set();

// ── CLOUDINARY ─────────────────────────────────────────────
if (cloudinary && process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log('✅ Cloudinary подключён');
}

// ── COIN REWARDS ───────────────────────────────────────────
const COINS_PER_PIXEL = 0.1;   // 1 монета за 10 пикселей
// Антибот работает в наблюдательном режиме: установка пикселей не блокируется
// по данным курсора, slow-mode и автоматический таймаут выключены. Высокий
// риск сохраняется в журнале администратора и может запросить Turnstile.
const ANTIBOT_BEHAVIOR_WINDOW_MS = 15 * 60 * 1000;
const ANTIBOT_BEHAVIOR_SAMPLE_SIZE = 16;
const ANTIBOT_BEHAVIOR_INTERVAL_CV_MAX = 0.02;
const ANTIBOT_LOG_DEDUP_MS = 2 * 60 * 1000;
const ANTIBOT_TURNSTILE_CHALLENGE_MS = 5 * 60 * 1000;
const ANTIBOT_TURNSTILE_CLEARANCE_MS = 30 * 60 * 1000;
const antiBotBehaviorByUsername = new Map();

function getAntiBotBehaviorState(username, now) {
  let state = antiBotBehaviorByUsername.get(username);
  if (!state || now - state.updatedAt > ANTIBOT_BEHAVIOR_WINDOW_MS) {
    state = { events: [], updatedAt: now, lastLogAt: 0, turnstileRequiredUntil: 0, turnstileVerifiedUntil: 0 };
    antiBotBehaviorByUsername.set(username, state);
  }
  state.updatedAt = now;
  return state;
}

function recordAntiBotBehavior(ws, acc, now, x, y) {
  const state = getAntiBotBehaviorState(acc.username, now);
  state.events.push({
    at: now,
    x,
    y,
    cursorAt: ws.lastHumanCursorAt,
    cursorMoves: ws.cursorMovesSincePixel || 0,
  });
  if (state.events.length > 100) state.events.shift();
  ws.cursorMovesSincePixel = 0;

  // Турбо-режим даёт одну попытку в секунду и особенно выгоден боту. Для
  // него достаточно короткой серии, но наказание остаётся CAPTCHA, не баном.
  const sampleSize = (acc.cooldownBoostPct || 0) >= 90 && (acc.cooldownBoostUntil || 0) > now
    ? 6 : ANTIBOT_BEHAVIOR_SAMPLE_SIZE;
  const recent = state.events.slice(-sampleSize);
  if (recent.length < sampleSize) return null;
  const intervals = recent.slice(1).map((event, index) => event.at - recent[index].at);
  const meanInterval = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const variance = intervals.reduce((sum, value) => sum + (value - meanInterval) ** 2, 0) / intervals.length;
  const intervalCv = meanInterval > 0 ? Math.sqrt(variance) / meanInterval : Infinity;
  const directCursorCount = recent.filter(event => event.at - event.cursorAt >= 0
    && event.at - event.cursorAt <= 75 && event.cursorMoves <= 1).length;
  const instantTeleportCount = recent.slice(1).filter((event, index) => {
    const previous = recent[index];
    const distance = Math.hypot(event.x - previous.x, event.y - previous.y);
    return distance >= 12 && event.at - event.cursorAt >= 0
      && event.at - event.cursorAt <= 75 && event.cursorMoves <= 1;
  }).length;
  // Это намеренно не опирается на cursor-сообщения: бот может нарисовать
  // себе фальшивую траекторию, но серия реальных пикселей, прыгающих по
  // холсту на десятки клеток почти каждую секунду, остаётся наблюдаемой.
  const rapidTargetJumpCount = recent.slice(1).filter((event, index) => {
    const previous = recent[index];
    const distance = Math.hypot(event.x - previous.x, event.y - previous.y);
    return distance >= 12 && event.at - previous.at <= 1600;
  }).length;
  const steps = recent.slice(1).map((event, index) => `${event.x - recent[index].x},${event.y - recent[index].y}`);
  const uniqueSteps = new Set(steps).size;
  const reasons = [];
  if (intervalCv <= ANTIBOT_BEHAVIOR_INTERVAL_CV_MAX && meanInterval >= 1000) reasons.push('ровный интервал');
  if (directCursorCount >= sampleSize - 1) reasons.push('курсор появляется прямо у цели');
  if (uniqueSteps <= 2) reasons.push('повторяющийся шаг по сетке');
  if (instantTeleportCount >= 3) reasons.push('мгновенные прыжки курсора');
  if (rapidTargetJumpCount >= (sampleSize === 6 ? 5 : 10)) reasons.push('быстрые дальние прыжки целей');
  // Один сигнал не достаточен: люди могут рисовать по сетке и попадать в
  // ритм. Исключение — почти вся короткая серия турбо-установок прыгает по
  // холсту; это лишь вызывает CAPTCHA и запись в журнал, но не наказание.
  const hasStrongPattern = instantTeleportCount >= 3
    || rapidTargetJumpCount >= (sampleSize === 6 ? 5 : 10);
  const hasCombinedPattern = reasons.includes('ровный интервал') && reasons.length >= 2;
  if ((!hasStrongPattern && !hasCombinedPattern) || now - state.lastLogAt < ANTIBOT_LOG_DEDUP_MS) return null;

  state.lastLogAt = now;
  const turnstileRequired = !!TURNSTILE_SECRET_KEY;
  if (turnstileRequired) state.turnstileRequiredUntil = now + ANTIBOT_TURNSTILE_CHALLENGE_MS;
  return {
    reasons,
    intervalCv,
    meanInterval,
    turnstileRequired,
    sample: recent.map(event => ({ at:event.at, x:event.x, y:event.y, cursorAt:event.cursorAt || 0, cursorMoves:event.cursorMoves || 0 })),
  };
}

async function validateTurnstileToken(token, remoteIp) {
  if (!TURNSTILE_SECRET_KEY || typeof token !== 'string' || token.length < 20 || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({
      secret: TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: remoteIp || '',
      idempotency_key: crypto.randomUUID(),
    });
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    const result = await response.json();
    return response.ok && result?.success === true;
  } catch (error) {
    console.warn(`[ANTI-BOT] Turnstile validation error: ${error.message}`);
    return false;
  }
}
// Количество цветов клиента. Значения передаются в одном байте, поэтому
// расширение палитры не меняет формат пиксельных пакетов.
const PALETTE_COLOR_COUNT = 34;
const LEGACY_PALETTE_COLOR_COUNT = 32;

// Старые клиенты знают только первые 32 цвета. При получении индексов 32/33
// они используют белый fallback, из-за чего на готовых артах появлялись
// «дырки». Сохраняем новые оттенки на сервере, но отдаём старым клиентам
// ближайшие известные варианты до тех пор, пока они не обновят Activity.
function colorForClientPalette(client, colorIndex) {
  if ((client?.paletteSize || LEGACY_PALETTE_COLOR_COUNT) >= PALETTE_COLOR_COUNT) return colorIndex;
  if (colorIndex === 32) return 3; // тёмно-серый → чёрный
  if (colorIndex === 33) return 1; // серо-светлый → светло-серый
  return colorIndex;
}

function buildPixelPacketForClient(client, pixels) {
  const buf = new Uint8Array(pixels.length * 5);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    buf[i*5] = (p.x >> 8) & 0xFF; buf[i*5+1] = p.x & 0xFF;
    buf[i*5+2] = (p.y >> 8) & 0xFF; buf[i*5+3] = p.y & 0xFF;
    buf[i*5+4] = colorForClientPalette(client, p.c);
  }
  return buf;
}

// ── ЗВАНИЯ (Этап 4: переход на опыт) ──
// min теперь измеряется в очках ОПЫТА (xp), а не в пикселях. 1 поставленный
// пиксель = 1 xp (начисляется автоматически, см. обработчик 'pixel' ниже).
// Дополнительный xp даёт получение ачивок — но ТОЛЬКО после того как игрок
// заберёт награду за ачивку кнопкой (см. action:'claim_achievement').
// Список должен 1-в-1 совпадать (имена/иконки/пороги) с RANKS в config.js.
const RANK_THRESHOLDS = [
  { name:'Новичок',            icon:'🌱', min:0 },
  { name:'Ученик',             icon:'🖍️', min:50 },
  { name:'Художник',           icon:'🎨', min:150 },
  { name:'Подмастерье',        icon:'🧵', min:350 },
  { name:'Маэстро',            icon:'🖌️', min:700 },
  { name:'Виртуоз',            icon:'🎭', min:1200 },
  { name:'Вдохновлённый',      icon:'💫', min:1600 },
  { name:'Легенда',            icon:'⭐', min:2000 },
  { name:'Чемпион',            icon:'🏆', min:3000 },
  { name:'Мастер Цвета',       icon:'🌈', min:4200 },
  { name:'Хранитель Холста',   icon:'🛡️', min:5800 },
  { name:'Архитектор',         icon:'🏛️', min:7800 },
  { name:'Зодчий',             icon:'🏗️', min:9000 },
  { name:'Творец Миров',       icon:'🌍', min:10200 },
  { name:'Провидец',           icon:'🔮', min:13000 },
  { name:'Император Пикселей', icon:'👁️', min:16200 },
  { name:'Небожитель',         icon:'🌠', min:18500 },
  { name:'Бог Пикселей',       icon:'👑', min:20000 },
];

function getRank(xp) {
  return [...RANK_THRESHOLDS].reverse().find(r => xp >= r.min) || RANK_THRESHOLDS[0];
}

// Награда за достижение звания — больше НЕ выдаётся автоматически.
// Сервер лишь считает награду "доступной к получению", как только
// acc.xp >= порога звания и звания ещё нет в acc.claimed_ranks — реальную
// выдачу делает action:'claim_rank_reward' (игрок жмёт кнопку "Забрать").
// Три типа наград:
//   {type:'coins', amount}      — монеты
//   {type:'banner', tier}       — случайный ещё не полученный баннер из
//                                  каталога PROFILE_BANNERS указанного тира
//                                  ('free'|'gradient'|'animated'), см.
//                                  pickRandomBannerReward() ниже
//   {type:'shop_item', itemId}  — предмет магазина, кладётся в inventory
// Баланс по просьбе заказчика: сначала простые одноцветные баннеры, затем
// градиенты, после половины списка — анимированные + товары магазина.
// Ключи ДОЛЖНЫ совпадать 1-в-1 с RANK_REWARDS в config.js.
const RANK_REWARDS = {
  // ДОЛЖНО совпадать 1-в-1 с RANK_REWARDS в config.js (в т.ч. пустые/
  // непустые массивы) — иначе клиент рисует чекпоинт, которого на сервере
  // нет, и claim_rank_reward отвечает "Награда не найдена".
  'Новичок':            [{ type:'coins',     amount:10 }],
  'Ученик':             [{ type:'coins',     amount:15 }],
  'Художник':           [{ type:'coins',     amount:20 }],
  'Подмастерье':        [{ type:'banner',    tier:'free' }],
  'Маэстро':            [{ type:'coins',     amount:60 }],
  'Виртуоз':            [{ type:'banner',    tier:'free' }],
  'Вдохновлённый':      [{ type:'coins',     amount:50 }, { type:'vip_temp', hours:1 }],
  'Легенда':            [{ type:'banner',    tier:'gradient' }],
  'Чемпион':            [{ type:'coins',     amount:150 }],
  'Мастер Цвета':       [{ type:'banner',    tier:'gradient' }],
  'Хранитель Холста':   [{ type:'shop_item', itemId:'cooldown_boost_25' }],
  'Архитектор':         [{ type:'coins',     amount:500 }],
  'Зодчий':             [{ type:'coins',     amount:400 }, { type:'vip_temp', hours:24 }],
  'Творец Миров':       [{ type:'banner',    tier:'animated' }],
  'Провидец':           [{ type:'shop_item', itemId:'cooldown_boost_50' }],
  'Император Пикселей': [{ type:'banner',    tier:'animated' }],
  'Небожитель':         [{ type:'coins',     amount:1000 }],
  'Бог Пикселей':       [{ type:'coins',     amount:2000 }],
};

// Зеркало getRankCheckpoints() из config.js (сервер не может импортировать
// клиентский файл — держим логику идентичной вручную). Награда открывается
// не сразу по достижению звания, а на xp МЕЖДУ min этого звания и min
// следующего: при N наградах отрезок делится на N+1 равных частей.
// rewardKey — ДОЛЖНО совпадать 1-в-1 с rewardKey() в config.js. Id теперь
// строится из содержимого награды (тип+значение), а не из её позиции в
// массиве — иначе правка состава RANK_REWARDS задним числом переиспользует
// старый claimed_ranks-id для другой награды и она показывается как уже
// полученная, хотя игрок её не забирал (баг с "градиентный баннер сам
// стал получен после клейма VIP").
// После последнего звания игрок продолжает получать награды за опыт.
// Номер цикла хранится отдельно, поэтому каждый порог можно забрать один раз.
const REPEAT_XP_REWARD = { startXp: 20000, stepXp: 1000, coins: 200 };

function rewardKey(reward) {
  if (!reward) return 'none';
  if (reward.type === 'coins')     return `coins_${reward.amount}`;
  if (reward.type === 'banner')    return `banner_${reward.tier}`;
  if (reward.type === 'shop_item') return `item_${reward.itemId}`;
  if (reward.type === 'vip_temp')  return `vip_${reward.hours}`;
  return `x_${JSON.stringify(reward)}`;
}

function getRankCheckpoints(rankName) {
  const rewards = RANK_REWARDS[rankName];
  if (!rewards || !rewards.length) return [];
  const idx = RANK_THRESHOLDS.findIndex(r => r.name === rankName);
  if (idx === -1) return [];
  const rank = RANK_THRESHOLDS[idx];
  const next = RANK_THRESHOLDS[idx + 1];
  const span = next ? (next.min - rank.min) : 0;
  const count = rewards.length;
  return rewards.map((reward, i) => ({
    id: `${rankName}#${rewardKey(reward)}`,
    reward,
    index: i,
    count,
    xpRequired: next ? Math.round(rank.min + span * (i + 1) / (count + 1)) : rank.min,
  }));
}

// Зеркало RANK_COIN_BONUS из config.js — "монетная плашка" под карточкой
// КАЖДОГО звания. Раньше была чистым UI-плейсхолдером без реальной выдачи;
// теперь тоже требует ручного "Забрать" (см. coinChipHtml в ui.js), поэтому
// нужен собственный чекпоинт с id "RankName#self" и порогом = min самого
// звания (это награда САМОГО звания, а не "между" ним и следующим).
const RANK_COIN_BONUS = Object.fromEntries(
  RANK_THRESHOLDS.map(r => [r.name, Math.max(5, Math.round(r.min / 10))])
);

function getRankSelfCheckpoint(rankName) {
  const rankDef = RANK_THRESHOLDS.find(r => r.name === rankName);
  if (!rankDef) return null;
  const amount = RANK_COIN_BONUS[rankName];
  if (!amount) return null;
  return {
    id: `${rankName}#self`,
    reward: { type: 'coins', amount },
    index: 'self',
    xpRequired: rankDef.min,
  };
}

// ── АЧИВКИ (server-side источник правды) ──────────────────
// Зеркало ACHIEVEMENTS из config.js + награда опытом (xp). Живёт отдельно от
// клиента, т.к. server.js — чистый Node без доступа к window/config.js.
// stats считается из уже существующих полей аккаунта — новых полей в БД
// требуется всего два: xp (number) и unlocked_achievements (string[]).
const ACHIEVEMENTS_DEF = [
  // ── Опыт/пиксели ──
  { id:'first_pixel',    title:'Первый мазок',         icon:'🖌️', xp:10,   check: s => s.xp >= 1 },
  { id:'pixels_50',      title:'Начинающий',           icon:'🌱', xp:20,   check: s => s.xp >= 50 },
  { id:'pixels_200',     title:'Художник',             icon:'🎨', xp:40,   check: s => s.xp >= 200 },
  { id:'pixels_1000',    title:'Легенда',              icon:'⭐', xp:80,   check: s => s.xp >= 1000 },
  { id:'pixels_3000',    title:'Виртуоз',               icon:'🌈', xp:130,  check: s => s.xp >= 3000 },
  { id:'pixels_5000',    title:'Архитектор',           icon:'🏛️', xp:180,  check: s => s.xp >= 5000 },
  { id:'pixels_10000',   title:'Мастер оттенков',      icon:'🌀', xp:260,  check: s => s.xp >= 10000 },
  { id:'pixels_20000',   title:'Бог Пикселей',         icon:'👑', xp:380,  check: s => s.xp >= 20000 },
  { id:'pixels_50000',   title:'Пиксельный титан',     icon:'🔥', xp:600,  check: s => s.xp >= 50000 },
  { id:'pixels_100000',  title:'Повелитель холста',    icon:'🌌', xp:1000, check: s => s.xp >= 100000 },
  { id:'pixels_250000',  title:'Чисто залутал ауры',    icon:'🐉', xp:2000, check: s => s.xp >= 250000 },
  // ── Монеты ──
  { id:'coins_100',      title:'Первая заначка',       icon:'👛', xp:15,   check: s => s.coins >= 100 },
  { id:'coins_500',      title:'Коллекционер',         icon:'🪙', xp:30,   check: s => s.coins >= 500 },
  { id:'coins_1000',     title:'Богач',                icon:'💵', xp:55,   check: s => s.coins >= 1000 },
  { id:'coins_2500',     title:'Инвестор',              icon:'💴', xp:90,   check: s => s.coins >= 2500 },
  { id:'coins_5000',     title:'Магнат',               icon:'💰', xp:130,  check: s => s.coins >= 5000 },
  { id:'coins_10000',    title:'Олигарх',               icon:'🏦', xp:200,  check: s => s.coins >= 10000 },
  { id:'coins_25000',    title:'Хранитель семени',      icon:'💎', xp:350,  check: s => s.coins >= 25000 },
  { id:'coins_50000',    title:'Владелец Ямианиме',     icon:'🏆', xp:600,  check: s => s.coins >= 50000 },
  { id:'coins_100000',   title:'ЮЕЧКА ЗАМЕТЬ МЕНЯЯЯ',   icon:'🤑', xp:1100, check: s => s.coins >= 100000 },
  // ── Покупки ──
  { id:'first_purchase', title:'Первая покупка',       icon:'🛒', xp:15,   check: s => s.purchasedCount > 0 },
  { id:'purchase_5',     title:'Постоянный клиент',    icon:'🛍️', xp:25,   check: s => s.purchasedCount >= 5 },
  { id:'purchase_10',    title:'Завсегдатай магазина',  icon:'🧺', xp:45,   check: s => s.purchasedCount >= 10 },
  { id:'purchase_20',    title:'Шопоголик',            icon:'🧾', xp:75,   check: s => s.purchasedCount >= 20 },
  { id:'purchase_50',    title:'Скупщик товаров',      icon:'📦', xp:150,  check: s => s.purchasedCount >= 50 },
  { id:'purchase_100',   title:'Данил Колбасенко',      icon:'🏪', xp:280,  check: s => s.purchasedCount >= 100 },
  // ── Друзья ──
  { id:'friend_1',       title:'Больше не изгой :(',   icon:'🤝', xp:15,   check: s => s.friendsCount >= 1 },
  { id:'friend_5',       title:'Душа компании',        icon:'🎉', xp:35,   check: s => s.friendsCount >= 5 },
  { id:'friend_10',      title:'Душа общества',        icon:'🎊', xp:60,   check: s => s.friendsCount >= 10 },
  { id:'friend_25',      title:'Центр тусовки',         icon:'🥳', xp:120,  check: s => s.friendsCount >= 25 },
  { id:'friend_50',      title:'Легенда социума',       icon:'🌐', xp:220,  check: s => s.friendsCount >= 50 },
  { id:'friend_100',     title:'Гений, Кукловод, Манипулятор Аянакоджи', icon:'🫂', xp:400,  check: s => s.friendsCount >= 100 },
  // ── Баннеры ──
  { id:'banners_3',      title:'Коллекционер баннеров', icon:'🖼️', xp:40,   check: s => s.ownedBannersCount >= 3 },
  { id:'banners_6',      title:'Ценитель стиля',        icon:'🎏', xp:70,   check: s => s.ownedBannersCount >= 6 },
  { id:'banners_10',     title:'Модный игрок',          icon:'🏳️', xp:120,  check: s => s.ownedBannersCount >= 10 },
  { id:'banners_15',     title:'Создатель стиля',       icon:'🪧', xp:200,  check: s => s.ownedBannersCount >= 15 },
  { id:'banners_20',     title:'Нефор',                 icon:'🏵️', xp:320,  check: s => s.ownedBannersCount >= 20 },
  // Счётчик хранится на соединении, чтобы достижение нельзя было получить
  // простой подменой клиентского значения sessionPixels.
  { id:'session_100',    title:'Дикий огурец',           icon:'🕐', xp:25,   check: s => s.sessionPixels >= 100 },
  // ── Клан / статус ──
  { id:'clan_member',    title:'Возьми телефон, Детка', icon:'🚩', xp:20,   check: s => !!s.clan },
  { id:'vip',            title:'Особый статус',        icon:'✨', xp:50,   check: s => s.isVip || s.isAdmin },
  // ── Комбо-ачивки (несколько условий сразу, самые сложные — в самом конце) ──
  { id:'combo_starter',        title:'Крепкий старт',           icon:'🚀', xp:30,   check: s => s.xp >= 50 && s.coins >= 100 },
  { id:'combo_social_clan',    title:'Душа клана',              icon:'🏰', xp:90,   check: s => !!s.clan && s.friendsCount >= 5 },
  { id:'combo_shopaholic',     title:'Транжира',                icon:'💸', xp:200,  check: s => s.purchasedCount >= 20 && s.coins >= 5000 },
  { id:'combo_collector_deluxe', title:'Коллекционер де люкс',  icon:'🎭', xp:220,  check: s => s.ownedBannersCount >= 10 && s.purchasedCount >= 20 },
  { id:'combo_ultimate',       title:'Идеальный игрок',         icon:'🌠', xp:1500, check: s => s.xp >= 100000 && s.coins >= 50000 && s.friendsCount >= 25 && s.ownedBannersCount >= 15 && !!s.clan && (s.isVip || s.isAdmin) },
  { id:'combo_grandmaster',    title:'Ты на улицу выходишь вообще?', icon:'🏅', xp:2500, check: s => s.xp >= 250000 && s.coins >= 100000 && s.purchasedCount >= 100 },
];
function buildAchievementStats(acc, { sessionPixels = 0 } = {}) {
  const purchasedCount = (acc.upgrades || []).length +
    Object.values(acc.inventory || {}).reduce((a, b) => a + b, 0);
  return {
    pixels: acc.pixels || 0,
    xp: acc.xp || 0,
    coins: acc.coins || 0,
    clan: acc.clan || '',
    purchasedCount,
    friendsCount: (acc.friends || []).length,
    ownedBannersCount: (acc.owned_banners || []).length,
    sessionPixels,
    isVip: acc.role === 'vip' || hasActiveTempVip(acc),
    isAdmin: acc.role === 'admin',
  };
}

// ── ВРЕМЕННЫЙ VIP (награда за промежуточные звания) ──────────
// vip_temp_until — таймстамп (мс), до которого действует временный VIP,
// выданный наградой за звание. vip_temp_prev_role — роль, которая была
// у игрока ДО выдачи временного VIP (чтобы корректно вернуть её обратно,
// а не затирать реального 'admin'/постоянного 'vip' после истечения).
// Реальный постоянный VIP (acc.role === 'vip', выданный вручную/за деньги)
// не трогаем и не понижаем.
function hasActiveTempVip(acc) {
  return !!(acc.vip_temp_until && acc.vip_temp_until > Date.now());
}

// Выдаёт (или продлевает) временный VIP-статус на hours часов.
// Если уже активен временный VIP — продлевает от текущего истечения,
// а не от текущего момента (иначе повторные награды перекрывали бы друг
// друга вместо накопления).
function grantTempVip(acc, hours) {
  const now = Date.now();
  const durationMs = hours * 60 * 60 * 1000;
  if (!hasActiveTempVip(acc)) {
    // Не понижаем реальный постоянный VIP/admin — просто не выдаём поверх
    // него отдельный таймер понижения, но сам факт "особого статуса"
    // всё равно есть, так что ачивка 'vip' и подобные будут засчитаны.
    acc.vip_temp_prev_role = acc.role || 'user';
    acc.vip_temp_until = now + durationMs;
    if (acc.role !== 'admin' && acc.role !== 'vip') acc.role = 'vip';
  } else {
    acc.vip_temp_until += durationMs;
  }
}

// Проверяет и снимает истёкший временный VIP у аккаунта. Вызывается при
// логине и периодически (см. setInterval ниже, рядом с определением wss).
async function revertExpiredTempVip(username, acc) {
  if (!acc || !acc.vip_temp_until) return false;
  if (acc.vip_temp_until > Date.now()) return false;
  const prevRole = acc.vip_temp_prev_role || 'user';
  acc.vip_temp_until = 0;
  acc.vip_temp_prev_role = '';
  // Если роль всё ещё 'vip' (т.е. никто не понизил/не повысил её вручную
  // за это время) — возвращаем то, что было до выдачи временного статуса.
  if (acc.role === 'vip') acc.role = prevRole;
  try {
    await dbSaveAccount(username, { vip_temp_until: 0, vip_temp_prev_role: '', role: acc.role });
  } catch (_) {}
  return true;
}
// checkAchievements(username, acc, opts) сама функция определена ниже,
// внутри области видимости WebSocket-сервера (см. рядом с sendToUser) —
// ей нужен доступ к wss.clients, чтобы отправить уведомление игроку.

// ── SHOP CATALOGUE ─────────────────────────────────────────
const SHOP_ITEMS = [
  // USER
  { id: 'stencil_auto_1', title:'Авто-подбор цветов Ур.1', cost:70,  role:'user', type:'upgrade' },
  { id: 'stencil_auto_2', title:'Авто-подбор цветов Ур.2', cost:150, role:'user', type:'upgrade' },
  // Общие расходники (доступны всем, не требуют VIP)
  { id: 'bomb_3x3',       title:'Цветная бомбочка 3×3',    cost:10,  role:'user', type:'consumable' },
  { id: 'cooldown_boost_25', title:'Ускоритель −25%',    cost:10,  role:'user', type:'cooldown_boost', pct:25, durationMin:15 },
  { id: 'cooldown_boost_50', title:'Ускоритель −50%',    cost:25,  role:'user', type:'cooldown_boost', pct:50, durationMin:15 },
  // VIP
  { id: 'rainbow_5x5',    title:'Радужный взрыв 5×5',      cost:12,  role:'vip',  type:'consumable' },
  { id: 'eraser_10x10',   title:'Большой Ластик 10×10',    cost:20,  role:'vip',  type:'consumable' },
  { id: 'mirror_stamp',   title:'Зеркальный штамп',        cost:35,  role:'vip',  type:'consumable' },
  // Кулдаун-ускоритель турбо остаётся VIP-эксклюзивом
  { id: 'cooldown_boost_90', title:'Турбо-режим −90%',   cost:300, role:'vip', type:'cooldown_boost', pct:90, durationMin:30 },
];

const COOLDOWN_BOOST_IDS = { cooldown_boost_25:{pct:25,durationMin:15}, cooldown_boost_50:{pct:50,durationMin:15}, cooldown_boost_90:{pct:90,durationMin:30} };

// ── DB TIMEOUT HELPER ──────────────────────────────────────
const dbTimeout = (promise, ms = 4000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(
    () => reject(new Error('Таймаут MongoDB')), ms
  )),
]);

// ── MONGOOSE SCHEMAS ───────────────────────────────────────
let AccountModel = null, ClanModel = null, TemplateModel = null, SettingsModel = null, NewsModel = null, DMModel = null, AntiBotLogModel = null;

if (mongoose) {
  mongoose.set('bufferCommands', false);
  mongoose.set('autoIndex', false);

  const AccountSchema = new mongoose.Schema({
    username:          { type: String, unique: true, index: true },
    password:          String,
    discord_id:        { type: String, default: '', index: true }, // ← Discord Activity
    discord_avatar:    { type: String, default: '' }, // ← hash аватарки Discord (avatar hash из /users/@me)
    email:             String,
    role:              { type: String, default: 'user' }, 
    pixels:            { type: Number, default: 0 },
    rank:              { type: String, default: 'Новичок' },
    emoji:             { type: String, default: '👾' },
    banned:            { type: Boolean, default: false },
    timeout_until:     { type: Number, default: 0 },
    coins:             { type: Number, default: 0 },
    clan:              { type: String, default: '' },
    inventory:         { type: Object, default: {} },
    upgrades:          { type: [String], default: [] },
    // Активный ускоритель кулдауна. Храним отдельно от инвентаря, чтобы
    // эффект не пропадал при переподключении или перезапуске сервера.
    cooldownBoostPct:   { type: Number, default: 0 },
    cooldownBoostUntil: { type: Number, default: 0 },
    active_stencil:    { type: Object, default: null }, // Текущий трафарет
    saved_stencils:    { type: Array, default: [] },    // Сохраненные пресеты трафаретов

    // ── СОЦИАЛЬНАЯ СЕТЬ: ДРУЗЬЯ И ЛС ──
    friends:             { type: [String], default: [] }, // список username друзей
    friend_requests_in:  { type: [String], default: [] }, // входящие заявки в друзья (кто добавил меня)
    friend_requests_out: { type: [String], default: [] }, // исходящие заявки в друзья (кого добавил я)
    dm_reads:            { type: Object,   default: {} }, // { peerUsername: timestamp последнего прочтения переписки }

    // ── БАННЕР ПРОФИЛЯ (Этап 2) ──
    // banner_id хранит только id из каталога PROFILE_BANNERS (см. ниже) —
    // ни картинка, ни градиент в БД не лежат, только ссылка на пресет.
    // Бесплатные баннеры (tier:'free') равнодоступны всем и не требуют
    // владения; gradient/animated нужно один раз купить — id оседает в
    // owned_banners навсегда.
    banner_id:           { type: String,   default: null },
    owned_banners:       { type: [String], default: [] },

    // ── ОПЫТ / ЗВАНИЯ / АЧИВКИ (Этап 4) ──
    // xp — суммарный опыт (1 пиксель = 1xp автоматически + xp ачивок ПОСЛЕ
    // того как игрок их забрал). unlocked_achievements — id ачивок, условие
    // которых уже выполнено (используется для отображения статуса и
    // возможности забрать). claimed_ranks/claimed_achievements — что из
    // доступных наград уже реально забрано (защита от повторного получения).
    xp:                    { type: Number,   default: 0 },
    unlocked_achievements: { type: [String], default: [] },
    claimed_ranks:         { type: [String], default: [] },
    claimed_xp_cycles:     { type: [Number], default: [] },
    claimed_achievements:  { type: [String], default: [] },

    // ── ВРЕМЕННЫЙ VIP (промежуточные звания-награды) ──
    // См. grantTempVip/revertExpiredTempVip выше.
    vip_temp_until:      { type: Number, default: 0 },
    vip_temp_prev_role:  { type: String, default: '' },
  }, { timestamps: true, autoIndex: false });

  const ClanSchema = new mongoose.Schema({
    name:           { type: String, unique: true, index: true },
    tag:            String,
    description:    String,
    message_of_day: { type: String, default: '' },
    leader:         String,
    members:        [String],
    join_requests:  { type: [String], default: [] },
    pixels:         { type: Number, default: 0 },
    active_stencil: { type: Object, default: null },
    // Единственный трафарет, которым клан делится прямо сейчас.
    // Формат: { owner: '<username>', emoji: '<emoji>', stencil: {...} } или null.
    shared_stencil: { type: Object, default: null },
    // До трёх одновременных трафаретов. shared_stencil оставлен для миграции
    // старых кланов и совместимости с уже сохранёнными документами.
    shared_stencils: { type: Array, default: [] },

    // Новые настройки клана
    icon:           { type: String, default: '🏴' },
    tag_color:      { type: String, default: '#818cf8' },
    join_type:      { type: String, default: 'open' }, // 'open', 'request', 'closed'
    min_pixels:     { type: Number, default: 0 },
    is_public:      { type: Boolean, default: true },
    share_cursor:   { type: Boolean, default: false },
    social_link:    { type: String, default: '' },
    banner_url:     { type: String, default: null },
    banner_crop_x:  { type: Number, default: 0 },
    banner_crop_y:  { type: Number, default: 0 },
    banner_crop_w:  { type: Number, default: 1 },
    banner_crop_h:  { type: Number, default: 1 },

    // ── СИСТЕМА ЗВАНИЙ / ПРАВ ──
    // ranks: массив кастомных званий клана (включая два системных: leader, member).
    // member_roles: { username: rankId } — звание каждого участника (кроме лидера,
    // у него всегда системное звание 'leader', вычисляется по clan.leader).
    ranks:          { type: Array,  default: null },
    member_roles:   { type: Object, default: {} },

    // ── КАЗНА И МАГАЗИН КЛАНА ──
    treasury:       { type: Number, default: 0 },
    treasury_log:   { type: Array,  default: [] }, // [{username, amount, text, time}]
    shop_items:     { type: [String], default: [] }, // купленные id из CLAN_SHOP_ITEMS/CLAN_MEMBER_LIMIT_TIERS
    member_limit:   { type: Number, default: 5 },
  }, { timestamps: true, autoIndex: false });

  const TemplateSchema = new mongoose.Schema({
    name:           String,
    cloudinary_url: String,
    cloudinary_id:  String,
    uploader:       String,
    width:          Number,
    height:         Number,
  }, { timestamps: true, autoIndex: false });

  const SettingsSchema = new mongoose.Schema({
    key:   { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed,
  }, { timestamps: true, autoIndex: false });

  // Новости: слайдшоу + лента в панели "Новости".
  const NewsSchema = new mongoose.Schema({
    id:         { type: String, unique: true, index: true }, // собственный короткий id (не _id)
    title:      { type: String, default: '' },   // заголовок
    tag:        { type: String, default: '' },   // бейджик (news-slide-tag)
    art:        { type: String, default: '📰' }, // эмодзи-иконка слайда
    desc:       { type: String, default: '' },   // короткое описание для слайда/списка
    text:       { type: String, default: '' },   // полный текст для детального просмотра
    date:       { type: String, default: '' },   // отображаемая дата (строка)
    bgImage:    { type: String, default: null },  // фон слайда (Cloudinary URL), из Figma
    bgCropX:    { type: Number, default: 0 },     // крой картинки: X, доля 0..1
    bgCropY:    { type: Number, default: 0 },     // крой картинки: Y, доля 0..1
    bgCropW:    { type: Number, default: 1 },     // крой картинки: ширина, доля 0..1
    bgCropH:    { type: Number, default: 1 },     // крой картинки: высота, доля 0..1
    eventTimer: { type: Number, default: null },  // таймстамп (мс) целевого события, или null
    showArt:    { type: Boolean, default: true },  // показывать news-slide-art
    showTag:    { type: Boolean, default: true },  // показывать news-slide-tag
    showText:   { type: Boolean, default: true },  // показывать title+desc на слайде
    order:      { type: Number, default: 0 },
  }, { timestamps: true, autoIndex: false });

  // Личные сообщения (ЛС). Один документ = одна пара собеседников.
  // pairKey — отсортированные username через '__', чтобы у пары всегда был один документ.
  const DMSchema = new mongoose.Schema({
    pairKey:  { type: String, unique: true, index: true },
    messages: { type: Array, default: [] }, // [{ from, text, ts }]
  }, { timestamps: true, autoIndex: false });

  // Журнал не является наказанием: он хранит только уже сработавшие
  // высокорисковые серии для ручного разбора администратором.
  const AntiBotLogSchema = new mongoose.Schema({
    username:         { type: String, required: true, index: true },
    reasons:          { type: [String], default: [] },
    metrics:          { type: Object, default: {} },
    sample:           { type: Array, default: [] },
    captcha_required: { type: Boolean, default: false },
    reviewed:         { type: Boolean, default: false },
  }, { timestamps: true, autoIndex: false });

  AccountModel  = mongoose.model('Account',  AccountSchema);
  ClanModel     = mongoose.model('Clan',      ClanSchema);
  TemplateModel = mongoose.model('Template',  TemplateSchema);
  SettingsModel = mongoose.model('Setting',   SettingsSchema);
  NewsModel     = mongoose.model('News',      NewsSchema);
  DMModel       = mongoose.model('DirectMessage', DMSchema);
  AntiBotLogModel = mongoose.model('AntiBotLog', AntiBotLogSchema);
}

// ── REDIS ──────────────────────────────────────────────────
let redis = null;
if (Redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  console.log('✅ Upstash Redis подключён');
}
// Цвета и авторы должны переключаться как один снимок. Указатель меняется
// только после полной записи обеих частей, поэтому рестарт не склеит их из
// разных моментов времени.
const BOARD_SNAPSHOT_POINTER_KEY = 'pixel_board_snapshot_current_v2';
const BOARD_SNAPSHOT_HISTORY_KEY = 'pixel_board_snapshot_history_v2';
let boardSnapshotSequence = 0;
function boardSnapshotKeys(id) {
  const base = `pixel_board_snapshot_v2:${id}`;
  return { canvas: `${base}:canvas`, owners: `${base}:owners`, ids: `${base}:owner_ids` };
}

// ── DB HELPERS ─────────────────────────────────────────────
async function dbGetAccount(username) {
  // БАГ (жалоба "не забирается награда за ачивку"): раньше эта функция
  // ВСЕГДА перезатирала accounts[username] свежим документом из MongoDB,
  // даже если уже был живой in-memory аккаунт. accounts — источник
  // правды в рантайме (checkAchievements/claim_achievement мутируют
  // именно его), а запись в MongoDB асинхронная и не await'ится в
  // горячих путях (например при постановке пикселя). Из-за этого
  // возникала гонка: сервер помечал ачивку разблокированной в памяти и
  // слал achievement_unlocked (кнопка "Забрать" появлялась), но ДО того
  // как findOneAndUpdate успевал завершиться игрок жал "Забрать" →
  // dbGetAccount дёргал Mongo, получал ЕЩЁ СТАРЫЙ документ без этой
  // ачивки и перезаписывал им свежие in-memory данные — сервер отвечал
  // "Ачивка ещё не выполнена", и кнопка переставала работать навсегда.
  // Исправление: если аккаунт уже загружен в память — он и есть
  // авторитетный источник, в БД за ним лезть не нужно. В Mongo идём
  // только при первом обращении (например сразу после рестарта
  // сервера), когда в памяти аккаунта ещё нет.
  if (accounts[username]) return accounts[username];
  if (AccountModel) {
    try {
      const doc = await dbTimeout(AccountModel.findOne({ username }).lean().exec());
      if (doc) accounts[username] = { ...accounts[username], ...doc };
    } catch(e) { console.error(`❌ dbGetAccount(${username}):`, e.message); }
  }
  return accounts[username] || null;
}

async function dbGetAccountByDiscordId(discordId) {
  if (!discordId) return null;
  try {
    if (AccountModel) {
      const doc = await dbTimeout(AccountModel.findOne({ discord_id: discordId }).lean().exec());
      if (doc) { accounts[doc.username] = { ...accounts[doc.username], ...doc }; return accounts[doc.username]; }
    }
    // Fallback: in-memory поиск
    return Object.values(accounts).find(a => a.discord_id === discordId) || null;
  } catch(e) {
    console.error('❌ dbGetAccountByDiscordId:', e.message);
    return null;
  }
}

// Полная карточка игрока для панели управления в новой админке (ui.js:
// openAdminUserProfile). Собирает всё, что можно редактировать или полезно
// увидеть в одном месте, без отдельных запросов по каждому полю.
// ВАЖНО: эта функция объявлена в модульной области видимости, а `wss`
// создаётся как const внутри отдельной функции запуска сервера — обращение
// к wss здесь привело бы к ReferenceError и "тихому" падению обработчика
// (клиент до бесконечности видел "Загрузка..."). Поэтому статус "онлайн"
// передаётся снаружи, из места вызова, где wss уже доступна.
async function buildAdminUserDetail(username, online = false) {
  const acc = await dbGetAccount(username);
  if (!acc) return null;
  return {
    username:      acc.username,
    role:          acc.role || 'user',
    banned:        acc.banned || false,
    timeout_until: acc.timeout_until || 0,
    pixels:        acc.pixels || 0,
    coins:         acc.coins || 0,
    clan:          acc.clan || '',
    emoji:         acc.emoji || '👾',
    avatar:        getAvatarUrl(acc),
    rank:          acc.rank || getRank(acc.pixels || 0).name,
    banner:        acc.banner_id || null,
    owned_banners: acc.owned_banners || [],
    inventory:     acc.inventory || {},
    created_at:    acc.created_at || null,
    online,
  };
}

async function dbSaveAccount(username, data) {
  accounts[username] = { ...accounts[username], ...data };
  if (AccountModel) {
    try {
      await dbTimeout(AccountModel.findOneAndUpdate({ username }, data, { upsert: true, new: true }).exec());
    } catch(e) { console.error(`❌ dbSaveAccount(${username}):`, e.message); }
  } else {
    saveLocalAccounts();
  }
}

async function dbGetAllAccounts() {
  if (AccountModel) {
    try { return await dbTimeout(AccountModel.find({}).lean().exec()); }
    catch(e) { console.error('❌ dbGetAllAccounts:', e.message); return []; }
  }
  return Object.entries(accounts).map(([username, v]) => ({ username, ...v }));
}

// ── ANTI-BOT REVIEW LOG ─────────────────────────────────────
// В локальном режиме журнал остаётся доступен до перезапуска. В production
// (MongoDB) он сохраняется отдельно от аккаунтов и холста.
const ANTI_BOT_REVIEW_LOG_FILE = path.join(__dirname, 'anti_bot_review_log.json');
let antiBotReviewLog = [];
function saveLocalAntiBotReviewLog() {
  try { fs.writeFileSync(ANTI_BOT_REVIEW_LOG_FILE, JSON.stringify(antiBotReviewLog, null, 2)); }
  catch (error) { console.error('[ANTI-BOT] local review log save:', error.message); }
}
async function dbCreateAntiBotLog(entry) {
  const safeEntry = {
    username: String(entry.username || '').slice(0, 48),
    reasons: Array.isArray(entry.reasons) ? entry.reasons.slice(0, 8) : [],
    metrics: entry.metrics && typeof entry.metrics === 'object' ? entry.metrics : {},
    sample: Array.isArray(entry.sample) ? entry.sample.slice(-16) : [],
    captcha_required: !!entry.captcha_required,
    reviewed: false,
  };
  if (AntiBotLogModel) {
    try { await dbTimeout(AntiBotLogModel.create(safeEntry)); }
    catch (error) { console.error('[ANTI-BOT] review log save:', error.message); }
    return;
  }
  antiBotReviewLog.unshift({ ...safeEntry, _id: crypto.randomUUID(), createdAt: new Date() });
  if (antiBotReviewLog.length > 500) antiBotReviewLog.length = 500;
  saveLocalAntiBotReviewLog();
}

async function dbGetAntiBotLogs(limit = 100) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  if (AntiBotLogModel) {
    try { return await dbTimeout(AntiBotLogModel.find({}).sort({ createdAt: -1 }).limit(safeLimit).lean().exec()); }
    catch (error) { console.error('[ANTI-BOT] review log read:', error.message); return []; }
  }
  return antiBotReviewLog.slice(0, safeLimit);
}

async function dbMarkAntiBotLogReviewed(id) {
  if (!id) return;
  if (AntiBotLogModel) {
    try { await dbTimeout(AntiBotLogModel.findByIdAndUpdate(id, { reviewed: true }).exec()); }
    catch (error) { console.error('[ANTI-BOT] review log update:', error.message); }
    return;
  }
  const entry = antiBotReviewLog.find(item => item._id === id);
  if (entry) { entry.reviewed = true; saveLocalAntiBotReviewLog(); }
}

// ── МАГАЗИН КЛАНА ──
// Ключи id ниже должны 1-в-1 совпадать с CLAN_SHOP_ITEMS / CLAN_MEMBER_LIMIT_TIERS
// на клиенте (config.js), т.к. они хранятся в clan.shop_items[].
const CLAN_BASE_MEMBER_LIMIT = 5;

const CLAN_MEMBER_LIMIT_TIERS = [
  { id:'members_10',  limit:10,  cost:30   },
  { id:'members_25',  limit:25,  cost:90   },
  { id:'members_50',  limit:50,  cost:300  },
  { id:'members_100', limit:100, cost:1500 },
];

const CLAN_SHOP_ITEMS = [
  { id:'banner_static',   cost:60,  requires:null },
  { id:'banner_animated', cost:150, requires:'banner_static' },
  { id:'clan_stencil_slot_2', cost:100, requires:null },
  { id:'clan_stencil_slot_3', cost:250, requires:'clan_stencil_slot_2' },
];

const CLAN_ANIMATED_BANNER_EXT = ['.gif', '.webp', '.apng'];
function isAnimatedBannerUrl(url) {
  if (!url) return false;
  const clean = url.split('?')[0].toLowerCase();
  return CLAN_ANIMATED_BANNER_EXT.some(ext => clean.endsWith(ext));
}

function clanCurrentMemberLimit(clan) {
  return (clan && clan.member_limit) || CLAN_BASE_MEMBER_LIMIT;
}

// ── СИСТЕМА ЗВАНИЙ / ПРАВ КЛАНА ──
// Права, которые можно выдать званию. Ключи должны совпадать с CLAN_PERMISSIONS на клиенте.
const CLAN_PERMISSION_KEYS = ['invite', 'kick', 'manage_ranks', 'manage_settings', 'manage_stencil', 'edit_motd', 'manage_treasury'];

function emptyClanPermissions() {
  const p = {}; for (const k of CLAN_PERMISSION_KEYS) p[k] = false; return p;
}

function defaultClanRanks() {
  return [
    {
      id: 'leader', name: 'Лидер', icon: '👑', color: '#fbbf24', priority: 100,
      isLeader: true, isDefault: true,
      permissions: { invite: true, kick: true, manage_ranks: true, manage_settings: true, manage_stencil: true, edit_motd: true, manage_treasury: true },
    },
    {
      id: 'member', name: 'Участник', icon: '⚔️', color: '#818cf8', priority: 0,
      isDefault: true,
      permissions: emptyClanPermissions(),
    },
  ];
}

// Гарантирует, что у клана есть корректный массив ranks и объект member_roles.
// Вызывается на каждое чтение клана из БД, чтобы старые кланы (созданные до
// введения системы званий) автоматически получили дефолтные звания.
function ensureClanRanks(clan) {
  if (!clan) return clan;
  if (!Array.isArray(clan.ranks) || !clan.ranks.some(r => r.id === 'leader') || !clan.ranks.some(r => r.id === 'member')) {
    clan.ranks = defaultClanRanks();
  }
  if (!clan.member_roles || typeof clan.member_roles !== 'object') clan.member_roles = {};
  return clan;
}

function clanFindRank(clan, rankId) {
  ensureClanRanks(clan);
  return clan.ranks.find(r => r.id === rankId) || clan.ranks.find(r => r.id === 'member');
}

// Звание конкретного участника (лидер всегда 'leader', вычисляется по clan.leader).
function clanRankOf(clan, username) {
  ensureClanRanks(clan);
  if (clan.leader === username) return clan.ranks.find(r => r.id === 'leader') || defaultClanRanks()[0];
  const rid = clan.member_roles[username] || 'member';
  return clan.ranks.find(r => r.id === rid) || clan.ranks.find(r => r.id === 'member');
}

// Проверка конкретного права участника. Лидер обладает всеми правами всегда.
function clanHasPerm(clan, username, perm) {
  if (!clan) return false;
  if (clan.leader === username) return true;
  const rank = clanRankOf(clan, username);
  return !!(rank && rank.permissions && rank.permissions[perm]);
}

function clanPriorityOf(clan, username) {
  const rank = clanRankOf(clan, username);
  return rank ? (rank.priority || 0) : 0;
}

function clanStencilSlots(clan) {
  if (!clan) return 1;
  const owned = clan.shop_items || [];
  if (owned.includes('clan_stencil_slot_3')) return 3;
  if (owned.includes('clan_stencil_slot_2')) return 2;
  return 1;
}

function normalizeClanStencils(clan) {
  if (!clan) return [];
  const list = Array.isArray(clan.shared_stencils) ? clan.shared_stencils.filter(Boolean) : [];
  if (!list.length && clan.shared_stencil) list.push(clan.shared_stencil);
  clan.shared_stencils = list.slice(0, clanStencilSlots(clan));
  // legacy field keeps the first slot available to clients during rollout.
  clan.shared_stencil = clan.shared_stencils[0] || null;
  return clan.shared_stencils;
}

async function dbGetClan(name) {
  if (ClanModel) {
    try {
      const doc = await dbTimeout(ClanModel.findOne({ name }).lean().exec());
      if (doc) clans[name] = { ...clans[name], ...doc };
    } catch(e) { console.error(`❌ dbGetClan(${name}):`, e.message); }
  }
  const clan = ensureClanRanks(clans[name] || null);
  if (clan) {
    normalizeClanStencils(clan);
    // Карточки участников (аватар/эмодзи/ранг/баннер) — раньше клиент брал
    // это только из cpUserCache (заполняется чатом/онлайн-списком), поэтому
    // офлайн-участник или тот, кто ни разу не писал в чат, показывался с
    // заглушкой вместо реальной аватарки (см. REWORK_PLAN, Этап 1, "НЕ
    // тронуто"). Теперь это отдаётся прямо с сервером вместе с клан-данными —
    // единая точка правды, не завязанная на то, что клиент "видел" юзера.
    const cards = {};
    await Promise.all((clan.members || []).map(async (u) => {
      const acc = await dbGetAccount(u);
      if (acc) cards[u] = { emoji: acc.emoji || '👾', avatar: getAvatarUrl(acc), rank: acc.rank || 'Новичок', banner: acc.banner_id || null };
    }));
    clan.member_cards = cards;
  }
  return clan;
}

async function dbSaveClan(name, data) {
  clans[name] = { ...clans[name], ...data };
  if (ClanModel) {
    try {
      await dbTimeout(ClanModel.findOneAndUpdate({ name }, data, { upsert: true, new: true }).exec());
    } catch(e) { console.error(`❌ dbSaveClan(${name}):`, e.message); }
  }
}

async function dbGetAllClans() {
  if (ClanModel) {
    try { return await dbTimeout(ClanModel.find({}).lean().exec()); }
    catch(e) { console.error('❌ dbGetAllClans:', e.message); return []; }
  }
  return Object.values(clans);
}

async function dbDeleteClan(name) {
  if (ClanModel) {
    try { await dbTimeout(ClanModel.deleteOne({ name }).exec()); } catch(e) {}
  }
  delete clans[name];
}

async function dbGetTemplates() {
  if (TemplateModel) {
    try { return await dbTimeout(TemplateModel.find({}).lean().exec()); } catch(e) { return []; }
  }
  return templates;
}

async function dbSaveTemplate(data) {
  if (TemplateModel) {
    try { return await dbTimeout(new TemplateModel(data).save()); } catch(e) {}
  }
  templates.push(data);
}

// ── НОВОСТИ ────────────────────────────────────────────────
function saveLocalNews() {
  try { fs.writeFileSync(NEWS_FILE, JSON.stringify(newsItems, null, 2)); } catch(e) {}
}

async function dbGetNews() {
  let list;
  if (NewsModel) {
    try { list = await dbTimeout(NewsModel.find({}).lean().exec()); }
    catch(e) { console.error('❌ dbGetNews:', e.message); list = newsItems; }
  } else {
    list = newsItems;
  }
  return [...list].sort((a, b) => (a.order || 0) - (b.order || 0));
}

async function dbSaveNews(id, data) {
  const idx = newsItems.findIndex(n => n.id === id);
  if (idx >= 0) newsItems[idx] = { ...newsItems[idx], ...data, id };
  else newsItems.push({ id, order: newsItems.length, ...data });

  if (NewsModel) {
    try { await dbTimeout(NewsModel.findOneAndUpdate({ id }, { ...data, id }, { upsert: true, new: true }).exec()); }
    catch(e) { console.error('❌ dbSaveNews:', e.message); }
  } else {
    saveLocalNews();
  }
}

async function dbDeleteNews(id) {
  newsItems = newsItems.filter(n => n.id !== id);
  if (NewsModel) {
    try { await dbTimeout(NewsModel.deleteOne({ id }).exec()); } catch(e) { console.error('❌ dbDeleteNews:', e.message); }
  } else {
    saveLocalNews();
  }
}

async function dbReorderNews(orderedIds) {
  orderedIds.forEach((id, i) => {
    const item = newsItems.find(n => n.id === id);
    if (item) item.order = i;
  });
  if (NewsModel) {
    try {
      await dbTimeout(Promise.all(orderedIds.map((id, i) =>
        NewsModel.updateOne({ id }, { order: i }).exec()
      )));
    } catch(e) { console.error('❌ dbReorderNews:', e.message); }
  } else {
    saveLocalNews();
  }
}

// ── ЛИЧНЫЕ СООБЩЕНИЯ (ЛС) ────────────────────────────────────
function saveLocalDM() {
  try { fs.writeFileSync(DM_FILE, JSON.stringify(dmThreads, null, 2)); } catch(e) {}
}

function dmPairKey(a, b) {
  return [a, b].sort((x, y) => x.localeCompare(y)).join('__');
}

// Redis хранит актуальную копию ЛС независимо от MongoDB. Это важно для
// рестартов на Render: локальный dm.json там является только временным кэшем.
const dmRedisKey = key => `dm_thread:${key}`;
const dmPartnersRedisKey = username => `dm_partners:${username}`;

function parseDMRedisValue(value, fallback) {
  if (!value) return fallback;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch (_) { return fallback; }
}

async function redisGetDMThread(key) {
  if (!redis) return null;
  try {
    const stored = parseDMRedisValue(await redis.get(dmRedisKey(key)), null);
    return Array.isArray(stored?.messages) ? { messages: stored.messages } : null;
  } catch (e) {
    console.error(`❌ Redis ЛС (${key}):`, e.message);
    return null;
  }
}

async function redisSaveDMThread(key, thread) {
  if (!redis) return;
  try { await redis.set(dmRedisKey(key), JSON.stringify({ messages: thread.messages })); }
  catch (e) { console.error(`❌ Redis сохранение ЛС (${key}):`, e.message); }
}

async function redisRememberDMPartners(a, b) {
  if (!redis) return;
  try {
    for (const [user, peer] of [[a, b], [b, a]]) {
      const stored = parseDMRedisValue(await redis.get(dmPartnersRedisKey(user)), []);
      const partners = Array.isArray(stored) ? stored : [];
      if (!partners.includes(peer)) partners.push(peer);
      await redis.set(dmPartnersRedisKey(user), JSON.stringify(partners));
    }
  } catch (e) { console.error('❌ Redis список ЛС:', e.message); }
}

async function dbGetDMThread(a, b) {
  const key = dmPairKey(a, b);

  // Сначала берём постоянно сохранённую Redis-копию: она записывается при
  // каждом сообщении и не зависит от состояния/доступности MongoDB.
  const redisThread = await redisGetDMThread(key);
  if (redisThread) {
    dmThreads[key] = redisThread;
    return redisThread;
  }

  // Если Redis временно недоступен, используем загруженный локальный кэш.
  if (dmThreads[key]) return dmThreads[key];

  if (DMModel) {
    try {
      const doc = await dbTimeout(DMModel.findOne({ pairKey: key }).lean().exec());
      if (doc) {
        dmThreads[key] = { messages: Array.isArray(doc.messages) ? doc.messages : [] };
        // Переносим ранее сохранённые Mongo-диалоги в надёжную Redis-копию.
        await redisSaveDMThread(key, dmThreads[key]);
        await redisRememberDMPartners(a, b);
      }
    } catch(e) { console.error(`❌ dbGetDMThread(${key}):`, e.message); }
  }
  return dmThreads[key] || { messages: [] };
}

async function dbAppendDMMessage(a, b, msg) {
  const key = dmPairKey(a, b);
  const thread = dmThreads[key] || { messages: [] };
  thread.messages.push(msg);
  if (thread.messages.length > DM_HISTORY_LIMIT) thread.messages.shift();
  dmThreads[key] = thread;

  // Сохраняем до рассылки сообщения. Даже если MongoDB временно недоступна,
  // история останется после перезапуска и будет восстановлена из Redis.
  await Promise.all([
    redisSaveDMThread(key, thread),
    redisRememberDMPartners(a, b),
  ]);

  if (DMModel) {
    try {
      await dbTimeout(DMModel.findOneAndUpdate({ pairKey: key }, { pairKey: key, messages: thread.messages }, { upsert: true }).exec());
    } catch(e) { console.error(`❌ dbAppendDMMessage(${key}):`, e.message); saveLocalDM(); }
  } else {
    saveLocalDM();
  }
  return thread;
}

// Список username-ов, с которыми у пользователя есть история переписки (для ЛС-списка бесед),
// даже если это не друзья — переписка сохраняется независимо от списка друзей.
async function dbGetDMPartners(username) {
  const partners = new Set(
    Object.keys(dmThreads)
      .filter(key => key.split('__').includes(username))
      .map(key => key.split('__').find(u => u !== username))
      .filter(Boolean)
  );

  if (redis) {
    try {
      const stored = parseDMRedisValue(await redis.get(dmPartnersRedisKey(username)), []);
      if (Array.isArray(stored)) stored.forEach(peer => { if (typeof peer === 'string' && peer !== username) partners.add(peer); });
    } catch(e) { console.error('❌ Redis список ЛС:', e.message); }
  }

  if (DMModel) {
    try {
      const docs = await dbTimeout(DMModel.find({ pairKey: new RegExp(`(^|__)${username.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(__|$)`) }).lean().exec());
      docs.map(d => d.pairKey.split('__').find(u => u !== username)).filter(Boolean).forEach(peer => partners.add(peer));
    } catch(e) { console.error('❌ dbGetDMPartners:', e.message); }
  }
  return [...partners];
}

async function dbGetSettings() {
  if (SettingsModel) {
    try {
      const doc = await dbTimeout(SettingsModel.findOne({ key: 'server_settings' }).lean().exec());
      return doc ? doc.value : null;
    } catch(e) { return null; }
  }
  return null;
}

async function dbSaveSettings(settings) {
  if (SettingsModel) {
    try { await dbTimeout(SettingsModel.findOneAndUpdate({ key: 'server_settings' }, { value: settings }, { upsert: true }).exec()); } catch(e) {}
  }
}

function saveLocalAccounts() {
  try { fs.writeFileSync(path.join(__dirname, 'accounts.json'), JSON.stringify(accounts, null, 2)); } catch(e) {}
}

// ── INIT ───────────────────────────────────────────────────
async function initDatabases() {
  if (mongoose && process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 30000,
      });
      console.log('✅ MongoDB Atlas подключён');
    } catch(e) {
      console.error('❌ MongoDB:', e.message);
      mongoose = null; AccountModel = null; ClanModel = null; TemplateModel = null; SettingsModel = null; DMModel = null; AntiBotLogModel = null;
    }
  }

  // Настройки сервера
  const savedSettings = await dbGetSettings();
  if (savedSettings) {
    serverSettings = { ...serverSettings, ...savedSettings };
  } else {
    const sf = path.join(__dirname, 'server_settings.json');
    if (fs.existsSync(sf)) {
      try { serverSettings = { ...serverSettings, ...JSON.parse(fs.readFileSync(sf, 'utf8')) }; } catch(e) {}
    }
  }

  // Аккаунты из файла (если нет MongoDB)
  if (!AccountModel) {
    const af = path.join(__dirname, 'accounts.json');
    if (fs.existsSync(af)) {
      try { accounts = JSON.parse(fs.readFileSync(af, 'utf8')); } catch(e) {}
    }
    if (accounts['d3cord']?.email === 'otarasik10@gmail.com') accounts['d3cord'].role = 'admin';
  }

  if (!AntiBotLogModel && fs.existsSync(ANTI_BOT_REVIEW_LOG_FILE)) {
    try {
      const savedLog = JSON.parse(fs.readFileSync(ANTI_BOT_REVIEW_LOG_FILE, 'utf8'));
      if (Array.isArray(savedLog)) antiBotReviewLog = savedLog.slice(0, 500);
    } catch (error) { console.error('[ANTI-BOT] local review log load:', error.message); }
  }

  // Новости из файла (если нет MongoDB)
  if (!NewsModel) {
    if (fs.existsSync(NEWS_FILE)) {
      try { newsItems = JSON.parse(fs.readFileSync(NEWS_FILE, 'utf8')); } catch(e) {}
    }
  }

  // Локальный файл — резервный кэш ЛС. Загружаем его и при активной MongoDB:
  // это позволяет не терять переписку, если база была недоступна в момент
  // сохранения предыдущего сообщения.
  if (fs.existsSync(DM_FILE)) {
    try { dmThreads = JSON.parse(fs.readFileSync(DM_FILE, 'utf8')); } catch(e) {}
  }

  // Метаданные холста
  let metaLoaded = false;
  let boardSnapshotRef = null;
  let boardSnapshotFallbackRefs = [];
  if (redis) {
    try {
      const raw = await redis.get(BOARD_SNAPSHOT_POINTER_KEY);
      const ref = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (ref?.id && ref?.w && ref?.h) {
        boardSnapshotRef = ref;
        CANVAS_WIDTH = ref.w;
        CANVAS_HEIGHT = ref.h;
        metaLoaded = true;
      }
    } catch(e) { console.error('❌ Redis board snapshot pointer:', e.message); }
    // История хранит предыдущие целые версии. Она не участвует в обычном
    // запуске, но даёт безопасный fallback, если активный снимок повреждён.
    try {
      const rawHistory = await redis.get(BOARD_SNAPSHOT_HISTORY_KEY);
      const history = rawHistory ? (typeof rawHistory === 'string' ? JSON.parse(rawHistory) : rawHistory) : [];
      if (Array.isArray(history)) {
        boardSnapshotFallbackRefs = history.filter(ref => ref?.id && ref?.w && ref?.h && ref.id !== boardSnapshotRef?.id);
      }
    } catch(e) { console.error('❌ Redis board snapshot history:', e.message); }
  }
  if (redis && !metaLoaded) {
    try {
      const raw = await redis.get('canvas_meta');
      if (raw) {
        const meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (meta?.w && meta?.h) { CANVAS_WIDTH = meta.w; CANVAS_HEIGHT = meta.h; metaLoaded = true; }
      }
    } catch(e) { console.error('❌ Redis meta:', e.message); }
  }
  if (!metaLoaded && fs.existsSync(META_FILE)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      if (meta.w && meta.h) { CANVAS_WIDTH = meta.w; CANVAS_HEIGHT = meta.h; }
    } catch(e) {}
  }

  // Данные холста
  CANVAS_SIZE = CANVAS_WIDTH * CANVAS_HEIGHT;
  canvasData   = new Uint8Array(CANVAS_SIZE);
  pixelOwners  = new Uint16Array(CANVAS_SIZE);

  let canvasLoaded = false;
  let snapshotOwnersBuffer = null;
  let snapshotOwnerIds = null;
  if (redis && boardSnapshotRef) {
    const candidates = [boardSnapshotRef, ...boardSnapshotFallbackRefs];
    for (const ref of candidates) {
      // Текущая версия и резерв должны иметь те же размеры; снимок другого
      // размера остаётся в истории, но не подменяет работающий холст молча.
      if (ref.w !== CANVAS_WIDTH || ref.h !== CANVAS_HEIGHT) continue;
      try {
        const keys = boardSnapshotKeys(ref.id);
        const [canvasB64, ownersB64, idsRaw] = await Promise.all([
          redis.get(keys.canvas), redis.get(keys.owners), redis.get(keys.ids)
        ]);
        const canvasBuf = canvasB64 ? Buffer.from(canvasB64, 'base64') : null;
        const ownersBuf = ownersB64 ? Buffer.from(ownersB64, 'base64') : null;
        const ids = idsRaw ? (typeof idsRaw === 'string' ? JSON.parse(idsRaw) : idsRaw) : null;
        if (canvasBuf?.length === CANVAS_SIZE && ownersBuf?.length === CANVAS_SIZE * 2 && Array.isArray(ids)) {
          canvasData.set(canvasBuf);
          snapshotOwnersBuffer = ownersBuf;
          snapshotOwnerIds = ids;
          canvasLoaded = true;
          if (ref.id !== boardSnapshotRef.id) console.warn(`⚠️ Активный снимок повреждён, восстановлен резерв ${ref.id}`);
          else console.log('✅ Холст и авторы загружены из единого снимка Redis');
          break;
        }
      } catch(e) { console.error('❌ Redis board snapshot:', e.message); }
    }
  }
  if (redis && !canvasLoaded) {
    try {
      console.log('⏳ Загружаем холст из Redis...');
      const b64 = await redis.get('pixel_canvas');
      if (b64) {
        const buf = Buffer.from(b64, 'base64');
        if (buf.length === CANVAS_SIZE) { canvasData.set(buf); canvasLoaded = true; console.log('✅ Холст загружен из Redis'); }
      }
    } catch(e) { console.error('❌ Redis canvas:', e.message); }
  }
  if (!canvasLoaded && fs.existsSync(CANVAS_FILE)) {
    try {
      const saved = fs.readFileSync(CANVAS_FILE);
      if (saved.length === CANVAS_SIZE) { canvasData.set(saved); canvasLoaded = true; console.log('✅ Холст загружен из файла'); }
    } catch(e) {}
  }
  if (!canvasLoaded) console.log('⚠️ Начат с чистого холста');

  // ── Загрузка авторов пикселей ──────────────────────────
  // ВАЖНО: на хостингах вроде Render локальный диск эфемерный и обнуляется
  // при каждом рестарте/редеплое — раньше эти данные хранились ТОЛЬКО в
  // файлах (PIXEL_IDS_FILE/PIXEL_OWNERS_FILE), поэтому "последний автор
  // пикселя" пропадал при каждом перезапуске, хотя сам холст выживал
  // (он-то как раз лежит в Redis). Теперь тот же Uint16-буфер и словарь
  // авторов зеркалируются в Redis — это всего ~2 байта на пиксель
  // (для холста 256×256 — 128 КБ, для 512×512 — 512 КБ), что ничтожно
  // мало относительно лимита Upstash в 256 МБ. Файлы остаются как
  // локальный fallback/кэш на случай недоступности Redis.
  let ownersLoaded = false;
  if (snapshotOwnersBuffer && snapshotOwnerIds) {
    let maxId = 0;
    for (const entry of snapshotOwnerIds) {
      ownerIdMap.set(entry.username, entry.id);
      ownerDataMap.set(entry.id, { username: entry.username, emoji: entry.emoji || '👾', avatar: entry.avatar || null });
      if (entry.id > maxId) maxId = entry.id;
    }
    nextOwnerId = maxId + 1;
    pixelOwners.set(new Uint16Array(snapshotOwnersBuffer.buffer, snapshotOwnersBuffer.byteOffset, CANVAS_SIZE));
    ownersLoaded = true;
  }
  if (redis && !ownersLoaded) {
    try {
      const idsRaw = await redis.get('pixel_owner_ids');
      const ownersB64 = await redis.get('pixel_owners');
      if (idsRaw && ownersB64) {
        const ids = typeof idsRaw === 'string' ? JSON.parse(idsRaw) : idsRaw;
        let maxId = 0;
        for (const entry of ids) {
          ownerIdMap.set(entry.username, entry.id);
          ownerDataMap.set(entry.id, { username: entry.username, emoji: entry.emoji || '👾', avatar: entry.avatar || null });
          if (entry.id > maxId) maxId = entry.id;
        }
        nextOwnerId = maxId + 1;
        const buf = Buffer.from(ownersB64, 'base64');
        if (buf.length === CANVAS_SIZE * 2) {
          pixelOwners.set(new Uint16Array(buf.buffer, buf.byteOffset, CANVAS_SIZE));
          ownersLoaded = true;
          console.log(`✅ Таблица авторов пикселей загружена из Redis (${ids.length} записей)`);
        }
      }
    } catch(e) { console.error('❌ Redis pixel owners:', e.message); }
  }

  if (!ownersLoaded) {
    try {
      if (fs.existsSync(PIXEL_IDS_FILE)) {
        const ids = JSON.parse(fs.readFileSync(PIXEL_IDS_FILE, 'utf8'));
        let maxId = 0;
        for (const entry of ids) {
          ownerIdMap.set(entry.username, entry.id);
          ownerDataMap.set(entry.id, { username: entry.username, emoji: entry.emoji || '👾', avatar: entry.avatar || null });
          if (entry.id > maxId) maxId = entry.id;
        }
        nextOwnerId = maxId + 1;
        console.log(`✅ Загружен словарь авторов из файла (${ids.length} записей)`);
      }
    } catch(e) { console.error('❌ pixel_owner_ids.json:', e.message); }

    try {
      if (fs.existsSync(PIXEL_OWNERS_FILE)) {
        const buf = fs.readFileSync(PIXEL_OWNERS_FILE);
        // Файл хранит Uint16 little-endian, размер = CANVAS_SIZE * 2
        if (buf.length === CANVAS_SIZE * 2) {
          pixelOwners.set(new Uint16Array(buf.buffer, buf.byteOffset, CANVAS_SIZE));
          console.log('✅ Загружена таблица авторов пикселей из файла');
        } else {
          console.log('⚠️ pixel_owners.bin: неверный размер, начинаем заново');
        }
      }
    } catch(e) { console.error('❌ pixel_owners.bin:', e.message); }
  }
}

// ── PERSIST ────────────────────────────────────────────────
async function persistCanvas() {
  if (canvasPersistPromise) return canvasPersistPromise;
  canvasPersistPromise = (async () => {
    do {
      let retryLater = false;
      const saveCanvas = isDirty;
      const saveOwners = ownersDirty;
      if (!saveCanvas && !saveOwners) break;
      isDirty = false;
      ownersDirty = false;

      // Всегда создаём обе части из одного момента времени. Указатель в Redis
      // переключается только в самом конце — это атомарный commit снимка.
      const canvasSnapshot = Buffer.from(canvasData);
      const ownerBuf = Buffer.from(pixelOwners.buffer.slice(pixelOwners.byteOffset, pixelOwners.byteOffset + pixelOwners.byteLength));
      const idsArr = [];
      for (const [username, id] of ownerIdMap.entries()) {
        const data = ownerDataMap.get(id);
        idsArr.push({ id, username, emoji: data?.emoji || '👾', avatar: data?.avatar || null });
      }
      const idsJson = JSON.stringify(idsArr);
      const meta = JSON.stringify({ w: CANVAS_WIDTH, h: CANVAS_HEIGHT });

      if (redis) {
        boardPersistStatus.lastAttemptAt = Date.now();
        let previous = null;
        try {
          const previousRaw = await redis.get(BOARD_SNAPSHOT_POINTER_KEY);
          previous = previousRaw ? (typeof previousRaw === 'string' ? JSON.parse(previousRaw) : previousRaw) : null;
        } catch(e) { console.error('❌ Redis board snapshot pointer read:', e.message); }
        const snapshotId = `${Date.now().toString(36)}-${(++boardSnapshotSequence).toString(36)}`;
        const keys = boardSnapshotKeys(snapshotId);
        try {
          await redis.set(keys.canvas, canvasSnapshot.toString('base64'));
          await redis.set(keys.owners, ownerBuf.toString('base64'));
          await redis.set(keys.ids, idsJson);
          // Только эта операция делает новую версию видимой после рестарта.
          const currentRef = { id:snapshotId, w:CANVAS_WIDTH, h:CANVAS_HEIGHT };
          await redis.set(BOARD_SNAPSHOT_POINTER_KEY, JSON.stringify(currentRef));
          // После commit сохраняем один предыдущий целый снимок. Если текущий
          // ключ окажется повреждённым, старт выберет эту резервную версию.
          let oldHistory = [];
          try {
            const rawHistory = await redis.get(BOARD_SNAPSHOT_HISTORY_KEY);
            const parsed = rawHistory ? (typeof rawHistory === 'string' ? JSON.parse(rawHistory) : rawHistory) : [];
            if (Array.isArray(parsed)) oldHistory = parsed;
          } catch (_) {}
          const history = [currentRef, previous, ...oldHistory]
            .filter(ref => ref?.id && ref?.w && ref?.h)
            .filter((ref, index, all) => all.findIndex(other => other.id === ref.id) === index)
            .slice(0, 2);
          await redis.set(BOARD_SNAPSHOT_HISTORY_KEY, JSON.stringify(history));
          // Чистим только версии, которые больше не являются текущей или
          // резервной. Ошибка очистки не влияет на целостность данных.
          const retainedIds = new Set(history.map(ref => ref.id));
          for (const ref of oldHistory) {
            if (!ref?.id || retainedIds.has(ref.id)) continue;
            const old = boardSnapshotKeys(ref.id);
            try { await redis.del(old.canvas, old.owners, old.ids); } catch (_) {}
          }
          boardPersistStatus.lastSuccessAt = Date.now();
          boardPersistStatus.lastSnapshotId = snapshotId;
          boardPersistStatus.lastError = null;
          boardPersistStatus.consecutiveFailures = 0;
        } catch(e) {
          // Не теряем dirty-флаги: следующий безопасный таймер повторит commit.
          // Без этого сервер после ошибки Redis продолжал работу только в RAM.
          boardPersistStatus.lastError = e.message;
          boardPersistStatus.consecutiveFailures++;
          isDirty = true;
          ownersDirty = true;
          retryLater = true;
          console.error('❌ Redis board snapshot save:', e.message);
        }
      }

      // Локальные файлы остаются резервной копией для запуска без Redis.
      try { fs.writeFileSync(META_FILE, meta); fs.writeFileSync(CANVAS_FILE, canvasSnapshot); } catch(e) {}
      try { fs.writeFileSync(PIXEL_OWNERS_FILE, ownerBuf); } catch(e) { console.error('❌ pixel_owners.bin save:', e.message); }
      try { fs.writeFileSync(PIXEL_IDS_FILE, idsJson); } catch(e) { console.error('❌ pixel_owner_ids.json save:', e.message); }
      // Не делаем горячий бесконечный retry при сбое провайдера. Dirty-флаги
      // сохранены, поэтому следующая попытка произойдёт по существующему таймеру.
      if (retryLater) break;
    } while (isDirty || ownersDirty);
  })().finally(() => { canvasPersistPromise = null; });
  return canvasPersistPromise;
}

async function saveSettings() {
  await dbSaveSettings(serverSettings);
  try { fs.writeFileSync(path.join(__dirname, 'server_settings.json'), JSON.stringify(serverSettings, null, 2)); } catch(e) {}
}

// ── BATCH SAVE TIMER ───────────────────────────────────────
setInterval(async () => {
  if (dirtyAccounts.size > 0) {
    const batch = Array.from(dirtyAccounts); dirtyAccounts.clear();
    for (const username of batch) {
      if (accounts[username]) {
        try { await dbSaveAccount(username, { pixels: accounts[username].pixels, coins: accounts[username].coins, rank: accounts[username].rank, xp: accounts[username].xp, inventory: accounts[username].inventory }); } catch(e) {}
      }
    }
  }
  if (dirtyClans.size > 0) {
    const batch = Array.from(dirtyClans); dirtyClans.clear();
    for (const cname of batch) {
      if (clans[cname]) {
        try { await dbSaveClan(cname, { pixels: clans[cname].pixels }); } catch(e) {}
      }
    }
  }
}, 5000);

// ════════════════════════════════════════════════════════════
//  HTTP + WEBSOCKET SERVER
// ════════════════════════════════════════════════════════════

initDatabases().then(async () => {
  // Если сервер упал/перезапустился (деплой, краш) во время записи тайм-лапса,
  // session хранился только в памяти и терялся — запись "тихо" останавливалась
  // без вызова stopRecording() и без явного уведомления. Пытаемся восстановить
  // её из R2 до того, как начнём принимать соединения.
  if (tl && tl.resumeRecording) {
    try {
      const resumed = await tl.resumeRecording();
      if (resumed) console.log('[Timelapse] Запись восстановлена после рестарта сервера');
    } catch (e) {
      console.error('[Timelapse] Ошибка восстановления записи после рестарта:', e.message);
    }
  }

  const app = express();
  // Discord вызывает этот endpoint при нажатии на кнопку в личной рассылке.
  // Подпись проверяется до обработки: иначе любой мог бы подделать запуск Activity.
  app.post('/interactions', express.raw({ type: 'application/json' }), (req, res) => {
    try {
      if (!DISCORD_PUBLIC_KEY || !/^[0-9a-f]{64}$/i.test(DISCORD_PUBLIC_KEY)) return res.status(503).send('Discord interactions are not configured');
      const signature = req.get('X-Signature-Ed25519') || '';
      const timestamp = req.get('X-Signature-Timestamp') || '';
      const publicKey = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(DISCORD_PUBLIC_KEY, 'hex')]),
        format: 'der', type: 'spki',
      });
      const valid = crypto.verify(null, Buffer.concat([Buffer.from(timestamp), req.body]), publicKey, Buffer.from(signature, 'hex'));
      if (!valid) return res.status(401).send('Invalid request signature');
      const interaction = JSON.parse(req.body.toString('utf8'));
      if (interaction.type === 1) return res.json({ type: 1 });
      if (interaction.type === 3 && interaction.data?.custom_id === 'pixel_battle_launch_activity') return res.json({ type: 12 });
      return res.status(400).send('Unsupported interaction');
    } catch (error) {
      console.error('[Discord interactions]', error.message);
      return res.status(401).send('Invalid interaction');
    }
  });
  app.use(express.json({ limit: '20mb' }));

  // CORS: фронтенд может быть открыт с другого домена (например GitHub Pages),
  // поэтому разрешаем кросс-доменные запросы к /api/*.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.static(path.join(__dirname)));

  app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
    res.send('Pixel Battle Server Running');
  });

  // Загрузка шаблонов в Cloudinary
  // Обработчик загрузки шаблонов (два маршрута: с /api/ и без — Discord срезает префикс при проксировании)
  async function handleUploadTemplate(req, res) {
    try {
      const { imageBase64, name, username } = req.body;
      if (!imageBase64 || !name) return res.status(400).json({ error: 'Missing data' });
      let cloudUrl = null, cloudId = null;
      if (cloudinary && process.env.CLOUDINARY_CLOUD_NAME) {
        try {
          const result = await cloudinary.uploader.upload(imageBase64, {
            folder: 'pixel_battle_templates',
            public_id: `tmpl_${Date.now()}`,
          });
          cloudUrl = result.secure_url; cloudId = result.public_id;
        } catch (cloudErr) {
          console.error('❌ Cloudinary upload failed, falling back to inline data URL:', cloudErr.message);
        }
      }
      // ВАЖНО: если Cloudinary не настроен (нет CLOUDINARY_CLOUD_NAME в env) или
      // сам аплоад упал — раньше cloudUrl оставался null, но сервер всё равно
      // отвечал {success:true, url:null}. Клиент в этом случае молча не
      // выставлял картинку — не было ни явной ошибки, ни рабочего фона:
      // "картинка не подтянулась". Чиним это: если облако недоступно, отдаём
      // саму base64 data URL как universal fallback — она отлично работает
      // как src/background-image напрямую в браузере, просто без сжатия/CDN.
      if (!cloudUrl) cloudUrl = imageBase64;
      await dbSaveTemplate({ name, cloudinary_url: cloudId ? cloudUrl : null, cloudinary_id: cloudId, uploader: username || 'anon' });
      res.json({ success: true, url: cloudUrl, name, fallback: !cloudId });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
  app.post('/api/upload-template', handleUploadTemplate);
  app.post('/upload-template', handleUploadTemplate); // Discord срезает /api при проксировании

  async function handleGetTemplates(req, res) {
    try { res.json(await dbGetTemplates()); } catch(e) { res.status(500).json({ error: e.message }); }
  }
  app.get('/api/templates', handleGetTemplates);
  app.get('/templates', handleGetTemplates); // Discord срезает /api при проксировании

  // ── DISCORD ACTIVITY: обмен OAuth-кода на токен ──────────
  app.post('/api/discord-token', async (req, res) => handleDiscordToken(req, res));
  app.post('/discord-token', async (req, res) => handleDiscordToken(req, res));
  async function handleDiscordToken(req, res) {
    try {
      const { code } = req.body;
      if (!code) return res.status(400).json({ error: 'No code provided' });

      // redirect_uri для Discord Activity всегда фиксирован — домен вида <APP_ID>.discordsays.com
      // Клиент его не передаёт (authorize() не принимает redirect_uri — ошибка 5000),
      // поэтому берём строго из env-переменной.
      const discordClientId = process.env.DISCORD_CLIENT_ID;
      const redirectUri = `https://${discordClientId}.discordsays.com`;

      const response = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     discordClientId,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type:    'authorization_code',
          redirect_uri:  redirectUri,
          code,
        }),
      });

      const data = await response.json();
      if (!data.access_token) {
        console.error('Discord token error:', data);
        return res.status(400).json({ error: 'Failed to get token' });
      }

      res.json({ access_token: data.access_token });
    } catch(e) {
      console.error('/api/discord-token error:', e);
      res.status(500).json({ error: e.message });
    }
  }

  // Вход с обычного сайта. Redirect URI фиксирован на сервере, чтобы
  // клиент не мог подменить адрес, на который выдаётся OAuth-токен.
  app.post('/api/discord-web-token', async (req, res) => {
    try {
      const { code, redirect_uri } = req.body;
      // Должен посимвольно совпадать с URI из клиента и Discord Developer Portal.
      // GitHub Pages сам переадресует на URL со слешем, но для OAuth он не нужен.
        const productionRedirectUri = process.env.DISCORD_WEB_REDIRECT_URI || 'https://decord228.github.io/YamikoPixelBattle';
        // Локальный URI нужен только для разработки. Разрешаем ровно заданный
        // localhost-адрес, а не произвольный redirect из запроса.
        const localRedirectUri = process.env.DISCORD_LOCAL_REDIRECT_URI || 'http://localhost:5500';
        const allowedRedirectUris = new Set([productionRedirectUri, localRedirectUri]);
        if (!code || !allowedRedirectUris.has(redirect_uri)) return res.status(400).json({ error: 'Invalid OAuth callback' });
        const redirectUri = redirect_uri;

      const response = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code,
        }),
      });
      const data = await response.json();
      if (!data.access_token) {
        console.error('Discord website token error:', data);
        return res.status(400).json({ error: 'Failed to get token' });
      }
      res.json({ access_token: data.access_token });
    } catch (e) {
      console.error('/api/discord-web-token error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── TIMELAPSE ENDPOINTS ─────────────────────────────────
  app.get('/api/timelapse/sessions', async (req, res) => {
    try {
      if (!tl) return res.json([]);
      res.json(await tl.getSessions());
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/timelapse/sessions', async (req, res) => { // Discord proxy
    try {
      if (!tl) return res.json([]);
      res.json(await tl.getSessions());
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Снапшот начального состояния холста для данной сессии
  app.get('/api/timelapse/snapshot/:sessionId', async (req, res) => {
    try {
      if (!tl) return res.status(503).send('Timelapse не настроен');
      const buf = await tl.getSnapshot(req.params.sessionId);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(buf);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/timelapse/snapshot/:sessionId', async (req, res) => {
    try {
      if (!tl) return res.status(503).send('Timelapse не настроен');
      const buf = await tl.getSnapshot(req.params.sessionId);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(buf);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Все события сессии одним бинарным файлом
  // (сервер читает чанки из R2 последовательно и стримит клиенту)
  app.get('/api/timelapse/events/:sessionId', async (req, res) => {
    try {
      if (!tl) return res.status(503).send('Timelapse не настроен');
      const buf = await tl.getEvents(req.params.sessionId);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(buf);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/timelapse/events/:sessionId', async (req, res) => {
    try {
      if (!tl) return res.status(503).send('Timelapse не настроен');
      const buf = await tl.getEvents(req.params.sessionId);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(buf);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── WEB SOCKET ─────────────────────────────────────────
  const server = app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT} (${CANVAS_WIDTH}×${CANVAS_HEIGHT})`);
  });

  const wss = new WebSocketServer({ server });
  let pixelBatchBuffer = [];

  function broadcastOnlineCount() {
    const count = Array.from(wss.clients).filter(c => c.isAuthorized).length;
    const buf   = new Uint8Array(3);
    buf[0] = 255; buf[1] = (count >> 8) & 0xFF; buf[2] = count & 0xFF;
    const json = JSON.stringify({ action: 'online_count', count });
    wss.clients.forEach(c => { if (c.readyState === 1) { c.send(buf); c.send(json); } });
  }

  function broadcastAll(msg) {
    wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(msg); });
  }

  // Новости видны и незалогиненным (как и сам холст) — рассылаем всем открытым сокетам.
  function broadcastPublic(msg) {
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
  }

  function broadcastToClan(clanName, msg, excludeWs) {
    wss.clients.forEach(c => {
      if (c.readyState === 1 && c.isAuthorized && c.userData?.clan === clanName && c !== excludeWs)
        c.send(msg);
    });
  }

  // Проверяет ачивки аккаунта, разблокирует новые, начисляет xp и (если
  // silent=false) шлёт клиенту уведомление achievement_unlocked для тоста.
  // silent=true используется при логине — чтобы "досчитать" задним числом
  // уже выполненные условия у существующих игроков без спама уведомлениями.
  async function checkAchievements(username, acc, { silent = false, sessionPixels = 0 } = {}) {
    const stats = buildAchievementStats(acc, { sessionPixels });
    const already = new Set(acc.unlocked_achievements || []);
    const newly = [];
    for (const a of ACHIEVEMENTS_DEF) {
      if (already.has(a.id)) continue;
      let pass = false;
      try { pass = a.check(stats); } catch (_) {}
      if (pass) { already.add(a.id); newly.push(a); }
    }
    if (!newly.length) return;
    acc.unlocked_achievements = Array.from(already);
    // Опыт (a.xp) больше НЕ начисляется тут автоматически — условие ачивки
    // просто становится "доступно к получению". Игрок сам жмёт "Забрать" в
    // профиле → action:'claim_achievement' ниже, который и добавляет xp.
    try { await dbSaveAccount(username, { unlocked_achievements: acc.unlocked_achievements }); } catch (_) {}
    if (!silent) {
      for (const a of newly) {
        sendToUser(username, { action: 'achievement_unlocked', id: a.id, title: a.title, icon: a.icon, xp: a.xp, claimable: true });
      }
    }
  }

  // ── СОЦИАЛЬНАЯ СЕТЬ: ДРУЗЬЯ / ЛС / ОНЛАЙН ──────────────────
  // Находит открытый сокет по username (последний залогинившийся, если открыто
  // несколько вкладок — сообщения всё равно уйдут во все его сокеты через forEach).
  function findClientsByUsername(username) {
    const list = [];
    wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized && c.userData?.username === username) list.push(c); });
    return list;
  }

  function sendToUser(username, obj) {
    const msg = JSON.stringify(obj);
    findClientsByUsername(username).forEach(c => c.send(msg));
  }

  function isUserOnline(username) {
    return findClientsByUsername(username).length > 0;
  }

  // ── ИСТЕЧЕНИЕ ВРЕМЕННОГО VIP ──
  // Пользователь может оставаться в сессии дольше, чем длится награда
  // "VIP на N часов" (см. RANK_REWARDS 'Вдохновлённый'/'Зодчий'), поэтому
  // нельзя полагаться только на проверку при логине — иначе роль 'vip'
  // осталась бы навсегда, пока игрок не переподключится. Раз в минуту
  // проверяем всех залогиненных сейчас пользователей и снимаем истёкший
  // временный VIP, уведомляя их клиент, чтобы UI (значок VIP, доступ к
  // VIP-предметам магазина) сразу обновился.
  setInterval(async () => {
    for (const c of wss.clients) {
      if (c.readyState !== 1 || !c.isAuthorized || !c.userData) continue;
      const reverted = await revertExpiredTempVip(c.userData.username, c.userData).catch(() => false);
      if (reverted) {
        c.send(JSON.stringify({ action: 'vip_status', role: c.userData.role, vip_temp_until: 0, message: '⌛ Временный VIP-статус закончился' }));
      }
    }
  }, 60 * 1000);

  // Список всех сейчас залогиненных пользователей (дедуплицирован по username —
  // на случай нескольких открытых вкладок одного игрока).
  function getOnlineUsersSnapshot(excludeUsername) {
    const seen = new Map();
    wss.clients.forEach(c => {
      if (c.readyState === 1 && c.isAuthorized && c.userData && c.userData.username !== excludeUsername) {
        seen.set(c.userData.username, {
          username: c.userData.username,
          emoji:    c.userData.emoji || '👾',
          avatar:   getAvatarUrl(c.userData),
          banner:   c.userData.banner_id || null,
          role:     c.userData.role  || 'user',
          rank:     c.userData.rank  || 'Новичок',
          clan:     c.userData.clan  || '',
        });
      }
    });
    return Array.from(seen.values());
  }

  // Короткая карточка пользователя по account-объекту/userData — используется
  // и в friends_update, и в user_search_results, чтобы формат был одинаковым.
  function userCard(acc, extra) {
    if (!acc) return null;
    return {
      username: acc.username,
      emoji:    acc.emoji || '👾',
      avatar:   getAvatarUrl(acc),
      banner:   acc.banner_id || null,
      role:     acc.role  || 'user',
      rank:     acc.rank  || 'Новичок',
      clan:     acc.clan  || '',
      pixels:   acc.pixels || 0,
      online:   isUserOnline(acc.username),
      ...extra,
    };
  }

  // Полная сборка и отправка friends_update конкретному пользователю
  // (используется после любой операции с друзьями/заявками).
  async function sendFriendsUpdate(username) {
    const acc = await dbGetAccount(username);
    if (!acc) return;
    const friends  = await Promise.all((acc.friends || []).map(u => dbGetAccount(u)));
    const incoming = await Promise.all((acc.friend_requests_in  || []).map(u => dbGetAccount(u)));
    const outgoing = await Promise.all((acc.friend_requests_out || []).map(u => dbGetAccount(u)));
    sendToUser(username, {
      action:   'friends_update',
      friends:  friends.filter(Boolean).map(a => userCard(a)),
      incoming: incoming.filter(Boolean).map(a => userCard(a)),
      outgoing: outgoing.filter(Boolean).map(a => userCard(a)),
    });
  }

  // Оповещает всех друзей пользователя об изменении его online-статуса
  // (вызывается при входе/выходе), чтобы точки статуса в списке друзей
  // обновлялись вживую, без ручного обновления списка.
  async function notifyFriendsPresence(username, online) {
    const acc = await dbGetAccount(username);
    if (!acc || !Array.isArray(acc.friends)) return;
    acc.friends.forEach(f => sendToUser(f, { action: 'friend_presence', username, online }));
  }

  // Если участник, поделившийся трафаретом клана, уходит (кик/выход) —
  // трафарет нужно автоматически снять, иначе он "осиротеет" и останется
  // висеть на холсте у всех навечно без возможности его убрать.
  async function clearClanStencilIfOwner(clanName, username) {
    const clan = await dbGetClan(clanName);
    if (!clan) return;
    const remaining = normalizeClanStencils(clan).filter(s => s.owner !== username);
    if (remaining.length === clan.shared_stencils.length) return;
    await dbSaveClan(clanName, { active_stencil: remaining[0]?.stencil || null, shared_stencil: remaining[0] || null, shared_stencils: remaining });
    broadcastToClan(clanName, JSON.stringify({ action:'clan_stencil_update', stencils: remaining, from: username, removed: true }), null);
  }

  // Полный снимок холста и пакет точечных обновлений раньше оба были просто
  // Uint8Array. Если размер снимка оказывался кратен 5, старый клиент мог
  // принять его за список пикселей и нарисовать случайные точки. Перед каждым
  // снимком отправляем явный маркер с размерами; WebSocket сохраняет порядок
  // сообщений, поэтому следующий binary-пакет однозначно является снимком.
  function sendCanvasSnapshot(client) {
    if (!client || client.readyState !== 1) return;
    client.send(JSON.stringify({ action: 'canvas_snapshot', w: CANVAS_WIDTH, h: CANVAS_HEIGHT }));
    const snapshot = Buffer.from(canvasData);
    if ((client.paletteSize || LEGACY_PALETTE_COLOR_COUNT) < PALETTE_COLOR_COUNT) {
      for (let i = 0; i < snapshot.length; i++) snapshot[i] = colorForClientPalette(client, snapshot[i]);
    }
    client.send(snapshot);
  }

  setInterval(() => {
    if (!pixelBatchBuffer.length) return;
    const batch  = pixelBatchBuffer.splice(0);
    wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(buildPixelPacketForClient(c, batch)); });
  }, 50);

  function sendPixelBulk(pixels) {
    wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(buildPixelPacketForClient(c, pixels)); });
  }

  // Записывает пачку изменений холста в активную тайм-лапс сессию.
  // Используется ВСЕМИ путями изменения canvasData (не только обычной
  // установкой пикселя игроком) — иначе фигуры/перемещения/VIP-предметы/
  // автобилдер исчезают из тайм-лапса, хотя реально меняют холст.
  function recordPixelsForTimelapse(pixels) {
    if (!tl || !tl.isRecording() || !pixels || pixels.length === 0) return;
    // Используем батч-метод: все пиксели получают один timestamp,
    // поэтому admin-инструменты (прямоугольник, круг и т.д.) появляются
    // в тайм-лапсе мгновенно, а не выстраиваются по одному пикселю.
    if (tl.recordPixelsBatch) {
      tl.recordPixelsBatch(pixels);
    } else {
      for (const p of pixels) tl.recordPixel(p.x, p.y, p.c);
    }
  }


  function hasRole(userData, role) {
    if (userData.role === 'admin') return true;
    if (role === 'vip' && userData.role === 'vip') return true;
    if (role === 'user') return true;
    return false;
  }

  async function useConsumable(ws, itemId, reqData) {
    // Не используем снимок ws.userData: при двух открытых вкладках он может
    // отставать от покупки в другой вкладке. Берём единый актуальный аккаунт
    // из runtime-кэша и создаём отдельную копию инвентаря для этой операции.
    const acc = await dbGetAccount(ws.userData.username);
    if (!acc) return;
    ws.userData = acc;
    const inv = { ...(acc.inventory || {}) };
    if (!inv[itemId] || inv[itemId] <= 0) {
      ws.send(JSON.stringify({ action:'toast', message:'Предмет не найден в инвентаре' })); return;
    }

    // ── Кулдаун-ускорители — отдельная ветка, не рисуют пиксели ──
    // Бусты не суммируются: активация нового заменяет старый (иначе игрок
    // мог бы держать -90% часами, покупая по одному). Сохраняем в аккаунт
    // percentage + абсолютный timestamp окончания — это переживает
    // переподключение/обновление страницы (клиент получает его в auth_success).
    if (COOLDOWN_BOOST_IDS[itemId]) {
      const boost = COOLDOWN_BOOST_IDS[itemId];
      const until = Date.now() + boost.durationMin * 60 * 1000;
      inv[itemId]--;
      if (inv[itemId] <= 0) delete inv[itemId];
      acc.inventory = inv;
      acc.cooldownBoostPct = boost.pct;
      acc.cooldownBoostUntil = until;
      accounts[acc.username] = { ...accounts[acc.username], inventory: inv, cooldownBoostPct: boost.pct, cooldownBoostUntil: until };
      await dbSaveAccount(acc.username, { inventory: inv, cooldownBoostPct: boost.pct, cooldownBoostUntil: until });

      let clientItems = [...acc.upgrades];
      for (let k in inv) { for (let i = 0; i < inv[k]; i++) clientItems.push(k); }
      ws.send(JSON.stringify({ action:'toast', message:`⚡ Ускоритель активирован: −${boost.pct}% на ${boost.durationMin} мин.`, type:'success' }));
      ws.send(JSON.stringify({ action:'purchase_update', purchased_items: clientItems }));
      ws.send(JSON.stringify({ action:'cooldown_boost_update', pct: boost.pct, until, server_now: Date.now() }));
      return;
    }

    const px = reqData?.x !== undefined ? reqData.x : (acc._lastPixel?.x ?? Math.floor(CANVAS_WIDTH/2));
    const py = reqData?.y !== undefined ? reqData.y : (acc._lastPixel?.y ?? Math.floor(CANVAS_HEIGHT/2));
    const reqColor = reqData?.color !== undefined ? reqData.color : (acc._lastColor ?? 0);
    let pixels = [];

    if (itemId === 'bomb_3x3') {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px+dx, ny = py+dy;
        if (nx>=0&&nx<CANVAS_WIDTH&&ny>=0&&ny<CANVAS_HEIGHT) {
          canvasData[ny*CANVAS_WIDTH+nx] = reqColor;
          pixels.push({x:nx, y:ny, c:reqColor});
        }
      }
    } else if (itemId === 'rainbow_5x5') {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = px+dx, ny = py+dy;
        if (nx>=0&&nx<CANVAS_WIDTH&&ny>=0&&ny<CANVAS_HEIGHT) {
          const rc = Math.floor(Math.random()*PALETTE_COLOR_COUNT);
          canvasData[ny*CANVAS_WIDTH+nx] = rc;
          pixels.push({x:nx, y:ny, c:rc});
        }
      }
    } else if (itemId === 'eraser_10x10') {
      for (let dy = -4; dy <= 5; dy++) for (let dx = -4; dx <= 5; dx++) {
        const nx = px+dx, ny = py+dy;
        if (nx>=0&&nx<CANVAS_WIDTH&&ny>=0&&ny<CANVAS_HEIGHT) {
          canvasData[ny*CANVAS_WIDTH+nx] = 0;
          clearPixelOwner(nx, ny);
          // В пакет и таймлапс идёт фактический записанный цвет, а не текущий
          // выбранный игроком. Иначе до перезагрузки виден ложный рисунок.
          pixels.push({x:nx, y:ny, c:0});
        }
      }
    } else if (itemId === 'mirror_stamp') {
      const temp = [];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = px+dx, ny = py+dy;
          if (nx>=0&&nx<CANVAS_WIDTH&&ny>=0&&ny<CANVAS_HEIGHT) {
            temp.push({ dx, dy, c: canvasData[ny*CANVAS_WIDTH+nx], ownerId: getPixelOwnerId(nx, ny) });
          }
        }
      }
      for (const p of temp) {
         const mx = px - p.dx; 
         const my = py + p.dy;
         if (mx>=0&&mx<CANVAS_WIDTH&&my>=0&&my<CANVAS_HEIGHT) {
            canvasData[my*CANVAS_WIDTH+mx] = p.c;
            setPixelOwnerId(mx, my, p.c === 0 ? 0 : p.ownerId);
            pixels.push({x:mx, y:my, c:p.c});
          }
        }
    }

    inv[itemId]--;
    if (inv[itemId] <= 0) delete inv[itemId];
    acc.inventory = inv;
    accounts[acc.username] = { ...accounts[acc.username], inventory: inv };
    await dbSaveAccount(acc.username, { inventory: inv });

    if (pixels.length > 0) {
      // Только бомбочки считаются личной установкой пикселей. Ластик и
      // зеркальный штамп остаются служебными эффектами без начисления.
      const isBomb = itemId === 'bomb_3x3' || itemId === 'rainbow_5x5';
      if (isBomb) {
        // Клетки бомбочки принадлежат применившему игроку и при наведении
        // показывают его как автора.
        pixels.forEach(p => setPixelOwner(p.x, p.y, acc.username, acc.emoji || '👾', getAvatarUrl(acc)));

        const placedCount = pixels.length;
        const prevRank = acc.rank;
        acc.pixels = (acc.pixels || 0) + placedCount;
        acc.coins  = (acc.coins || 0) + placedCount * COINS_PER_PIXEL;
        acc.xp     = (acc.xp || 0) + placedCount;
        acc.rank   = getRank(acc.xp).name;
        accounts[acc.username] = { ...accounts[acc.username], pixels: acc.pixels, coins: acc.coins, xp: acc.xp, rank: acc.rank };
        dirtyAccounts.add(acc.username);

        if (acc.clan) {
          if (!clans[acc.clan]) clans[acc.clan] = { pixels: 0 };
          clans[acc.clan].pixels = (clans[acc.clan].pixels || 0) + placedCount;
          dirtyClans.add(acc.clan);
        }

        ws.send(JSON.stringify({ action:'coins_update', coins: acc.coins, pixels: acc.pixels, xp: acc.xp }));
        if (acc.rank !== prevRank) {
          const rankInfo = getRank(acc.xp);
          const hasReward = (RANK_REWARDS[acc.rank] || []).length > 0;
          ws.send(JSON.stringify({ action:'rank_up', rank: acc.rank, icon: rankInfo.icon, xp: acc.xp, claimable: hasReward }));
        }
        ws.sessionPixels += placedCount;
        checkAchievements(acc.username, acc, { sessionPixels: ws.sessionPixels }).catch(() => {});
      }

      isDirty = true;
      // Расходники меняют сразу несколько клеток: сначала фиксируем единый
      // снимок, затем показываем результат. Это не меняет формат таймлапса:
      // в него по-прежнему идут те же {x,y,c} фактические изменения.
      await persistCanvas();
      sendPixelBulk(pixels);
      recordPixelsForTimelapse(pixels);
    }
    
    let clientItems = [...acc.upgrades];
    for (let k in inv) {
      for (let i = 0; i < inv[k]; i++) clientItems.push(k);
    }
    ws.send(JSON.stringify({ action:'toast', message:`✅ Предмет успешно использован!`, type:'success' }));
    ws.send(JSON.stringify({ action:'purchase_update', purchased_items: clientItems }));
  }

  // ══════════════════════════════════════════════════════════
  //  WS CONNECTION
  // ══════════════════════════════════════════════════════════
  wss.on('connection', (ws) => {
    // Статистика одной игровой сессии не пишется в БД и начинается с нуля
    // при каждом новом WebSocket-соединении.
    ws.sessionPixels = 0;
    ws.isAuthorized = false;
    ws.userData     = null;
    // Сигнал присутствия человека живёт только в памяти сокета и не попадает
    // ни в снимки холста, ни в поток таймлапса.
    ws.lastHumanCursor = null;
    ws.lastHumanCursorAt = 0;
    ws.cursorMovesSincePixel = 0;
    // Короткий кэш результатов делает повтор одного requestId идемпотентным:
    // потерянный ответ можно запросить повторно без второго начисления награды.
    ws.pixelRequestResults = new Map();

    sendCanvasSnapshot(ws);
    ws.send(JSON.stringify({ action: 'server_settings', settings: serverSettings }));
    dbGetNews().then(items => ws.send(JSON.stringify({ action: 'news_data', items }))).catch(()=>{});
    if (globalChatHistory.length > 0) {
      ws.send(JSON.stringify({ action: 'chat_history', messages: globalChatHistory }));
    }

    ws.on('message', async (message) => {
      // ── BINARY: установка пикселя (5 байт) ──────────────
      if (message.length === 5 || message.length === 9) {
        // 9-байтовый пакет содержит ID запроса: клиент может сразу показать
        // пиксель, а затем точно откатить только его при отказе сервера.
        // Старый 5-байтовый формат оставлен для уже открытых клиентов.
        const requestId = message.length === 9 ? message.readUInt32BE(5) : null;
        const x = (message[0] << 8) | message[1];
        const y = (message[2] << 8) | message[3];
        const colorIdx = message[4];
        if (requestId !== null && ws.pixelRequestResults.has(requestId)) {
          ws.send(JSON.stringify(ws.pixelRequestResults.get(requestId)));
          return;
        }
        const sendPixelResult = (result) => {
          if (requestId === null) return;
          const payload = { action:'pixel_result', id:requestId, ...result };
          ws.pixelRequestResults.set(requestId, payload);
          // Ограниченный кэш: requestId уникален в рамках активного сокета,
          // но карта не должна расти при долгой сессии.
          if (ws.pixelRequestResults.size > 128) ws.pixelRequestResults.delete(ws.pixelRequestResults.keys().next().value);
          ws.send(JSON.stringify(payload));
        };
        const rejectPixel = (reason, timing = null) => {
          const color = x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT
            ? canvasData[y * CANVAS_WIDTH + x] : 0;
          sendPixelResult({ ok:false, x, y, color, reason, ...timing });
        };
        if (!ws.isAuthorized) { rejectPixel('Нет авторизации'); return; }
        const acc = ws.userData;
        if (acc.banned) { rejectPixel('Аккаунт заблокирован'); ws.send(JSON.stringify({ action:'toast', message:'Ваш аккаунт забанен!' })); return; }
        if (acc.timeout_until > Date.now()) {
          const left = Math.ceil((acc.timeout_until - Date.now()) / 1000);
          rejectPixel('Таймаут'); ws.send(JSON.stringify({ action:'toast', message:`Таймаут! Осталось: ${left}с` })); return;
        }
        if (isLockedNow() && acc.role !== 'admin') {
          rejectPixel('Пиксель Батл временно закрыт'); ws.send(JSON.stringify({ action:'toast', message:'🔒 Пиксель Батл временно закрыт' })); return;
        }

        const now = Date.now();
        const turnstileState = antiBotBehaviorByUsername.get(acc.username);
        if (TURNSTILE_SECRET_KEY && turnstileState?.turnstileRequiredUntil > now
          && (turnstileState.turnstileVerifiedUntil || 0) <= now) {
          if (!ws.lastTurnstilePromptAt || now - ws.lastTurnstilePromptAt > 3000) {
            ws.lastTurnstilePromptAt = now;
            ws.send(JSON.stringify({ action:'turnstile_required', expires_at:turnstileState.turnstileRequiredUntil }));
          }
          rejectPixel('restricted');
          return;
        }

        // Кулдаун проверяется и на сервере. Раньше ускоритель менял лишь
        // таймер в браузере: после переподключения эффект исчезал, а клиент
        // мог вообще обойти ограничение. Для всех ролей используется базовый
        // кулдаун, уменьшенный активным личным ускорителем.
        // Базовая защита от скриптов, которые отправляют бинарные пакеты
        // напрямую. Реальный клиент сообщает координату указателя до клика.
        const boostIsActive = (acc.cooldownBoostUntil || 0) > now && (acc.cooldownBoostPct || 0) > 0;
        const effectiveCooldownMs = boostIsActive
          ? Math.max(0, Math.round(serverSettings.cooldownMs * (1 - Math.min(100, acc.cooldownBoostPct) / 100)))
          : serverSettings.cooldownMs;
        if (acc._lastPixelAt && now - acc._lastPixelAt < effectiveCooldownMs) {
          rejectPixel('cooldown', { serverNow: now, nextAllowedAt: acc._lastPixelAt + effectiveCooldownMs });
          return;
        }

        if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT && colorIdx >= 0 && colorIdx < PALETTE_COLOR_COUNT) {
          canvasData[y * CANVAS_WIDTH + x] = colorIdx;
          setPixelOwner(x, y, acc.username, acc.emoji || '👾', getAvatarUrl(acc));
          pixelBatchBuffer.push({ x, y, c: colorIdx });
          isDirty = true;
          if (tl) tl.recordPixel(x, y, colorIdx);

          acc._lastPixel = { x, y };
          acc._lastColor = colorIdx;
          acc._lastPixelAt = now;
          const antiBotIntervention = recordAntiBotBehavior(ws, acc, now, x, y);
          if (antiBotIntervention) {
            void dbCreateAntiBotLog({
              username: acc.username,
              reasons: antiBotIntervention.reasons,
              metrics: {
                interval_cv: Number(antiBotIntervention.intervalCv.toFixed(4)),
                mean_interval_ms: Math.round(antiBotIntervention.meanInterval),
              },
              sample: antiBotIntervention.sample,
              captcha_required: antiBotIntervention.turnstileRequired,
            });
            console.warn(`[ANTI-BOT] review log for ${acc.username}: ${antiBotIntervention.reasons.join(', ')}`);
            if (antiBotIntervention.turnstileRequired) {
              ws.send(JSON.stringify({ action:'turnstile_required', expires_at:now + ANTIBOT_TURNSTILE_CHALLENGE_MS }));
            }
          }

          const prevCoins = acc.coins || 0;
          const prevRank  = acc.rank;
          acc.pixels = (acc.pixels || 0) + 1;
          acc.coins = (acc.coins || 0) + COINS_PER_PIXEL;
          // 1 пиксель = 1 очко опыта (xp), начисляется всегда автоматически.
          // Звание (rank) — это просто текущий уровень по xp, пересчитывается
          // мгновенно. САМА награда за звание (монеты/баннер/предмет) больше
          // НЕ выдаётся тут — игрок получает её кнопкой "Забрать" в модалке
          // "Звания и награды" (см. action:'claim_rank_reward' ниже).
          acc.xp    = (acc.xp || 0) + 1;
          acc.rank  = getRank(acc.xp).name;

          accounts[acc.username] = { ...accounts[acc.username], pixels: acc.pixels, coins: acc.coins, rank: acc.rank, xp: acc.xp };
          dirtyAccounts.add(acc.username);

          if (acc.clan) {
            if (!clans[acc.clan]) clans[acc.clan] = { pixels: 0 };
            clans[acc.clan].pixels = (clans[acc.clan].pixels || 0) + 1;
            dirtyClans.add(acc.clan);
          }

          if (acc.rank !== prevRank) {
            const rankInfo = getRank(acc.xp);
            const hasReward = (RANK_REWARDS[acc.rank] || []).length > 0;
            ws.send(JSON.stringify({ action: 'rank_up', rank: acc.rank, icon: rankInfo.icon, xp: acc.xp, claimable: hasReward }));
          }

          if (Math.floor(acc.coins) > Math.floor(prevCoins)) {
            ws.send(JSON.stringify({ action: 'coins_update', coins: acc.coins, pixels: acc.pixels, xp: acc.xp }));
          }

          // Ачивки проверяем на каждый пиксель, но это дёшево (просто сравнения
          // в памяти) — запись в БД происходит, только если реально что-то
          // разблокировалось. Не await'им, чтобы не тормозить приём пикселей.
          ws.sessionPixels += 1;
          checkAchievements(acc.username, acc, { sessionPixels: ws.sessionPixels }).catch(() => {});
          // Кулдаун на клиенте запускается только после этого подтверждения.
          // Время сервера исключает влияние неверных часов пользователя.
          sendPixelResult({
            ok:true, x, y, color:colorIdx,
            serverNow: now, nextAllowedAt: now + (Math.max(
              0,
              effectiveCooldownMs,
            )),
          });
        } else {
          rejectPixel('Некорректная клетка');
        }
        return;
      }

      // ── JSON MESSAGES ─────────────────────────────────────
      try {
        const data   = JSON.parse(message.toString());
        const action = data.action || data.type;

        // Восстановление авторитетного состояния после клиентского тайм-аута.
        // Не требует авторизации и не влияет на таймлапс: это только чтение.
        if (action === 'get_canvas_snapshot') {
          sendCanvasSnapshot(ws);
          return;
        }

        if (action === 'turnstile_verify') {
          if (!ws.isAuthorized) return;
          if (!TURNSTILE_SECRET_KEY) {
            ws.send(JSON.stringify({ action:'turnstile_result', ok:false, message:'Проверка безопасности временно недоступна' }));
            return;
          }
          const state = antiBotBehaviorByUsername.get(ws.userData.username);
          if (!state || state.turnstileRequiredUntil <= Date.now()) {
            ws.send(JSON.stringify({ action:'turnstile_result', ok:false, message:'Проверка больше не требуется или истекла' }));
            return;
          }
          const remoteIp = ws._socket?.remoteAddress || '';
          const verified = await validateTurnstileToken(data.token, remoteIp);
          if (!verified) {
            ws.send(JSON.stringify({ action:'turnstile_result', ok:false, message:'Проверка не пройдена. Попробуйте ещё раз.' }));
            return;
          }
          state.turnstileRequiredUntil = 0;
          state.turnstileVerifiedUntil = Date.now() + ANTIBOT_TURNSTILE_CLEARANCE_MS;
          ws.send(JSON.stringify({ action:'turnstile_result', ok:true, until:state.turnstileVerifiedUntil }));
          console.info(`[ANTI-BOT] ${ws.userData.username}: Turnstile passed`);
          return;
        }

        if (action === 'auth') {
          // ── Discord Activity авторизация ──────────────────
          if (data.discord_token) {
            try {
              ws.paletteSize = Math.max(1, Math.min(PALETTE_COLOR_COUNT, Number(data.palette_size) || LEGACY_PALETTE_COLOR_COUNT));
              const discordRes = await fetch('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${data.discord_token}` }
              });
              const discordUser = await discordRes.json();

              if (!discordUser.id) {
                ws.send(JSON.stringify({ action: 'toast', message: 'Ошибка Discord авторизации' }));
                return;
              }

              const username = discordUser.username;

              // Ищем аккаунт по discord_id или по username
              let acc = await dbGetAccountByDiscordId(discordUser.id);
              if (!acc) acc = await dbGetAccount(username);

              if (!acc) {
                // Первый вход — создаём аккаунт автоматически
                acc = {
                  username,
                  discord_id:     discordUser.id,
                  discord_avatar: discordUser.avatar || '',
                  password:       null,
                  email:          discordUser.email || '',
                  role:           'user',
                  pixels:         0,
                  rank:           'Новичок',
                  emoji:          '👾',
                  banned:         false,
                  timeout_until:  0,
                  coins:          0,
                  clan:           '',
                  inventory:      {},
                  upgrades:       [],
                  cooldownBoostPct: 0,
                  cooldownBoostUntil: 0,
                  active_stencil: null,
                  saved_stencils: [],
                  friends:             [],
                  friend_requests_in:  [],
                  friend_requests_out: [],
                  dm_reads:            {},
                  banner_id:           null,
                  owned_banners:       [],
                  xp:                  0,
                  unlocked_achievements: [],
                  claimed_ranks:         [],
                  claimed_xp_cycles:     [],
                  claimed_achievements:  [],
                };
                await dbSaveAccount(username, acc);
              } else {
                // Привязываем discord_id (если ещё не привязан) и всегда
                // обновляем avatar hash — в Discord пользователь мог сменить
                // аватарку с прошлого захода.
                const patch = {};
                if (!acc.discord_id) patch.discord_id = discordUser.id;
                if (acc.discord_avatar !== (discordUser.avatar || '')) patch.discord_avatar = discordUser.avatar || '';
                if (Object.keys(patch).length) {
                  Object.assign(acc, patch);
                  await dbSaveAccount(username, patch);
                }
              }

              if (acc.banned) {
                ws.send(JSON.stringify({ action: 'toast', message: 'Ваш аккаунт заблокирован!' }));
                return;
              }

              ws.isAuthorized = true;
              ws.userData = { ...acc, username };
              ws.userData.inventory      = ws.userData.inventory      || {};
              ws.userData.upgrades       = ws.userData.upgrades       || [];
              ws.userData.saved_stencils = ws.userData.saved_stencils || [];
              ws.userData.friends              = ws.userData.friends              || [];
              ws.userData.friend_requests_in   = ws.userData.friend_requests_in   || [];
              ws.userData.friend_requests_out  = ws.userData.friend_requests_out  || [];
              ws.userData.dm_reads             = ws.userData.dm_reads             || {};
              ws.userData.owned_banners        = ws.userData.owned_banners        || [];
              ws.userData.xp                   = ws.userData.xp                   || 0;
              ws.userData.unlocked_achievements = ws.userData.unlocked_achievements || [];
              ws.userData.claimed_ranks = ws.userData.claimed_ranks || [];
              ws.userData.claimed_achievements = ws.userData.claimed_achievements || [];
              ws.userData.vip_temp_until       = ws.userData.vip_temp_until       || 0;
              ws.userData.vip_temp_prev_role   = ws.userData.vip_temp_prev_role   || '';
              await revertExpiredTempVip(ws.userData.username, ws.userData);
              ws.userData.rank = getRank(ws.userData.xp).name;

              // Досчитываем задним числом уже выполненные ачивки (тихо, без тоста) —
              // важно, например, для игроков, залогинившихся впервые после
              // выкатки этой фичи.
              checkAchievements(ws.userData.username, ws.userData, { silent: true }).catch(() => {});

              let clientItems = [...ws.userData.upgrades];
              for (let k in ws.userData.inventory) {
                for (let i = 0; i < ws.userData.inventory[k]; i++) clientItems.push(k);
              }

              ws.send(JSON.stringify({
                action:          'auth_success',
                username:        ws.userData.username,
                role:            ws.userData.role      || 'user',
                pixels:          ws.userData.pixels    || 0,
                rank:            ws.userData.rank      || 'Новичок',
                emoji:           ws.userData.emoji     || '👾',
                avatar:          getAvatarUrl(ws.userData),
                banner:          ws.userData.banner_id    || null,
                owned_banners:   ws.userData.owned_banners || [],
                banners_catalog: PROFILE_BANNERS,
                coins:           ws.userData.coins     || 0,
                clan:            ws.userData.clan      || '',
                xp:              ws.userData.xp        || 0,
                unlocked_achievements: ws.userData.unlocked_achievements || [],
                claimed_ranks:         ws.userData.claimed_ranks || [],
                claimed_xp_cycles:     ws.userData.claimed_xp_cycles || [],
                claimed_achievements:  ws.userData.claimed_achievements || [],
                vip_temp_until:  ws.userData.vip_temp_until || 0,
                purchased_items: clientItems,
                canvas_w:        CANVAS_WIDTH,
                canvas_h:        CANVAS_HEIGHT,
                settings:        serverSettings,
                stencil:         ws.userData.active_stencil,
                saved_stencils:  ws.userData.saved_stencils,
                friends:              ws.userData.friends              || [],
                friend_requests_in:   ws.userData.friend_requests_in   || [],
                friend_requests_out:  ws.userData.friend_requests_out  || [],
                cooldown_boost:  (ws.userData.cooldownBoostUntil > Date.now()) ? { pct: ws.userData.cooldownBoostPct, until: ws.userData.cooldownBoostUntil } : null,
                server_now: Date.now(),
              }));
              broadcastOnlineCount();
              notifyFriendsPresence(ws.userData.username, true);
              sendCanvasSnapshot(ws);
              return;

            } catch(e) {
              console.error('Discord auth error:', e);
              ws.send(JSON.stringify({ action: 'toast', message: 'Ошибка сервера при Discord авторизации' }));
              return;
            }
          }
          // ── Обычная авторизация username+password ─────────
          ws.send(JSON.stringify({ action: 'toast', message: 'Вход возможен только через Discord' }));
          return;

          const username    = (data.username || '').trim();
          const password    = (data.password || '').trim();
          const email       = (data.email    || '').trim();
          const is_register = data.is_register;

          if (!username || !password) {
            ws.send(JSON.stringify({ action:'toast', message:'Пустые поля логина/пароля' })); return;
          }

          if (is_register) {
            const existing = await dbGetAccount(username);
            if (existing) { ws.send(JSON.stringify({ action:'toast', message:'Ник уже занят!' })); return; }
            let role = 'user';
            if ((username === 'd3cord' && email === 'otarasik10@gmail.com') || username === ADMIN_USERNAME) role = 'admin';
            const newUser = { username, password, email, role, pixels: 0, rank: 'Новичок', emoji: '👾', banned: false, timeout_until: 0, coins: 0, clan: '', inventory: {}, upgrades: [], cooldownBoostPct: 0, cooldownBoostUntil: 0, active_stencil: null, saved_stencils: [], friends: [], friend_requests_in: [], friend_requests_out: [], dm_reads: {}, banner_id: null, owned_banners: [], xp: 0, unlocked_achievements: [], claimed_ranks: [], claimed_xp_cycles: [], claimed_achievements: [] };
            await dbSaveAccount(username, newUser);
            ws.userData = { ...newUser };
          } else {
            const acc = await dbGetAccount(username);
            if (!acc) { ws.send(JSON.stringify({ action:'toast', message:'Аккаунт не найден!' })); return; }
            if (acc.password !== password) { ws.send(JSON.stringify({ action:'toast', message:'Неверный пароль!' })); return; }
            ws.userData = { ...acc, username };
          }

          if (username === 'd3cord' && ws.userData.email === 'otarasik10@gmail.com') ws.userData.role = 'admin';
          if (ws.userData.banned) { ws.send(JSON.stringify({ action:'toast', message:'Ваш аккаунт заблокирован!' })); return; }

          ws.isAuthorized = true;
          ws.userData.inventory = ws.userData.inventory || {};
          ws.userData.upgrades  = ws.userData.upgrades  || [];
          ws.userData.saved_stencils = ws.userData.saved_stencils || [];
          ws.userData.friends              = ws.userData.friends              || [];
          ws.userData.friend_requests_in   = ws.userData.friend_requests_in   || [];
          ws.userData.friend_requests_out  = ws.userData.friend_requests_out  || [];
          ws.userData.dm_reads             = ws.userData.dm_reads             || {};
          ws.userData.owned_banners        = ws.userData.owned_banners        || [];
          ws.userData.xp                   = ws.userData.xp                   || 0;
          ws.userData.unlocked_achievements = ws.userData.unlocked_achievements || [];
          ws.userData.claimed_ranks = ws.userData.claimed_ranks || [];
          ws.userData.claimed_achievements = ws.userData.claimed_achievements || [];
          ws.userData.vip_temp_until       = ws.userData.vip_temp_until       || 0;
          ws.userData.vip_temp_prev_role   = ws.userData.vip_temp_prev_role   || '';
          await revertExpiredTempVip(ws.userData.username, ws.userData);
          ws.userData.rank = getRank(ws.userData.xp).name;

          // Досчитываем задним числом уже выполненные ачивки (тихо, без тоста).
          checkAchievements(ws.userData.username, ws.userData, { silent: true }).catch(() => {});

          let clientItems = [...ws.userData.upgrades];
          for (let k in ws.userData.inventory) {
            for (let i = 0; i < ws.userData.inventory[k]; i++) clientItems.push(k);
          }

          ws.send(JSON.stringify({
            action:    'auth_success',
            username:  ws.userData.username,
            role:      ws.userData.role      || 'user',
            pixels:    ws.userData.pixels    || 0,
            rank:      ws.userData.rank      || 'Новичок',
            emoji:     ws.userData.emoji     || '👾',
            avatar:    getAvatarUrl(ws.userData),
            banner:          ws.userData.banner_id    || null,
            owned_banners:   ws.userData.owned_banners || [],
            banners_catalog: PROFILE_BANNERS,
            coins:     ws.userData.coins     || 0,
            clan:      ws.userData.clan      || '',
            xp:              ws.userData.xp        || 0,
            unlocked_achievements: ws.userData.unlocked_achievements || [],
            claimed_ranks:         ws.userData.claimed_ranks || [],
            claimed_xp_cycles:     ws.userData.claimed_xp_cycles || [],
            claimed_achievements:  ws.userData.claimed_achievements || [],
            vip_temp_until:  ws.userData.vip_temp_until || 0,
            purchased_items: clientItems,
            canvas_w:  CANVAS_WIDTH,
            canvas_h:  CANVAS_HEIGHT,
            settings:  serverSettings,
            stencil:   ws.userData.active_stencil,
            saved_stencils: ws.userData.saved_stencils,
            cooldown_boost: (ws.userData.cooldownBoostUntil > Date.now()) ? { pct: ws.userData.cooldownBoostPct, until: ws.userData.cooldownBoostUntil } : null,
            server_now: Date.now(),
            friends:              ws.userData.friends              || [],
            friend_requests_in:   ws.userData.friend_requests_in   || [],
            friend_requests_out:  ws.userData.friend_requests_out  || [],
          }));
          broadcastOnlineCount();
          notifyFriendsPresence(ws.userData.username, true);
          sendCanvasSnapshot(ws);
        }

        else if (action === 'save_personal_stencil') {
          if (!ws.isAuthorized) return;
          await dbSaveAccount(ws.userData.username, { active_stencil: data.stencil });
          ws.userData.active_stencil = data.stencil;
        }

        else if (action === 'save_stencil_preset') {
          if (!ws.isAuthorized || !data.stencil) return;
          const acc = await dbGetAccount(ws.userData.username);
          const stencils = acc.saved_stencils || [];
          stencils.push({ name: data.name || 'Без имени', stencil: data.stencil });
          await dbSaveAccount(ws.userData.username, { saved_stencils: stencils });
          ws.userData.saved_stencils = stencils;
          ws.send(JSON.stringify({ action: 'stencil_presets_update', stencils, message: 'Шаблон сохранен!' }));
        }

        else if (action === 'delete_stencil_preset') {
          if (!ws.isAuthorized || data.index === undefined) return;
          const acc = await dbGetAccount(ws.userData.username);
          let stencils = acc.saved_stencils || [];
          stencils.splice(data.index, 1);
          await dbSaveAccount(ws.userData.username, { saved_stencils: stencils });
          ws.userData.saved_stencils = stencils;
          ws.send(JSON.stringify({ action: 'stencil_presets_update', stencils }));
        }

        else if (action === 'get_leaderboard') {
          const persisted = await dbGetAllAccounts();
          // Mongo получает пиксели пакетами, поэтому сразу после бомбочки
          // в БД ещё может лежать старое значение. Поверх него накладываем
          // актуальный runtime-кэш — лидерборд обновляется мгновенно.
          const byUsername = new Map(persisted.map(a => [a.username, a]));
          Object.values(accounts).forEach(a => byUsername.set(a.username, { ...(byUsername.get(a.username) || {}), ...a }));
          const allAccs = Array.from(byUsername.values());
          // Лидерборд строится по опыту. При равном XP выше тот, кто поставил
          // больше пикселей; это делает порядок стабильным между обновлениями.
          const rankedPlayers = allAccs
            .map(a => ({ username: a.username, pixels: a.pixels||0, xp: a.xp||0, emoji: a.emoji||'👾', avatar: getAvatarUrl(a), banner: a.banner_id||null, rank: a.rank||'Новичок' }))
            .sort((a, b) => (b.xp - a.xp) || (b.pixels - a.pixels) || a.username.localeCompare(b.username));
          const meIndex = rankedPlayers.findIndex(player => player.username === ws.userData.username);
          const players = rankedPlayers.slice(0, 50).map((player, index) => ({ ...player, place: index + 1 }));
          const you = meIndex >= 0 ? { ...rankedPlayers[meIndex], place: meIndex + 1 } : null;
          const allClans = await dbGetAllClans();
          const clanTop  = allClans
            .filter(c => c.is_public !== false)
            .map(c => ({ name: c.name, tag: c.tag||'', icon: c.icon||'', tag_color: c.tag_color||'#818cf8', pixels: c.pixels||0, members: (c.members||[]).length,
                         banner_url: c.banner_url||null, banner_crop_x: c.banner_crop_x??0, banner_crop_y: c.banner_crop_y??0, banner_crop_w: c.banner_crop_w??1, banner_crop_h: c.banner_crop_h??1 }))
            .sort((a, b) => b.pixels - a.pixels).slice(0, 20);
          ws.send(JSON.stringify({ action: 'leaderboard_data', players, clans: clanTop, you }));
        }

        else if (action === 'cursor') {
          if (!ws.isAuthorized) return;
          // `isTrusted` нельзя считать абсолютной криптографической защитой,
          // но обычный console-бот с dispatchEvent(MouseEvent) не может
          // создать настоящее событие браузера и не должен обновлять proof.
          if (data.trusted !== true) return;
          const cursorX = Number(data.x), cursorY = Number(data.y);
          if (!Number.isInteger(cursorX) || !Number.isInteger(cursorY)
            || cursorX < 0 || cursorX >= CANVAS_WIDTH || cursorY < 0 || cursorY >= CANVAS_HEIGHT) return;
          // Публичные курсоры могут быть выключены, но доказательство
          // наведения остаётся локальным для этого сокета.
          if (!ws.lastHumanCursor || ws.lastHumanCursor.x !== cursorX || ws.lastHumanCursor.y !== cursorY) {
            ws.cursorMovesSincePixel++;
          }
          ws.lastHumanCursor = { x: cursorX, y: cursorY };
          ws.lastHumanCursorAt = Date.now();
          if (!serverSettings.cursorTrackingEnabled && !(ws.userData.clan && data.clan_only)) return;
          const msg = JSON.stringify({ action:'cursor', u:ws.userData.username, x:data.x, y:data.y, c:data.c, emoji:ws.userData.emoji||'👾', avatar:getAvatarUrl(ws.userData), clan:ws.userData.clan||'' });
          if (data.clan_only && ws.userData.clan) broadcastToClan(ws.userData.clan, msg, ws);
          else wss.clients.forEach(c => { if (c !== ws && c.readyState === 1 && c.isAuthorized) c.send(msg); });
        }

        else if (action === 'pixel_info') {
          if (!ws.isAuthorized) return;
          const px = data.x, py = data.y;
          if (typeof px !== 'number' || typeof py !== 'number') return;
          const owner = getPixelOwner(px, py);
          ws.send(JSON.stringify({
            action:   'pixel_info_result',
            x:        px,
            y:        py,
            username: owner?.username || null,
            emoji:    owner?.emoji    || null,
            avatar:   owner?.avatar   || null,
          }));
        }

        else if (action === 'save_emoji') {
          if (!ws.isAuthorized) return;
          ws.userData.emoji = data.emoji || '👾';
          await dbSaveAccount(ws.userData.username, { emoji: ws.userData.emoji });
          // Обновим emoji в таблице авторов пикселей
          const ownId = ownerIdMap.get(ws.userData.username);
          if (ownId) ownerDataMap.set(ownId, { username: ws.userData.username, emoji: ws.userData.emoji, avatar: getAvatarUrl(ws.userData) });
          ws.send(JSON.stringify({ action:'toast', message:'Аватар сохранён!' }));
        }

        else if (action === 'chat_send') {
          if (!ws.isAuthorized) return;
          const text = (data.text || '').trim().slice(0, 200);
          if (!text) return;
          const msg = { username: ws.userData.username, role: ws.userData.role || 'user', emoji: ws.userData.emoji || '👾', avatar: getAvatarUrl(ws.userData), text, ts: Date.now() };
          globalChatHistory.push(msg);
          if (globalChatHistory.length > CHAT_HISTORY_LIMIT) globalChatHistory.shift();
          broadcastAll(JSON.stringify({ action: 'chat_message', msg }));
        }

        else if (action === 'clan_chat_send') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const text = (data.text || '').trim().slice(0, 200);
          if (!text) return;
          const msg = { username: ws.userData.username, emoji: ws.userData.emoji||'👾', avatar: getAvatarUrl(ws.userData), text, ts: Date.now() };
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_chat_message', msg }), null);
        }

        // ══════════════════════════════════════════════════════
        //  СОЦИАЛЬНАЯ СЕТЬ: поиск людей, друзья, личные сообщения
        // ══════════════════════════════════════════════════════
        else if (action === 'user_search') {
          if (!ws.isAuthorized) return;
          const q = (data.query || '').trim().toLowerCase();
          if (!q) { ws.send(JSON.stringify({ action:'user_search_results', query:'', results:[] })); return; }
          const all = await dbGetAllAccounts();
          const me  = ws.userData;
          const results = all
            .filter(a => a.username && a.username !== me.username && a.username.toLowerCase().includes(q))
            .slice(0, 25)
            .map(a => userCard(a, {
              isFriend:        (me.friends || []).includes(a.username),
              requestSent:     (me.friend_requests_out || []).includes(a.username),
              requestReceived: (me.friend_requests_in  || []).includes(a.username),
            }));
          ws.send(JSON.stringify({ action:'user_search_results', query: data.query || '', results }));
        }

        else if (action === 'friends_get') {
          if (!ws.isAuthorized) return;
          await sendFriendsUpdate(ws.userData.username);
        }

        // ── Этап 3: публичный профиль ЛЮБОГО пользователя по имени ──
        // Раньше данные профиля брались только "про себя" из auth_success/
        // banner_update (глобальные currentUser/currentPixels/... в state.js).
        // Профиль теперь можно открыть по клику на любого юзера (лидерборд,
        // участники клана, чат, друзья) — нужен отдельный запрос-ответ,
        // который отдаёт ТОЛЬКО публичные поля (без пароля/email/монет
        // чужого аккаунта — правило приватности). userCard() уже строго
        // ограничен нужным набором полей — переиспользуем как есть.
        else if (action === 'profile_get') {
          if (!ws.isAuthorized) return;
          const uname = (data.username || '').trim();
          if (!uname) return;
          const acc = await dbGetAccount(uname);
          if (!acc) { ws.send(JSON.stringify({ action:'profile_data', username: uname, notFound: true })); return; }
          const me = ws.userData;
          let clanInfo = null;
          if (acc.clan) {
            const c = await dbGetClan(acc.clan);
            if (c) clanInfo = {
              name: c.name, tag: c.tag || '', icon: c.icon || '🏴', tag_color: c.tag_color || '#818cf8',
              banner_url: c.banner_url || null,
              banner_crop_x: c.banner_crop_x ?? 0, banner_crop_y: c.banner_crop_y ?? 0,
              banner_crop_w: c.banner_crop_w ?? 1, banner_crop_h: c.banner_crop_h ?? 1,
              members: (c.members || []).length, pixels: c.pixels || 0,
            };
          }
          ws.send(JSON.stringify({
            action: 'profile_data',
            isSelf: uname === me.username,
            ...userCard(acc, {
              clanInfo,
              isFriend:        (me.friends || []).includes(acc.username),
              requestSent:     (me.friend_requests_out || []).includes(acc.username),
              requestReceived: (me.friend_requests_in  || []).includes(acc.username),
              owned_banners:   acc.owned_banners || [],
              // ── Этап 4: публичные ачивки + прогресс звания ──
              // xp/unlocked_achievements не приватны (в отличие от coins/email) —
              // это витрина достижений, её можно смотреть в чужом профиле.
              xp:                    acc.xp || 0,
              unlocked_achievements: acc.unlocked_achievements || [],
              purchased_count:       (acc.upgrades || []).length + Object.values(acc.inventory || {}).reduce((a,b)=>a+b,0),
              friends_count:         (acc.friends || []).length,
            }),
          }));
        }

        else if (action === 'friend_request') {
          if (!ws.isAuthorized) return;
          const target = (data.to || '').trim();
          const me = ws.userData.username;
          if (!target || target === me) return;
          const targetAcc = await dbGetAccount(target);
          if (!targetAcc) { ws.send(JSON.stringify({ action:'toast', message:'Пользователь не найден' })); return; }
          const meAcc = await dbGetAccount(me);
          if ((meAcc.friends || []).includes(target)) { ws.send(JSON.stringify({ action:'toast', message:'Вы уже друзья' })); return; }
          if ((meAcc.friend_requests_out || []).includes(target)) { ws.send(JSON.stringify({ action:'toast', message:'Заявка уже отправлена' })); return; }

          // Встречная заявка — если target уже приглашал нас, сразу дружим
          if ((meAcc.friend_requests_in || []).includes(target)) {
            const meFriends = Array.from(new Set([...(meAcc.friends || []), target]));
            const meIn      = (meAcc.friend_requests_in || []).filter(u => u !== target);
            await dbSaveAccount(me, { friends: meFriends, friend_requests_in: meIn });
            ws.userData.friends = meFriends; ws.userData.friend_requests_in = meIn;

            const tFriends = Array.from(new Set([...(targetAcc.friends || []), me]));
            const tOut     = (targetAcc.friend_requests_out || []).filter(u => u !== me);
            await dbSaveAccount(target, { friends: tFriends, friend_requests_out: tOut });

            await sendFriendsUpdate(me);
            await sendFriendsUpdate(target);
            sendToUser(target, { action:'toast', message:`✅ ${me} теперь у вас в друзьях!`, type:'success' });
            ws.send(JSON.stringify({ action:'toast', message:`✅ Вы подружились с ${target}!`, type:'success' }));
            return;
          }

          const meOut = Array.from(new Set([...(meAcc.friend_requests_out || []), target]));
          await dbSaveAccount(me, { friend_requests_out: meOut });
          ws.userData.friend_requests_out = meOut;

          const tIn = Array.from(new Set([...(targetAcc.friend_requests_in || []), me]));
          await dbSaveAccount(target, { friend_requests_in: tIn });

          await sendFriendsUpdate(me);
          await sendFriendsUpdate(target);
          sendToUser(target, { action:'toast', message:`👋 ${me} хочет добавить вас в друзья`, type:'info' });
        }

        else if (action === 'friend_accept') {
          if (!ws.isAuthorized) return;
          const from = (data.from || '').trim();
          const me   = ws.userData.username;
          const meAcc = await dbGetAccount(me);
          if (!from || !(meAcc.friend_requests_in || []).includes(from)) return;
          const fromAcc = await dbGetAccount(from);

          const meFriends = Array.from(new Set([...(meAcc.friends || []), from]));
          const meIn      = (meAcc.friend_requests_in || []).filter(u => u !== from);
          await dbSaveAccount(me, { friends: meFriends, friend_requests_in: meIn });
          ws.userData.friends = meFriends; ws.userData.friend_requests_in = meIn;

          if (fromAcc) {
            const fFriends = Array.from(new Set([...(fromAcc.friends || []), me]));
            const fOut     = (fromAcc.friend_requests_out || []).filter(u => u !== me);
            await dbSaveAccount(from, { friends: fFriends, friend_requests_out: fOut });
          }

          await sendFriendsUpdate(me);
          await sendFriendsUpdate(from);
          sendToUser(from, { action:'toast', message:`✅ ${me} принял(а) вашу заявку в друзья!`, type:'success' });

          ws.userData.friends = meFriends;
          checkAchievements(me, ws.userData).catch(() => {});
          dbGetAccount(from).then(a => a && checkAchievements(from, a)).catch(() => {});
        }

        else if (action === 'friend_decline') {
          if (!ws.isAuthorized) return;
          const from = (data.from || '').trim();
          const me   = ws.userData.username;
          const meAcc = await dbGetAccount(me);
          const meIn  = (meAcc.friend_requests_in || []).filter(u => u !== from);
          await dbSaveAccount(me, { friend_requests_in: meIn });
          ws.userData.friend_requests_in = meIn;

          const fromAcc = await dbGetAccount(from);
          if (fromAcc) {
            const fOut = (fromAcc.friend_requests_out || []).filter(u => u !== me);
            await dbSaveAccount(from, { friend_requests_out: fOut });
          }
          await sendFriendsUpdate(me);
          await sendFriendsUpdate(from);
        }

        else if (action === 'friend_cancel') {
          if (!ws.isAuthorized) return;
          const to  = (data.to || '').trim();
          const me  = ws.userData.username;
          const meAcc = await dbGetAccount(me);
          const meOut = (meAcc.friend_requests_out || []).filter(u => u !== to);
          await dbSaveAccount(me, { friend_requests_out: meOut });
          ws.userData.friend_requests_out = meOut;

          const toAcc = await dbGetAccount(to);
          if (toAcc) {
            const tIn = (toAcc.friend_requests_in || []).filter(u => u !== me);
            await dbSaveAccount(to, { friend_requests_in: tIn });
          }
          await sendFriendsUpdate(me);
          await sendFriendsUpdate(to);
        }

        else if (action === 'friend_remove') {
          if (!ws.isAuthorized) return;
          const target = (data.username || '').trim();
          const me = ws.userData.username;
          const meAcc = await dbGetAccount(me);
          const meFriends = (meAcc.friends || []).filter(u => u !== target);
          await dbSaveAccount(me, { friends: meFriends });
          ws.userData.friends = meFriends;

          const tAcc = await dbGetAccount(target);
          if (tAcc) {
            const tFriends = (tAcc.friends || []).filter(u => u !== me);
            await dbSaveAccount(target, { friends: tFriends });
          }
          await sendFriendsUpdate(me);
          await sendFriendsUpdate(target);
        }

        else if (action === 'dm_send') {
          if (!ws.isAuthorized) return;
          const to   = (data.to || '').trim();
          const me   = ws.userData.username;
          const text = (data.text || '').trim().slice(0, 1000);
          if (!to || !text || to === me) return;
          const toAcc = await dbGetAccount(to);
          if (!toAcc) { ws.send(JSON.stringify({ action:'toast', message:'Пользователь не найден' })); return; }
          const msg = { from: me, text, ts: Date.now() };
          await dbAppendDMMessage(me, to, msg);
          sendToUser(me, { action:'dm_message', peer: to, msg });
          sendToUser(to,  { action:'dm_message', peer: me, msg });
        }

        else if (action === 'typing') {
          if (!ws.isAuthorized) return;
          const me = ws.userData.username;
          const to = (data.to || '').trim();
          if (to) {
            sendToUser(to, { action:'typing', from: me, channel:false });
          } else {
            const msg = JSON.stringify({ action:'typing', from: me, channel:true });
            wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized && c !== ws) c.send(msg); });
          }
        }

        else if (action === 'dm_history') {
          if (!ws.isAuthorized) return;
          const withUser = (data.with || '').trim();
          const me = ws.userData.username;
          if (!withUser) return;
          const thread = await dbGetDMThread(me, withUser);
          ws.send(JSON.stringify({ action:'dm_history_data', with: withUser, messages: thread.messages || [] }));
        }

        else if (action === 'dm_mark_read') {
          if (!ws.isAuthorized) return;
          const withUser = (data.with || '').trim();
          if (!withUser) return;
          const reads = { ...(ws.userData.dm_reads || {}), [withUser]: Date.now() };
          ws.userData.dm_reads = reads;
          await dbSaveAccount(ws.userData.username, { dm_reads: reads });
        }

        else if (action === 'dm_conversations') {
          if (!ws.isAuthorized) return;
          const me = ws.userData.username;
          const meAcc = await dbGetAccount(me);
          const partners = new Set([...(meAcc.friends || []), ...(await dbGetDMPartners(me))]);
          const reads = meAcc.dm_reads || {};
          const list = [];
          for (const p of partners) {
            const pAcc = await dbGetAccount(p);
            if (!pAcc) continue;
            const thread   = await dbGetDMThread(me, p);
            const messages = thread.messages || [];
            const last     = messages[messages.length - 1] || null;
            const lastRead = reads[p] || 0;
            const unread   = messages.filter(m => m.from === p && m.ts > lastRead).length;
            list.push({
              ...userCard(pAcc),
              lastMessage: last ? last.text : '',
              lastFrom:    last ? last.from : '',
              lastTs:      last ? last.ts : 0,
              unread,
            });
          }
          list.sort((a, b) => b.lastTs - a.lastTs);
          ws.send(JSON.stringify({ action:'dm_conversations_data', conversations: list }));
        }

        else if (action === 'online_users_get') {
          if (!ws.isAuthorized) return;
          ws.send(JSON.stringify({ action:'online_users_data', users: getOnlineUsersSnapshot(ws.userData.username) }));
        }

        else if (action === 'clan_create') {
          if (!ws.isAuthorized) return;
          const { name, tag, description } = data;
          if (!name || name.length < 2 || name.length > 24) { ws.send(JSON.stringify({ action:'toast', message:'Название клана: 2–24 символа' })); return; }
          const existing = await dbGetClan(name);
          if (existing) { ws.send(JSON.stringify({ action:'toast', message:'Клан с таким именем уже есть!' })); return; }
          const acc = await dbGetAccount(ws.userData.username);
          if ((acc.coins || 0) < 50) { ws.send(JSON.stringify({ action:'toast', message:'Нужно 50 монет для создания клана!' })); return; }
          if (acc.clan) { ws.send(JSON.stringify({ action:'toast', message:'Сначала покиньте текущий клан' })); return; }

          const newCoins = (acc.coins - 50);
          await dbSaveAccount(ws.userData.username, { coins: newCoins, clan: name });
          ws.userData.coins = newCoins; ws.userData.clan = name;
          await dbSaveClan(name, { 
             name, tag: tag||name.slice(0,4).toUpperCase(), description: description||'', 
             message_of_day:'', leader: ws.userData.username, members:[ws.userData.username], 
             join_requests:[], pixels:0, share_cursor:false, active_stencil:null, shared_stencil:null, shared_stencils:[],
             icon: '🏴', tag_color: '#818cf8', join_type: 'open', min_pixels: 0, is_public: true, social_link: '',
             banner_url: null, banner_crop_x: 0, banner_crop_y: 0, banner_crop_w: 1, banner_crop_h: 1,
             ranks: defaultClanRanks(), member_roles: {},
             treasury: 0, treasury_log: [], shop_items: [], member_limit: CLAN_BASE_MEMBER_LIMIT
          });
          ws.send(JSON.stringify({ action:'clan_update', clan: await dbGetClan(name), coins: ws.userData.coins, message:`Клан "${name}" создан!` }));
          checkAchievements(ws.userData.username, ws.userData).catch(() => {});
        }

        else if (action === 'clan_join') {
          if (!ws.isAuthorized) return;
          const { name } = data;
          const clan = await dbGetClan(name);
          if (!clan) { ws.send(JSON.stringify({ action:'toast', message:'Клан не найден' })); return; }
          const acc = await dbGetAccount(ws.userData.username);
          if (acc.clan) { ws.send(JSON.stringify({ action:'toast', message:'Сначала покиньте текущий клан' })); return; }
          
          if (clan.join_type === 'closed') { ws.send(JSON.stringify({ action:'toast', message:'Вступление в клан закрыто' })); return; }
          if ((acc.pixels || 0) < (clan.min_pixels || 0)) { ws.send(JSON.stringify({ action:'toast', message:`Нужно минимум ${clan.min_pixels} пикселей` })); return; }
          if ((clan.members||[]).length >= clanCurrentMemberLimit(clan)) { ws.send(JSON.stringify({ action:'toast', message:'Клан заполнен — достигнут лимит участников' })); return; }
          
          if (clan.join_type === 'request') {
             if ((clan.join_requests||[]).includes(ws.userData.username)) { ws.send(JSON.stringify({ action:'toast', message:'Заявка уже отправлена' })); return; }
             const reqs = [...(clan.join_requests||[]), ws.userData.username];
             await dbSaveClan(name, { join_requests: reqs });
             broadcastToClan(name, JSON.stringify({ action:'clan_join_request_in', username:ws.userData.username, clanName:name }), null);
             ws.send(JSON.stringify({ action:'toast', message:`Заявка на вступление отправлена` }));
             return;
          }

          const newMembers = [...(clan.members||[]), ws.userData.username];
          await dbSaveClan(name, { members: newMembers });
          await dbSaveAccount(ws.userData.username, { clan: name });
          ws.userData.clan = name;
          ws.send(JSON.stringify({ action:'clan_update', clan:{...clan, members:newMembers}, coins:ws.userData.coins, message:`Вы вступили в клан "${name}"!` }));
          broadcastToClan(name, JSON.stringify({ action:'clan_member_joined', username:ws.userData.username }), ws);
          checkAchievements(ws.userData.username, ws.userData).catch(() => {});
        }

        else if (action === 'clan_update_settings') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || !clanHasPerm(clan, ws.userData.username, 'manage_settings')) { ws.send(JSON.stringify({ action:'toast', message:'Нет прав' })); return; }

          const settings = data.settings || {};

          // ── Баннер клана доступен только после покупки в «Магазине клана» ──
          // banner_static открывает статичные баннеры (jpg/png/webp-статик),
          // banner_animated — дополнительно открывает анимированные (gif/webp/apng).
          // Сама смена баннера бесплатна — платится один раз за товар в магазине.
          const newBannerUrl = settings.banner_url || null;
          const bannerChanged = newBannerUrl !== (clan.banner_url || null);
          let finalBannerUrl = clan.banner_url || null;
          let finalCropX = clan.banner_crop_x ?? 0, finalCropY = clan.banner_crop_y ?? 0,
              finalCropW = clan.banner_crop_w ?? 1, finalCropH = clan.banner_crop_h ?? 1;

          if (bannerChanged) {
            const owned = clan.shop_items || [];
            if (!newBannerUrl) {
              // Снятие баннера — всегда разрешено.
              finalBannerUrl = null;
            } else if (isAnimatedBannerUrl(newBannerUrl) && !owned.includes('banner_animated')) {
              ws.send(JSON.stringify({ action:'toast', message:'Анимированный баннер нужно купить в магазине клана (500 монет)' }));
            } else if (!isAnimatedBannerUrl(newBannerUrl) && !owned.includes('banner_static') && !owned.includes('banner_animated')) {
              ws.send(JSON.stringify({ action:'toast', message:'Баннер клана нужно купить в магазине клана (200 монет)' }));
            } else {
              finalBannerUrl = newBannerUrl;
              finalCropX = Number.isFinite(Number(settings.banner_crop_x)) ? Math.max(0, Math.min(1, Number(settings.banner_crop_x))) : 0;
              finalCropY = Number.isFinite(Number(settings.banner_crop_y)) ? Math.max(0, Math.min(1, Number(settings.banner_crop_y))) : 0;
              finalCropW = Number.isFinite(Number(settings.banner_crop_w)) ? Math.max(0.02, Math.min(1, Number(settings.banner_crop_w))) : 1;
              finalCropH = Number.isFinite(Number(settings.banner_crop_h)) ? Math.max(0.02, Math.min(1, Number(settings.banner_crop_h))) : 1;
            }
          }

          const update = {
             icon: settings.icon || '🏴',
             tag_color: settings.tag_color || '#818cf8',
             join_type: settings.join_type || 'open',
             min_pixels: parseInt(settings.min_pixels) || 0,
             is_public: !!settings.is_public,
             share_cursor: !!settings.share_cursor,
             social_link: settings.social_link || '',
             message_of_day: (settings.message_of_day || '').slice(0, 200),
             banner_url: finalBannerUrl,
             banner_crop_x: finalCropX,
             banner_crop_y: finalCropY,
             banner_crop_w: finalCropW,
             banner_crop_h: finalCropH,
          };
          
          await dbSaveClan(ws.userData.clan, update);
          const newClanData = await dbGetClan(ws.userData.clan);
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: newClanData }), null);
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_settings_update', share_cursor: update.share_cursor }), null);
          ws.send(JSON.stringify({ action:'toast', message:'Настройки клана сохранены', type:'success' }));
        }

        // ── МАГАЗИН КЛАНА: покупка баннеров / расширения лимита участников ──
        // Покупки оплачиваются ТОЛЬКО из казны клана (валюта клана), доступно
        // только участникам с правом «Казна» (manage_treasury).
        else if (action === 'clan_shop_buy') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan) return;
          if (!clanHasPerm(clan, ws.userData.username, 'manage_treasury')) {
            ws.send(JSON.stringify({ action:'toast', message:'Нет права «Казна» для покупок в магазине клана' })); return;
          }

          const itemId = data.item_id;
          const owned  = clan.shop_items || [];

          const bannerItem = CLAN_SHOP_ITEMS.find(i => i.id === itemId);
          const tierItem    = CLAN_MEMBER_LIMIT_TIERS.find(t => t.id === itemId);
          const item = bannerItem || tierItem;
          if (!item) { ws.send(JSON.stringify({ action:'toast', message:'Товар не найден' })); return; }
          if (owned.includes(itemId)) { ws.send(JSON.stringify({ action:'toast', message:'Уже куплено' })); return; }

          if (bannerItem) {
            if (bannerItem.requires && !owned.includes(bannerItem.requires)) {
              ws.send(JSON.stringify({ action:'toast', message:'Сначала купите предыдущий товар' })); return;
            }
          } else {
            // Тир лимита участников можно купить только по порядку (нельзя перескочить).
            const curLimit = clanCurrentMemberLimit(clan);
            const sorted = [...CLAN_MEMBER_LIMIT_TIERS].sort((a,b) => a.limit - b.limit);
            const nextTier = sorted.find(t => t.limit > curLimit);
            if (!nextTier || nextTier.id !== itemId) {
              ws.send(JSON.stringify({ action:'toast', message:'Тиры лимита участников покупаются по порядку' })); return;
            }
          }

          if ((clan.treasury || 0) < item.cost) {
            ws.send(JSON.stringify({ action:'toast', message:'В казне клана недостаточно монет' })); return;
          }
          const newTreasury = (clan.treasury || 0) - item.cost;
          const log = [{ username: ws.userData.username, amount: -item.cost, text: `${ws.userData.username} купил(а) товар клана за ${item.cost}🪙`, time: Date.now() }, ...(clan.treasury_log || [])].slice(0, 200);
          const newShopItems = [...owned, itemId];
          const patch = { treasury: newTreasury, treasury_log: log, shop_items: newShopItems };
          if (tierItem) patch.member_limit = tierItem.limit;
          await dbSaveClan(ws.userData.clan, patch);

          const freshClan = await dbGetClan(ws.userData.clan);
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: freshClan }), null);
          ws.send(JSON.stringify({ action:'toast', message: tierItem ? `Лимит участников увеличен до ${tierItem.limit}!` : 'Покупка совершена!', type:'success' }));
        }

        // ── КАЗНА КЛАНА: пополнение (доступно всем участникам) ──
        else if (action === 'clan_treasury_deposit') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const amount = Math.floor(Number(data.amount));
          if (!Number.isFinite(amount) || amount <= 0) { ws.send(JSON.stringify({ action:'toast', message:'Некорректная сумма' })); return; }
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan) return;
          const acc = await dbGetAccount(ws.userData.username);
          if ((acc.coins || 0) < amount) { ws.send(JSON.stringify({ action:'toast', message:'Недостаточно монет' })); return; }

          const newCoins = (acc.coins || 0) - amount;
          await dbSaveAccount(ws.userData.username, { coins: newCoins });
          ws.userData.coins = newCoins;
          ws.send(JSON.stringify({ action:'coins_update', coins: newCoins, pixels: acc.pixels || 0 }));

          const newTreasury = (clan.treasury || 0) + amount;
          const log = [{ username: ws.userData.username, amount, text: `${ws.userData.username} пополнил(а) казну на ${amount}🪙`, time: Date.now() }, ...(clan.treasury_log || [])].slice(0, 200);
          await dbSaveClan(ws.userData.clan, { treasury: newTreasury, treasury_log: log });

          const freshClan = await dbGetClan(ws.userData.clan);
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: freshClan }), null);
          ws.send(JSON.stringify({ action:'toast', message:`Казна пополнена на ${amount}🪙`, type:'success' }));
        }

        // ── КАЗНА КЛАНА: снятие (только по праву manage_treasury) ──
        else if (action === 'clan_treasury_withdraw') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const amount = Math.floor(Number(data.amount));
          if (!Number.isFinite(amount) || amount <= 0) { ws.send(JSON.stringify({ action:'toast', message:'Некорректная сумма' })); return; }
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || !clanHasPerm(clan, ws.userData.username, 'manage_treasury')) {
            ws.send(JSON.stringify({ action:'toast', message:'Нет права «Казна» для снятия средств' })); return;
          }
          if ((clan.treasury || 0) < amount) { ws.send(JSON.stringify({ action:'toast', message:'В казне недостаточно монет' })); return; }

          const newTreasury = (clan.treasury || 0) - amount;
          const log = [{ username: ws.userData.username, amount: -amount, text: `${ws.userData.username} снял(а) ${amount}🪙 из казны`, time: Date.now() }, ...(clan.treasury_log || [])].slice(0, 200);
          await dbSaveClan(ws.userData.clan, { treasury: newTreasury, treasury_log: log });

          const acc = await dbGetAccount(ws.userData.username);
          const newCoins = (acc.coins || 0) + amount;
          await dbSaveAccount(ws.userData.username, { coins: newCoins });
          ws.userData.coins = newCoins;
          ws.send(JSON.stringify({ action:'coins_update', coins: newCoins, pixels: acc.pixels || 0 }));

          const freshClan = await dbGetClan(ws.userData.clan);
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: freshClan }), null);
          ws.send(JSON.stringify({ action:'toast', message:`Снято ${amount}🪙 из казны`, type:'success' }));
        }

        else if (action === 'clan_set_motd') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || !clanHasPerm(clan, ws.userData.username, 'edit_motd')) { ws.send(JSON.stringify({ action:'toast', message:'Нет прав на изменение сообщения дня' })); return; }
          const motd = (data.motd || '').trim().slice(0, 200);
          await dbSaveClan(ws.userData.clan, { message_of_day: motd });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: await dbGetClan(ws.userData.clan) }), ws);
        }

        else if (action === 'clan_get_requests') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (clan && clanHasPerm(clan, ws.userData.username, 'invite')) {
            // Карточки заявителей (аватар/эмодзи/ранг/баннер) — тот же принцип,
            // что и member_cards, чтобы карточка заявки выглядела как везде
            // (лидерборд/список участников), а не голым именем.
            const reqCards = {};
            await Promise.all((clan.join_requests || []).map(async (u) => {
              const acc = await dbGetAccount(u);
              if (acc) reqCards[u] = { emoji: acc.emoji || '👾', avatar: getAvatarUrl(acc), rank: acc.rank || 'Новичок', banner: acc.banner_id || null };
            }));
            ws.send(JSON.stringify({ action: 'clan_requests', requests: clan.join_requests || [], request_cards: reqCards }));
          }
        }

        else if (action === 'clan_accept_request') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const target = data.username;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || !clanHasPerm(clan, ws.userData.username, 'invite')) return;
          if ((clan.members||[]).length >= clanCurrentMemberLimit(clan)) { ws.send(JSON.stringify({ action:'toast', message:'Клан заполнен — достигнут лимит участников' })); return; }
          const requests = (clan.join_requests||[]).filter(r => r !== target);
          const newMembers = [...(clan.members||[]), target];
          await dbSaveClan(ws.userData.clan, { members: newMembers, join_requests: requests });
          await dbSaveAccount(target, { clan: ws.userData.clan });
          
          wss.clients.forEach(c => {
            if (c.isAuthorized && c.userData?.username === target) {
              c.userData.clan = ws.userData.clan;
              c.send(JSON.stringify({ action:'clan_update', clan:{...clan, members:newMembers}, message:`Вас приняли в клан "${ws.userData.clan}"!` }));
            }
          });
          ws.send(JSON.stringify({ action:'toast', message:`${target} принят в клан` }));
          ws.send(JSON.stringify({ action:'clan_requests', requests }));
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: await dbGetClan(ws.userData.clan) }), ws);
        }

        else if (action === 'clan_deny_request') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const target = data.username;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || !clanHasPerm(clan, ws.userData.username, 'invite')) return;
          const requests = (clan.join_requests||[]).filter(r => r !== target);
          await dbSaveClan(ws.userData.clan, { join_requests: requests });
          ws.send(JSON.stringify({ action:'toast', message:`Заявка от ${target} отклонена` }));
          ws.send(JSON.stringify({ action:'clan_requests', requests }));
        }

        else if (action === 'clan_kick') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const targetUser = data.username || data.target;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || targetUser === ws.userData.username || targetUser === clan.leader) return;
          if (!clanHasPerm(clan, ws.userData.username, 'kick')) { ws.send(JSON.stringify({ action:'toast', message:'Нет прав на исключение' })); return; }
          // Нельзя исключить участника с равным или более высоким званием
          if (clanPriorityOf(clan, targetUser) >= clanPriorityOf(clan, ws.userData.username)) {
            ws.send(JSON.stringify({ action:'toast', message:'Нельзя исключить участника с таким же или более высоким званием' })); return;
          }
          const newMembers = (clan.members||[]).filter(m => m !== targetUser);
          const newRoles = { ...(clan.member_roles||{}) }; delete newRoles[targetUser];
          await dbSaveClan(ws.userData.clan, { members: newMembers, member_roles: newRoles });
          await dbSaveAccount(targetUser, { clan: '' });
          await clearClanStencilIfOwner(ws.userData.clan, targetUser);
          wss.clients.forEach(c => {
            if (c.isAuthorized && c.userData?.username === targetUser) {
              c.userData.clan = '';
              c.send(JSON.stringify({ action:'clan_update', clan:null, message:'Вас исключили из клана' }));
            }
          });
          ws.send(JSON.stringify({ action:'toast', message:`${targetUser} исключён из клана` }));
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: await dbGetClan(ws.userData.clan) }), ws);
        }

        // ── ЗВАНИЯ КЛАНА ──
        else if (action === 'clan_rank_create') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || !clanHasPerm(clan, ws.userData.username, 'manage_ranks')) { ws.send(JSON.stringify({ action:'toast', message:'Нет прав на управление званиями' })); return; }
          const myPriority = clanPriorityOf(clan, ws.userData.username);
          const name = (data.name || '').trim().slice(0, 20);
          if (!name) { ws.send(JSON.stringify({ action:'toast', message:'Введите название звания' })); return; }
          if (clan.ranks.length >= 12) { ws.send(JSON.stringify({ action:'toast', message:'Максимум 12 званий в клане' })); return; }
          let priority = Math.max(1, Math.min(99, parseInt(data.priority) || 1));
          if (priority >= myPriority) priority = Math.max(1, myPriority - 1);
          const perms = emptyClanPermissions();
          for (const k of CLAN_PERMISSION_KEYS) if (data.permissions && data.permissions[k] && priority < myPriority) perms[k] = true;
          const newRank = {
            id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name, icon: (data.icon || '⭐').slice(0, 8), color: /^#[0-9a-fA-F]{6}$/.test(data.color) ? data.color : '#818cf8',
            priority, permissions: perms,
          };
          const newRanks = [...clan.ranks, newRank];
          await dbSaveClan(ws.userData.clan, { ranks: newRanks });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: await dbGetClan(ws.userData.clan) }), null);
          ws.send(JSON.stringify({ action:'toast', message:`Звание "${name}" создано`, type:'success' }));
        }

        else if (action === 'clan_rank_update') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || !clanHasPerm(clan, ws.userData.username, 'manage_ranks')) { ws.send(JSON.stringify({ action:'toast', message:'Нет прав на управление званиями' })); return; }
          const myPriority = clanPriorityOf(clan, ws.userData.username);
          const rank = clan.ranks.find(r => r.id === data.id);
          if (!rank) return;
          if (rank.id !== 'leader' && rank.priority >= myPriority) { ws.send(JSON.stringify({ action:'toast', message:'Нельзя редактировать звание не ниже своего' })); return; }
          if (data.name) rank.name = String(data.name).trim().slice(0, 20) || rank.name;
          if (data.icon) rank.icon = String(data.icon).slice(0, 8);
          if (/^#[0-9a-fA-F]{6}$/.test(data.color)) rank.color = data.color;
          if (!rank.isLeader) {
            if (data.priority !== undefined && rank.id !== 'member') {
              let p = Math.max(1, Math.min(99, parseInt(data.priority) || rank.priority));
              if (p >= myPriority) p = Math.max(1, myPriority - 1);
              rank.priority = p;
            }
            if (data.permissions) {
              const perms = emptyClanPermissions();
              for (const k of CLAN_PERMISSION_KEYS) if (data.permissions[k]) perms[k] = true;
              rank.permissions = perms;
            }
          }
          await dbSaveClan(ws.userData.clan, { ranks: clan.ranks });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: await dbGetClan(ws.userData.clan) }), null);
          ws.send(JSON.stringify({ action:'toast', message:'Звание обновлено', type:'success' }));
        }

        else if (action === 'clan_rank_delete') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || !clanHasPerm(clan, ws.userData.username, 'manage_ranks')) { ws.send(JSON.stringify({ action:'toast', message:'Нет прав на управление званиями' })); return; }
          const rank = clan.ranks.find(r => r.id === data.id);
          if (!rank || rank.isDefault) { ws.send(JSON.stringify({ action:'toast', message:'Это звание нельзя удалить' })); return; }
          if (rank.priority >= clanPriorityOf(clan, ws.userData.username)) { ws.send(JSON.stringify({ action:'toast', message:'Нельзя удалить звание не ниже своего' })); return; }
          const newRanks = clan.ranks.filter(r => r.id !== data.id);
          const newRoles = { ...clan.member_roles };
          for (const u in newRoles) if (newRoles[u] === data.id) delete newRoles[u];
          await dbSaveClan(ws.userData.clan, { ranks: newRanks, member_roles: newRoles });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: await dbGetClan(ws.userData.clan) }), null);
          ws.send(JSON.stringify({ action:'toast', message:`Звание "${rank.name}" удалено`, type:'success' }));
        }

        else if (action === 'clan_rank_assign') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const target = data.username;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || !target || target === clan.leader) return;
          if (!clanHasPerm(clan, ws.userData.username, 'manage_ranks')) { ws.send(JSON.stringify({ action:'toast', message:'Нет прав на выдачу званий' })); return; }
          if (!(clan.members || []).includes(target)) return;
          const myPriority = clanPriorityOf(clan, ws.userData.username);
          const targetRank = clanFindRank(clan, data.rankId);
          if (!targetRank || targetRank.id === 'leader') { ws.send(JSON.stringify({ action:'toast', message:'Недопустимое звание' })); return; }
          if (targetRank.priority >= myPriority) { ws.send(JSON.stringify({ action:'toast', message:'Нельзя выдать звание не ниже своего' })); return; }
          if (clanPriorityOf(clan, target) >= myPriority) { ws.send(JSON.stringify({ action:'toast', message:'Нельзя менять звание участника не ниже себя' })); return; }
          const newRoles = { ...clan.member_roles, [target]: targetRank.id };
          if (targetRank.id === 'member') delete newRoles[target];
          await dbSaveClan(ws.userData.clan, { member_roles: newRoles });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: await dbGetClan(ws.userData.clan) }), null);
          ws.send(JSON.stringify({ action:'toast', message:`${target} теперь ${targetRank.icon} ${targetRank.name}`, type:'success' }));
        }

        else if (action === 'clan_transfer_leadership') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const target = data.username;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || clan.leader !== ws.userData.username || !target || target === ws.userData.username) return;
          if (!(clan.members || []).includes(target)) { ws.send(JSON.stringify({ action:'toast', message:'Участник не найден в клане' })); return; }
          const newRoles = { ...clan.member_roles };
          delete newRoles[target];
          newRoles[ws.userData.username] = 'member';
          await dbSaveClan(ws.userData.clan, { leader: target, member_roles: newRoles });
          wss.clients.forEach(c => { if (c.isAuthorized && c.userData?.clan === ws.userData.clan) c.send(JSON.stringify({ action:'toast', message:`👑 ${target} теперь лидер клана!`, type:'success' })); });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: await dbGetClan(ws.userData.clan) }), null);
          ws.send(JSON.stringify({ action:'clan_data', clan: await dbGetClan(ws.userData.clan) }));
        }

        else if (action === 'clan_leave') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clanName = ws.userData.clan;
          const clan     = await dbGetClan(clanName);
          if (!clan) return;
          const newMembers = (clan.members||[]).filter(m => m !== ws.userData.username);
          const newRoles = { ...(clan.member_roles||{}) }; delete newRoles[ws.userData.username];
          if (newMembers.length === 0) {
            await dbDeleteClan(clanName);
          } else {
            let newLeader = clan.leader;
            if (clan.leader === ws.userData.username) {
              // Лидерство переходит участнику с наивысшим приоритетом звания (со-руководителю),
              // а не случайному первому в списке.
              newLeader = newMembers.slice().sort((a, b) => clanPriorityOf(clan, b) - clanPriorityOf(clan, a))[0];
              delete newRoles[newLeader];
            }
            await dbSaveClan(clanName, { members: newMembers, leader: newLeader, member_roles: newRoles });
            broadcastToClan(clanName, JSON.stringify({ action:'clan_data', clan: await dbGetClan(clanName) }), ws);
          }
          await dbSaveAccount(ws.userData.username, { clan: '' });
          await clearClanStencilIfOwner(clanName, ws.userData.username);
          ws.userData.clan = '';
          ws.send(JSON.stringify({ action:'clan_update', clan:null, message:'Вы покинули клан' }));
        }


        else if (action === 'clan_disband') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clanName = ws.userData.clan;
          const clan = await dbGetClan(clanName);
          if (!clan || clan.leader !== ws.userData.username) {
            ws.send(JSON.stringify({ action:'toast', message:'Только лидер может распустить клан' })); return;
          }
          const members = clan.members || [];
          for (const m of members) { await dbSaveAccount(m, { clan: '' }); }
          await dbDeleteClan(clanName);
          wss.clients.forEach(c => {
            if (c.isAuthorized && members.includes(c.userData?.username)) {
              c.userData.clan = '';
              c.send(JSON.stringify({ action:'clan_update', clan:null, message:`Клан "${clanName}" был распущен лидером` }));
            }
          });
          ws.userData.clan = '';
        }
        else if (action === 'clan_share_stencil') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan) return;
          const sharedStencil = { owner: ws.userData.username, emoji: ws.userData.emoji || '👾', avatar: getAvatarUrl(ws.userData), stencil: data.stencil };
          const stencils = normalizeClanStencils(clan);
          const existingIndex = stencils.findIndex(s => s.owner === ws.userData.username);
          if (existingIndex >= 0) stencils[existingIndex] = sharedStencil;
          else if (stencils.length < clanStencilSlots(clan)) stencils.push(sharedStencil);
          else { ws.send(JSON.stringify({ action:'toast', message:'Все слоты клановых трафаретов заняты. Откройте следующий слот в магазине клана.' })); return; }
          await dbSaveClan(ws.userData.clan, { active_stencil: sharedStencil.stencil, shared_stencil: stencils[0] || null, shared_stencils: stencils });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_stencil_update', stencils, from: ws.userData.username }), null);
        }
        else if (action === 'clan_unshare_stencil') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan) return;
          const stencils = normalizeClanStencils(clan);
          const remaining = stencils.filter(s => s.owner !== ws.userData.username);
          if (remaining.length === stencils.length) { ws.send(JSON.stringify({ action:'toast', message:'Снять трафарет может только его владелец' })); return; }
          await dbSaveClan(ws.userData.clan, { active_stencil: remaining[0]?.stencil || null, shared_stencil: remaining[0] || null, shared_stencils: remaining });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_stencil_update', stencils: remaining, from: ws.userData.username, removed: true }), null);
        }
        else if (action === 'clan_get_stencils') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          ws.send(JSON.stringify({ action:'clan_stencils_list', stencils: clan ? normalizeClanStencils(clan) : [] }));
        }

        else if (action === 'clan_get') {
          if (!ws.isAuthorized) return;
          const target = data.name || ws.userData.clan;
          if (target) {
            const clan = await dbGetClan(target);
            // Если это была ссылка на СОБСТВЕННЫЙ клан игрока, а клан больше
            // не существует (документ пропал из БД, например из-за бага
            // переименования) — самоисцеляемся: снимаем "подвешенное"
            // членство, чтобы игрок не оставался вечно привязан к призраку
            // и мог свободно вступить в другой клан / создать новый.
            if (!clan && target === ws.userData.clan) {
              ws.userData.clan = '';
              await dbSaveAccount(ws.userData.username, { clan: '' });
            }
            ws.send(JSON.stringify({ action:'clan_data', clan }));
          }
        }

        else if (action === 'clan_list') {
          const allClans = await dbGetAllClans();
          ws.send(JSON.stringify({ action:'clan_list_data', clans: allClans.filter(c => c.is_public !== false).map(c => ({
            name: c.name, tag: c.tag, tag_color: c.tag_color, icon: c.icon, join_type: c.join_type, min_pixels: c.min_pixels||0, members: (c.members||[]).length, member_limit: clanCurrentMemberLimit(c), pixels: c.pixels||0, description: c.description||'',
            banner_url: c.banner_url||null, banner_crop_x: c.banner_crop_x??0, banner_crop_y: c.banner_crop_y??0, banner_crop_w: c.banner_crop_w??1, banner_crop_h: c.banner_crop_h??1
          })) }));
        }

        // ══════════════════════════════════════════════════
        //  SHOP / INVENTORY
        // ══════════════════════════════════════════════════
        else if (action === 'shop_buy' || action === 'buy_item') {
          if (!ws.isAuthorized) return;
          const itemId = data.item_id || data.itemId;
          const item = SHOP_ITEMS.find(i => i.id === itemId);
          if (!item) { ws.send(JSON.stringify({ action:'toast', message:'Предмет не найден' })); return; }

          if (!hasRole(ws.userData, item.role)) { ws.send(JSON.stringify({ action:'toast', message:`Этот предмет доступен только для: ${item.role}` })); return; }

          const acc = await dbGetAccount(ws.userData.username);
          const upgrades  = acc.upgrades  || [];
          const inventory = acc.inventory || {};

          if (item.type === 'upgrade') {
            if (upgrades.includes(itemId)) { ws.send(JSON.stringify({ action:'toast', message:'Уже куплено!' })); return; }
          }

          if ((acc.coins||0) < item.cost && item.cost > 0) {
            ws.send(JSON.stringify({ action:'toast', message:`Нужно ${item.cost} монет. У вас ${Math.floor(acc.coins||0)}` })); return;
          }

          const newCoins = (acc.coins||0) - item.cost;
          let newUpgrades  = upgrades;
          let newInventory = inventory;

          if (item.type === 'upgrade') {
            newUpgrades = [...upgrades, itemId];
          } else {
            newInventory = { ...inventory, [itemId]: (inventory[itemId]||0) + 1 };
          }

          await dbSaveAccount(ws.userData.username, { coins: newCoins, upgrades: newUpgrades, inventory: newInventory });
          ws.userData.coins     = newCoins;
          ws.userData.upgrades  = newUpgrades;
          ws.userData.inventory = newInventory;

          let clientItems = [...newUpgrades];
          for (let k in newInventory) {
            for (let i = 0; i < newInventory[k]; i++) clientItems.push(k);
          }

          ws.send(JSON.stringify({ action:'purchase_update', purchased_items: clientItems, coins: newCoins, message:`✅ Куплено: ${item.title}` }));
          checkAchievements(ws.userData.username, ws.userData).catch(() => {});
        }

        else if (action === 'use_item') {
          if (!ws.isAuthorized) return;
          await useConsumable(ws, data.item_id || data.itemId, data);
        }

        // ── БАННЕР ПРОФИЛЯ (Этап 2) ──
        // banner_select — надеть баннер, который уже доступен (free-тир или
        // уже куплен). banner_buy — купить платный (gradient/animated) и
        // сразу же надеть. Разделены, чтобы клиент мог просто "переключать"
        // уже открытые баннеры без похода в магазин каждый раз.
        else if (action === 'banner_select') {
          if (!ws.isAuthorized) return;
          const bannerId = data.banner_id || null;

          if (bannerId === null) {
            // Явный сброс — "без баннера" всегда доступен.
          } else {
            const banner = getBannerById(bannerId);
            if (!banner) { ws.send(JSON.stringify({ action:'toast', message:'Баннер не найден' })); return; }
            // Раньше тут проверялось banner.tier === 'free', что было верно,
            // пока цветные баннеры (tier:'free') действительно стоили 0
            // монет. Теперь у них тоже есть цена (см. PROFILE_BANNERS_BUILTIN),
            // поэтому "бесплатным" считаем только баннер с cost===0 (это
            // остаётся верным и для 'banner_none'), а не весь tier целиком.
            const owned = banner.cost === 0 || (ws.userData.owned_banners || []).includes(bannerId);
            if (!owned) { ws.send(JSON.stringify({ action:'toast', message:'Этот баннер ещё не куплен' })); return; }
          }

          ws.userData.banner_id = bannerId;
          await dbSaveAccount(ws.userData.username, { banner_id: bannerId });
          ws.send(JSON.stringify({ action:'banner_update', banner: bannerId, owned_banners: ws.userData.owned_banners || [], coins: ws.userData.coins || 0, message:'Баннер обновлён' }));
          if (ws.userData.clan) broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: await dbGetClan(ws.userData.clan) }), null);
        }

        else if (action === 'banner_buy') {
          if (!ws.isAuthorized) return;
          const bannerId = data.banner_id;
          const banner = getBannerById(bannerId);
          if (!banner) { ws.send(JSON.stringify({ action:'toast', message:'Баннер не найден' })); return; }
          if (banner.cost === 0) { ws.send(JSON.stringify({ action:'toast', message:'Этот баннер и так бесплатный — просто выберите его' })); return; }

          const acc = await dbGetAccount(ws.userData.username);
          const owned = acc.owned_banners || [];
          if (owned.includes(bannerId)) { ws.send(JSON.stringify({ action:'toast', message:'Уже куплено!' })); return; }
          if ((acc.coins || 0) < banner.cost) {
            ws.send(JSON.stringify({ action:'toast', message:`Нужно ${banner.cost} монет. У вас ${Math.floor(acc.coins||0)}` })); return;
          }

          const newCoins = (acc.coins || 0) - banner.cost;
          const newOwned = [...owned, bannerId];
          await dbSaveAccount(ws.userData.username, { coins: newCoins, owned_banners: newOwned, banner_id: bannerId });
          ws.userData.coins         = newCoins;
          ws.userData.owned_banners = newOwned;
          ws.userData.banner_id     = bannerId;

          ws.send(JSON.stringify({ action:'banner_update', banner: bannerId, owned_banners: newOwned, coins: newCoins, message:`✅ Куплено: ${banner.name}` }));
          if (ws.userData.clan) broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: await dbGetClan(ws.userData.clan) }), null);
        }

        // ── ПОВТОРЯЕМАЯ НАГРАДА ПОСЛЕ «БОГА ПИКСЕЛЕЙ» ──
        else if (action === 'claim_xp_cycle_reward') {
          if (!ws.isAuthorized) return;
          const acc = await dbGetAccount(ws.userData.username);
          if (!acc) return;
          const maxCycle = Math.floor(((acc.xp || 0) - REPEAT_XP_REWARD.startXp) / REPEAT_XP_REWARD.stepXp);
          const requested = Math.floor(Number(data.cycle));
          if (!Number.isInteger(requested) || requested < 1 || requested > maxCycle) { ws.send(JSON.stringify({ action:'toast', message:'Награда ещё не открыта' })); return; }
          // Старые аккаунты могли сохранить номера циклов строками. Сравниваем
          // как числа, чтобы такая запись не ломала выдачу следующей награды.
          const claimed = [...new Set((acc.claimed_xp_cycles || []).map(Number).filter(Number.isInteger))];
          if (claimed.includes(requested)) { ws.send(JSON.stringify({ action:'toast', message:'Награда уже получена' })); return; }
          const newCoins = (acc.coins || 0) + REPEAT_XP_REWARD.coins;
          const newClaimed = [...claimed, requested];
          await dbSaveAccount(acc.username, { coins: newCoins, claimed_xp_cycles: newClaimed });
          acc.coins = newCoins; acc.claimed_xp_cycles = newClaimed;
          ws.userData.coins = newCoins; ws.userData.claimed_xp_cycles = newClaimed;
          ws.send(JSON.stringify({ action:'xp_cycle_reward_claimed', cycle: requested, coins: newCoins, claimed_xp_cycles: newClaimed, message:`✨ Получено +${REPEAT_XP_REWARD.coins} монет за ${REPEAT_XP_REWARD.startXp + requested * REPEAT_XP_REWARD.stepXp} XP` }));
        }

        // ── ЗАБРАТЬ НАГРАДУ ЗА ЗВАНИЕ (Этап 4) ──
        // Игрок жмёт кнопку "Забрать" в модалке "Звания и награды" на уже
        // достигнутом (по xp) звании. Проверяем порог, проверяем что ещё не
        // забирали, выдаём согласно RANK_REWARDS и помечаем звание забранным.
        else if (action === 'claim_rank_reward') {
          if (!ws.isAuthorized) return;
          const rankName = String(data.rank || '');
          const rankDef  = RANK_THRESHOLDS.find(r => r.name === rankName);
          if (!rankDef) { ws.send(JSON.stringify({ action:'toast', message:'Звание не найдено' })); return; }

          const checkpoint = data.idx === 'self'
            ? getRankSelfCheckpoint(rankName)
            : getRankCheckpoints(rankName).find(c => c.index === (Number.isInteger(data.idx) ? data.idx : 0));
          if (!checkpoint) { ws.send(JSON.stringify({ action:'toast', message:'Награда не найдена' })); return; }

          const acc = await dbGetAccount(ws.userData.username);
          const xp  = acc.xp || 0;
          if (xp < checkpoint.xpRequired) { ws.send(JSON.stringify({ action:'toast', message:'Эта награда ещё не открыта' })); return; }

          const claimedRanks = acc.claimed_ranks || [];
          if (claimedRanks.includes(checkpoint.id)) { ws.send(JSON.stringify({ action:'toast', message:'Награда уже получена' })); return; }

          const reward = checkpoint.reward;
          let newCoins     = acc.coins || 0;
          let newOwnedBanners = acc.owned_banners || [];
          let newInventory    = acc.inventory || {};
          let grantedBanner   = null;
          let vipUntil        = null;

          if (reward) {
            if (reward.type === 'coins') {
              newCoins += reward.amount;
            } else if (reward.type === 'banner') {
              const banner = pickRandomBannerReward(reward.tier, newOwnedBanners);
              if (banner) { newOwnedBanners = [...newOwnedBanners, banner.id]; grantedBanner = banner; }
            } else if (reward.type === 'shop_item') {
              newInventory = { ...newInventory, [reward.itemId]: (newInventory[reward.itemId] || 0) + 1 };
            } else if (reward.type === 'vip_temp') {
              grantTempVip(acc, reward.hours);
              vipUntil = acc.vip_temp_until;
            }
          }

          const newClaimedRanks = [...claimedRanks, checkpoint.id];
          await dbSaveAccount(ws.userData.username, {
            coins: newCoins, owned_banners: newOwnedBanners, inventory: newInventory, claimed_ranks: newClaimedRanks,
            role: acc.role, vip_temp_until: acc.vip_temp_until || 0, vip_temp_prev_role: acc.vip_temp_prev_role || '',
          });
          ws.userData.coins         = newCoins;
          ws.userData.owned_banners = newOwnedBanners;
          ws.userData.inventory     = newInventory;
          ws.userData.claimed_ranks = newClaimedRanks;
          ws.userData.role              = acc.role;
          ws.userData.vip_temp_until    = acc.vip_temp_until || 0;
          ws.userData.vip_temp_prev_role = acc.vip_temp_prev_role || '';
          if (accounts[ws.userData.username]) accounts[ws.userData.username].coins = newCoins;

          let clientItems = [...(ws.userData.upgrades || [])];
          for (const k in newInventory) { for (let i = 0; i < newInventory[k]; i++) clientItems.push(k); }

          let message = `🎖️ Звание «${rankName}» подтверждено`;
          if (reward && reward.type === 'coins') message = `🎖️ Награда получена: +${reward.amount} 🪙`;
          else if (reward && reward.type === 'banner' && grantedBanner) message = `🎖️ Награда получена: баннер «${grantedBanner.name}»`;
          else if (reward && reward.type === 'shop_item') message = `🎖️ Награда получена: предмет из магазина`;
          else if (reward && reward.type === 'vip_temp') message = `🎖️ Награда получена: VIP-статус на ${reward.hours} ${reward.hours === 1 ? 'час' : 'ч.'}`;

          ws.send(JSON.stringify({
            action: 'rank_reward_claimed', rank: rankName, reward, banner: grantedBanner,
            coins: newCoins, owned_banners: newOwnedBanners, purchased_items: clientItems,
            claimed_ranks: newClaimedRanks, message,
            role: acc.role, vip_temp_until: vipUntil,
          }));
        }

        // ── ЗАБРАТЬ НАГРАДУ ЗА АЧИВКУ (Этап 4) ──
        // Условие ачивки уже выполнено (acc.unlocked_achievements), но опыт
        // за неё начисляется только тут, по клику "Забрать".
        else if (action === 'claim_achievement') {
          if (!ws.isAuthorized) return;
          const id  = String(data.id || '');
          const def = ACHIEVEMENTS_DEF.find(a => a.id === id);
          if (!def) { ws.send(JSON.stringify({ action:'toast', message:'Ачивка не найдена' })); return; }

          const acc = await dbGetAccount(ws.userData.username);
          const unlocked = acc.unlocked_achievements || [];
          if (!unlocked.includes(id)) { ws.send(JSON.stringify({ action:'toast', message:'Ачивка ещё не выполнена' })); return; }

          const claimedAch = acc.claimed_achievements || [];
          if (claimedAch.includes(id)) { ws.send(JSON.stringify({ action:'toast', message:'Награда уже получена' })); return; }

          const newXp   = (acc.xp || 0) + (def.xp || 0);
          const newRank = getRank(newXp).name;
          const newClaimedAch = [...claimedAch, id];

          await dbSaveAccount(ws.userData.username, { xp: newXp, rank: newRank, claimed_achievements: newClaimedAch });
          ws.userData.xp = newXp;
          ws.userData.rank = newRank;
          ws.userData.claimed_achievements = newClaimedAch;
          if (accounts[ws.userData.username]) { accounts[ws.userData.username].xp = newXp; accounts[ws.userData.username].rank = newRank; }

          ws.send(JSON.stringify({
            action: 'achievement_claimed', id, xp: def.xp, newXp, rank: newRank,
            claimed_achievements: newClaimedAch, message: `✨ Получено +${def.xp} опыта за «${def.title}»`,
          }));
        }

        // ══════════════════════════════════════════════════
        //  ADMIN COMMANDS
        // ══════════════════════════════════════════════════
        else if (action === 'admin_cmd') {
          if (!ws.isAuthorized) return;

          // timelapse_status — не админ-действие, а read-only статус для
          // индикатора записи в топ-баре, который должен быть виден ВСЕМ
          // залогиненным пользователям, а не только админам. Раньше этот
          // запрос от обычных пользователей отклонялся общим admin-гейтом
          // ниже ("Нет прав доступа"), поэтому иконка записи у них никогда
          // не появлялась. Обрабатываем его до проверки роли.
          if (data.cmd === 'timelapse_status') {
            if (!tl) { ws.send(JSON.stringify({ action:'timelapse_status', recording: false })); return; }
            ws.send(JSON.stringify({ action:'timelapse_status', ...tl.getStatus() }));
            return;
          }

          if (ws.userData?.role !== 'admin') {
            ws.send(JSON.stringify({ action:'toast', message:'Нет прав доступа.' })); return;
          }
          const cmd = data.cmd;

          if (cmd === 'get_antibot_logs') {
            const logs = await dbGetAntiBotLogs(data.limit);
            ws.send(JSON.stringify({ action:'admin_antibot_logs', logs }));
          }

          else if (cmd === 'review_antibot_log') {
            await dbMarkAntiBotLogReviewed(data.params?.id);
            ws.send(JSON.stringify({ action:'admin_antibot_log_reviewed', id:data.params?.id || '' }));
          }

          else if (cmd === 'get_users') {
            const recipientPicker = data.recipient_picker === true;
            const requestedPage = Number(data.page) || 1, limit = recipientPicker ? 1000 : 10;
            const query = typeof data.query === 'string' ? data.query.trim().toLocaleLowerCase('ru-RU') : '';
            const allAccs = await dbGetAllAccounts();
            const matchingAccs = query
              ? allAccs.filter(a => String(a.username || '').toLocaleLowerCase('ru-RU').includes(query))
              : allAccs;
            const users   = matchingAccs.map(a => ({
              username:      a.username,
              role:          a.role  || 'user',
              banned:        a.banned || false,
              timeout_until: a.timeout_until || 0,
              pixels:        a.pixels || 0,
              coins:         a.coins  || 0,
              clan:          a.clan   || '',
              emoji:         a.emoji  || '👾',
              avatar:        getAvatarUrl(a),
              rank:          a.rank   || 'Новичок',
              banner:        a.banner_id || null,
            }));
            const totalPages = Math.ceil(users.length / limit) || 1;
            const page = Math.min(Math.max(1, requestedPage), totalPages);
            const start      = (page - 1) * limit;
            ws.send(JSON.stringify({ action:'admin_users_list', page, total_pages:totalPages, users:users.slice(start, start+limit), total:users.length, query, recipient_picker:recipientPicker }));
          }

          else if (cmd === 'ban' || cmd === 'unban') {
            const acc = await dbGetAccount(data.target);
            if (acc) {
              const banned = cmd === 'ban';
              await dbSaveAccount(data.target, { banned });
              ws.send(JSON.stringify({ action:'toast', message:`${data.target} ${banned?'забанен':'разбанен'}` }));
              if (banned) wss.clients.forEach(c => {
                if (c.isAuthorized && c.userData?.username === data.target)
                  c.send(JSON.stringify({ action:'toast', message:'Ваш аккаунт забанен.' }));
              });
            }
          }

          else if (cmd === 'timeout') {
            const acc = await dbGetAccount(data.target);
            if (acc) {
              // Ноль — осознанная команда администратора снять таймаут, а не
              // отсутствие параметра. Раньше `0 || 300` делал это невозможным.
              const requestedSecs = Number(data.params);
              const secs = Number.isFinite(requestedSecs)
                ? Math.max(0, Math.min(24 * 60 * 60, Math.floor(requestedSecs)))
                : 300;
              await dbSaveAccount(data.target, { timeout_until: Date.now() + secs * 1000 });
              ws.send(JSON.stringify({ action:'toast', message:secs > 0
                ? `${data.target} получил таймаут на ${secs}с`
                : `Таймаут для ${data.target} снят` }));
            }
          }

          else if (cmd === 'set_role') {
            const validRoles = ['user','vip','admin'];
            if (!validRoles.includes(data.params)) { ws.send(JSON.stringify({ action:'toast', message:'Неверная роль' })); return; }
            const acc = await dbGetAccount(data.target);
            if (acc) {
              await dbSaveAccount(data.target, { role: data.params });
              wss.clients.forEach(c => {
                if (c.isAuthorized && c.userData?.username === data.target) {
                  c.userData.role = data.params;
                  c.send(JSON.stringify({ action:'role_update', role: data.params }));
                }
              });
              ws.send(JSON.stringify({ action:'toast', message:`Роль ${data.target} → [${data.params}]` }));
            }
          }

          else if (cmd === 'give_coins') {
            const amount = parseInt(data.params) || 0;
            const acc    = await dbGetAccount(data.target);
            if (acc && amount > 0) {
              const newCoins = (acc.coins||0) + amount;
              await dbSaveAccount(data.target, { coins: newCoins });
              wss.clients.forEach(c => {
                if (c.isAuthorized && c.userData?.username === data.target) {
                  c.userData.coins = newCoins;
                  c.send(JSON.stringify({ action:'coins_update', coins: newCoins, pixels: c.userData.pixels||0 }));
                }
              });
              ws.send(JSON.stringify({ action:'toast', message:`${data.target} получил ${amount} монет` }));
            }
          }

          // Абсолютная установка монет (в отличие от give_coins, который добавляет).
          // Нужна для панели управления игроком в новой админке.
          else if (cmd === 'set_coins') {
            const newCoins = Math.max(0, parseInt(data.params) || 0);
            const acc = await dbGetAccount(data.target);
            if (acc) {
              await dbSaveAccount(data.target, { coins: newCoins });
              wss.clients.forEach(c => {
                if (c.isAuthorized && c.userData?.username === data.target) {
                  c.userData.coins = newCoins;
                  c.send(JSON.stringify({ action:'coins_update', coins: newCoins, pixels: c.userData.pixels||0 }));
                }
              });
              ws.send(JSON.stringify({ action:'toast', message:`${data.target}: монеты → ${newCoins}` }));
              let __online = false;
              wss.clients.forEach(c => { if (c.isAuthorized && c.userData?.username === data.target) __online = true; });
              ws.send(JSON.stringify({ action:'admin_user_detail', user: await buildAdminUserDetail(data.target, __online) }));
            }
          }

          // Абсолютная установка пикселей (влияет на ранг игрока).
          else if (cmd === 'set_pixels') {
            const newPixels = Math.max(0, parseInt(data.params) || 0);
            const acc = await dbGetAccount(data.target);
            if (acc) {
              // Ранг теперь считается от xp, а не от pixels — при ручной
              // установке пикселей админом синхронизируем xp тем же числом,
              // чтобы звание игрока осталось предсказуемым.
              const newXp   = newPixels;
              const newRank = getRank(newXp).name;
              await dbSaveAccount(data.target, { pixels: newPixels, xp: newXp, rank: newRank });
              wss.clients.forEach(c => {
                if (c.isAuthorized && c.userData?.username === data.target) {
                  c.userData.pixels = newPixels;
                  c.userData.xp = newXp;
                  c.userData.rank = newRank;
                  c.send(JSON.stringify({ action:'coins_update', coins: c.userData.coins||0, pixels: newPixels }));
                }
              });
              ws.send(JSON.stringify({ action:'toast', message:`${data.target}: пиксели → ${newPixels}` }));
              let __online2 = false;
              wss.clients.forEach(c => { if (c.isAuthorized && c.userData?.username === data.target) __online2 = true; });
              ws.send(JSON.stringify({ action:'admin_user_detail', user: await buildAdminUserDetail(data.target, __online2) }));
            }
          }

          // Полная карточка игрока для панели управления в админке.
          else if (cmd === 'get_user_detail') {
            try {
              let online = false;
              wss.clients.forEach(c => { if (c.isAuthorized && c.userData?.username === data.target) online = true; });
              const detail = await buildAdminUserDetail(data.target, online);
              if (!detail) { ws.send(JSON.stringify({ action:'toast', message:'Игрок не найден' })); return; }
              ws.send(JSON.stringify({ action:'admin_user_detail', user: detail }));
            } catch (e) {
              console.error('❌ get_user_detail:', e.message);
              ws.send(JSON.stringify({ action:'toast', message:'Ошибка загрузки карточки игрока: ' + e.message }));
            }
          }

          // Принудительно разрывает текущую сессию игрока (не бан — просто кик).
          else if (cmd === 'kick_session') {
            let found = false;
            wss.clients.forEach(c => {
              if (c.isAuthorized && c.userData?.username === data.target) {
                found = true;
                c.send(JSON.stringify({ action:'toast', message:'Вы были отключены администратором.' }));
                c.close();
              }
            });
            ws.send(JSON.stringify({ action:'toast', message: found ? `${data.target} отключен` : `${data.target} не в сети` }));
          }

          else if (cmd === 'resize_canvas') {
            const { w: newW, h: newH } = data.params;
            if (newW > 0 && newH > 0 && newW <= 2048 && newH <= 2048) {
              const newCanvas = new Uint8Array(newW * newH);
              const newOwners = new Uint16Array(newW * newH);
              const minW = Math.min(CANVAS_WIDTH, newW), minH = Math.min(CANVAS_HEIGHT, newH);
              for (let y = 0; y < minH; y++) for (let x = 0; x < minW; x++) {
                newCanvas[y*newW+x] = canvasData[y*CANVAS_WIDTH+x];
                newOwners[y*newW+x] = pixelOwners ? pixelOwners[y*CANVAS_WIDTH+x] : 0;
              }
              CANVAS_WIDTH = newW; CANVAS_HEIGHT = newH; CANVAS_SIZE = newW * newH;
              canvasData = newCanvas; pixelOwners = newOwners;
              isDirty = true; ownersDirty = true;

              // Раньше при ресайзе во время записи мы закрывали текущую сессию и
              // открывали новую (т.к. снапшот.bin зафиксирован со старым размером
              // холста, а продолжение писать события с новыми координатами в ту же
              // сессию "размазывало" бы пиксели при воспроизведении). Это давало
              // НЕЖЕЛАТЕЛЬНЫЙ побочный эффект — одна непрерывная запись превращалась
              // в две отдельные сессии в списке.
              //
              // Теперь вместо разрыва сессии пишем служебное RESIZE-событие прямо
              // в поток событий (см. timelapse_server.js: recordResize). Плеер на
              // клиенте увидит это событие на нужном timestamp и сам перестроит
              // кадр воспроизведения под новый размер — сессия остаётся ОДНОЙ.
              if (tl && tl.isRecording() && tl.recordResize) {
                try {
                  tl.recordResize(CANVAS_WIDTH, CANVAS_HEIGHT);
                } catch (e) {
                  console.error('[Timelapse] Ошибка записи resize-события:', e.message);
                }
              }

              const msg = JSON.stringify({ action:'resize', w:newW, h:newH });
              wss.clients.forEach(c => { if (c.readyState===1&&c.isAuthorized) { c.send(msg); sendCanvasSnapshot(c); } });
              ws.send(JSON.stringify({ action:'toast', message:`Холст изменён до ${newW}×${newH}` }));
            }
          }

          else if (cmd === 'get_clans') {
            const allClans = await dbGetAllClans();
            ws.send(JSON.stringify({ action:'admin_clans_list', clans: allClans.map(c => ({
              name: c.name, tag: c.tag||'', tag_color: c.tag_color||'#818cf8', icon: c.icon||'🏴',
              leader: c.leader||'', members: (c.members||[]).length, pixels: c.pixels||0, is_public: c.is_public!==false,
              description: c.description||'', banner_url: c.banner_url||null, treasury: c.treasury||0,
              member_limit: c.member_limit || CLAN_BASE_MEMBER_LIMIT,
            })) }));
          }

          else if (cmd === 'delete_clan') {
            const name = data.params?.name || data.params;
            const clan = await dbGetClan(name);
            if (clan) {
              const members = clan.members || [];
              for (const m of members) await dbSaveAccount(m, { clan: '' });
              await dbDeleteClan(name);
              wss.clients.forEach(c => {
                if (c.isAuthorized && members.includes(c.userData?.username)) {
                  c.userData.clan = '';
                  c.send(JSON.stringify({ action:'clan_update', clan:null, message:`Клан "${name}" был удалён администратором` }));
                }
              });
              ws.send(JSON.stringify({ action:'toast', message:`Клан "${name}" удалён` }));
            }
          }

          // ── АДМИН: редактирование клана (название/тег/описание) — для модерации ──
          // ── АДМИН: восстановление клана из аккаунтов ──
          // Аварийная команда на случай, если clan.members опустел или клан
          // пропал совсем (см. баг в переименовании выше), а у самих
          // пользователей поле account.clan осталось верным. Собирает членов
          // заново по факту "чей account.clan указывает на этот клан".
          // Если документа клана в БД больше нет вообще — создаёт его заново
          // с нуля (лидером станет один из найденных участников; звания,
          // казну, статистику пикселей клана и настройки восстановить
          // невозможно — этих данных больше нигде не осталось).
          else if (cmd === 'rebuild_clan_members') {
            const name = data.params?.name || data.params;
            if (!name) { ws.send(JSON.stringify({ action:'toast', message:'Не указано имя клана' })); return; }

            let clan = await dbGetClan(name);

            const allAccs = await dbGetAllAccounts();
            const rebuiltMembers = allAccs.filter(a => a.clan === name).map(a => a.username);

            if (!rebuiltMembers.length) {
              ws.send(JSON.stringify({ action:'toast', message:'Не найдено ни одного аккаунта с clan=' + name, type:'error' }));
              return;
            }

            if (!clan) {
              // Документа нет вообще — единственное, что у нас осталось, это
              // список участников. Пересоздаём минимальный клан вокруг него.
              const leader = (data.params?.leader && rebuiltMembers.includes(data.params.leader))
                ? data.params.leader
                : rebuiltMembers[0];
              await dbSaveClan(name, {
                name, leader, members: rebuiltMembers,
                tag: (data.params?.tag || name.replace(/[^A-Za-zА-Яа-я0-9]/g,'').slice(0,4).toUpperCase() || 'CLAN'),
                description: '', icon: '🏴', tag_color: '#818cf8',
                join_type: 'open', min_pixels: 0, is_public: true, share_cursor: false,
                pixels: 0, treasury: 0, ranks: null, member_roles: {},
              });
              clan = await dbGetClan(name);
              ws.send(JSON.stringify({
                action: 'toast', type: 'success',
                message: `Клан "${name}" пересоздан с нуля. Лидер: ${leader}. Участников: ${rebuiltMembers.length} (${rebuiltMembers.join(', ')}). ⚠️ Казна, звания, счётчик пикселей клана и настройки безвозвратно утеряны — их придётся настроить заново.`,
              }));
            } else {
              // Документ есть, но список участников пуст/неполный — просто
              // дополняем/перезаписываем members, остальные поля не трогаем.
              if (clan.leader && !rebuiltMembers.includes(clan.leader)) rebuiltMembers.push(clan.leader);
              await dbSaveClan(name, { members: rebuiltMembers });
              ws.send(JSON.stringify({ action:'toast', type:'success', message:`Восстановлено участников: ${rebuiltMembers.length} (${rebuiltMembers.join(', ')})` }));
            }

            broadcastToClan(name, JSON.stringify({ action:'clan_data', clan: await dbGetClan(name) }), null);
          }

          else if (cmd === 'edit_clan') {
            const p = data.params || {};
            const name = p.name;
            const clan = await dbGetClan(name);
            if (!clan) { ws.send(JSON.stringify({ action:'toast', message:'Клан не найден' })); return; }

            const patch = {};
            if (typeof p.tag === 'string') patch.tag = p.tag.slice(0, 4);
            if (typeof p.description === 'string') patch.description = p.description.slice(0, 200);

            // Переименование клана: имя — уникальный ключ, поэтому нужно перенести
            // запись под новым именем и обновить ссылку clan у всех участников.
            if (p.new_name && p.new_name !== name) {
              const newName = String(p.new_name).slice(0, 24);
              const clash = await dbGetClan(newName);
              if (clash) { ws.send(JSON.stringify({ action:'toast', message:`Клан «${newName}» уже существует` })); return; }

              // ВАЖНО: clan пришёл из dbGetClan() — это lean()-документ Mongo, в
              // нём есть служебные _id/__v, а сам сервер ещё подмешивает
              // вычисляемое поле member_cards. Если пронести _id в апсёрт
              // нового документа (findOneAndUpdate(..., {upsert:true})), Mongo
              // попытается создать новый документ со СТАРЫМ _id, который на
              // этот момент ещё существует у документа под старым именем —
              // получаем E11000 duplicate key. Ошибка молча логируется внутри
              // dbSaveClan и проглатывается, поэтому апсёрт нового имени не
              // происходит, а следом старый документ всё равно удаляется —
              // клан фактически исчезает из БД (при этом в памяти процесса
              // ещё какое-то время всё выглядит нормально, пока не случится
              // рестарт/redeploy или следующий upsert с частичными данными,
              // который создаёт "пустой" документ клана без участников).
              const { _id, __v, member_cards, ...clanClean } = clan;
              const merged = { ...clanClean, ...patch, name: newName };

              // Порядок тоже важен: сначала убеждаемся, что новый документ
              // реально сохранился, и только потом удаляем старый — чтобы при
              // сбое записи не потерять единственную копию данных клана.
              await dbSaveClan(newName, merged);
              const verify = await dbGetClan(newName);
              if (!verify || (verify.members || []).length !== (clan.members || []).length) {
                console.error(`❌ edit_clan: не удалось подтвердить перенос клана "${name}" → "${newName}", отменяю переименование`);
                ws.send(JSON.stringify({ action:'toast', message:'Не удалось переименовать клан (ошибка сохранения), попробуйте ещё раз', type:'error' }));
                return;
              }
              await dbDeleteClan(name);

              const members = clan.members || [];
              for (const m of members) await dbSaveAccount(m, { clan: newName });

              wss.clients.forEach(c => {
                if (c.isAuthorized && members.includes(c.userData?.username)) {
                  c.userData.clan = newName;
                }
              });
              broadcastToClan(newName, JSON.stringify({ action:'clan_data', clan: await dbGetClan(newName) }), null);
              wss.clients.forEach(c => {
                if (c.isAuthorized && members.includes(c.userData?.username)) {
                  c.send(JSON.stringify({ action:'toast', message:`Клан переименован администратором: «${name}» → «${newName}»` }));
                }
              });
              ws.send(JSON.stringify({ action:'toast', message:`Клан переименован в «${newName}»`, type:'success' }));
            } else {
              if (Object.keys(patch).length) {
                await dbSaveClan(name, patch);
                broadcastToClan(name, JSON.stringify({ action:'clan_data', clan: await dbGetClan(name) }), null);
              }
              ws.send(JSON.stringify({ action:'toast', message:`Клан «${name}» обновлён`, type:'success' }));
            }
          }

          // ── АДМИН: убрать баннер клана (модерация запрещённого контента) ──
          else if (cmd === 'remove_clan_banner') {
            const name = data.params?.name || data.params;
            const clan = await dbGetClan(name);
            if (!clan) { ws.send(JSON.stringify({ action:'toast', message:'Клан не найден' })); return; }
            await dbSaveClan(name, { banner_url: null, banner_crop_x: 0, banner_crop_y: 0, banner_crop_w: 1, banner_crop_h: 1 });
            broadcastToClan(name, JSON.stringify({ action:'clan_data', clan: await dbGetClan(name) }), null);
            broadcastToClan(name, JSON.stringify({ action:'toast', message:'Баннер клана удалён администратором за нарушение правил' }), null);
            ws.send(JSON.stringify({ action:'toast', message:`Баннер клана «${name}» удалён`, type:'success' }));
          }

          else if (cmd === 'clan_broadcast') {
            const { name, message } = data.params || {};
            if (name && message) {
              broadcastToClan(name, JSON.stringify({ action:'toast', message:`📢 [Админ]: ${message}` }), null);
              ws.send(JSON.stringify({ action:'toast', message:`Сообщение отправлено клану "${name}"` }));
            }
          }

          else if (cmd === 'clear_canvas') {
            // Записываем очистку в тайм-лапс ДО фактической отметки isDirty,
            // чтобы воспроизведение честно показывало момент, когда холст стал чистым,
            // а не просто "молчало" и прыгало с одной картинки на другую.
            if (tl && tl.isRecording()) {
              for (let y = 0; y < CANVAS_HEIGHT; y++) {
                for (let x = 0; x < CANVAS_WIDTH; x++) {
                  if (canvasData[y * CANVAS_WIDTH + x] !== 0) tl.recordPixel(x, y, 0);
                }
              }
            }
            canvasData.fill(0);
            if (pixelOwners) pixelOwners.fill(0);
            isDirty = true; ownersDirty = true;
            wss.clients.forEach(c => { if (c.readyState===1&&c.isAuthorized) sendCanvasSnapshot(c); });
            ws.send(JSON.stringify({ action:'toast', message:'Холст очищен!' }));
          }

          // ── ПОЛНЫЙ СБРОС ПИКСЕЛЬ БАТЛА ──
          // Готовит проект "с нуля" к новому мероприятию: холст, все статистики
          // (пиксели/xp/звания/монеты/ачивки/инвентарь/трафареты/баннеры/друзья),
          // кланы, новости и чат — очищаются полностью. Обычные аккаунты (role
          // !== 'admin') удаляются целиком, админские остаются, но их игровые
          // данные тоже обнуляются (логин/пароль/роль не трогаем).
          // Требует точное текстовое подтверждение (data.params), чтобы случайный
          // клик не мог снести данные — фраза сверяется и на клиенте, и здесь.
          else if (cmd === 'full_reset') {
            const CONFIRM_PHRASE = 'ОЧИСТИТЬ ВСЁ';
            if ((data.params || '').trim().toUpperCase() !== CONFIRM_PHRASE) {
              ws.send(JSON.stringify({ action:'toast', message:'Неверная фраза подтверждения. Сброс отменён.' }));
              return;
            }

            try {
              // 1. Холст и таблица владельцев пикселей
              if (tl && tl.isRecording()) { try { await tl.stop?.(); } catch(_) {} }
              canvasData.fill(0);
              if (pixelOwners) pixelOwners.fill(0);
              ownerIdMap.clear();
              ownerDataMap.clear();
              isDirty = true; ownersDirty = true;
              await persistCanvas();

              // 2. Аккаунты: удаляем всех не-админов, обнуляем статистику админам
              const allAccs = await dbGetAllAccounts();
              const RESET_FIELDS = {
                pixels: 0, xp: 0, rank: 'Новичок', coins: 0,
                clan: '', inventory: {}, upgrades: [],
                active_stencil: null, saved_stencils: [],
                friends: [], friend_requests_in: [], friend_requests_out: [], dm_reads: {},
                banner_id: null, owned_banners: [],
                unlocked_achievements: [], claimed_ranks: [], claimed_xp_cycles: [], claimed_achievements: [],
                vip_temp_until: 0, vip_temp_prev_role: '',
                banned: false, timeout_until: 0,
              };
              for (const acc of allAccs) {
                const username = acc.username;
                if (acc.role === 'admin') {
                  await dbSaveAccount(username, RESET_FIELDS);
                } else {
                  if (AccountModel) {
                    try { await AccountModel.deleteOne({ username }).exec(); } catch(e) {}
                  }
                  delete accounts[username];
                }
              }
              dirtyAccounts.clear();

              // 3. Кланы
              const allClans = await dbGetAllClans();
              if (ClanModel) { try { await ClanModel.deleteMany({}).exec(); } catch(e) {} }
              for (const c of allClans) delete clans[c.name];
              clans = {};
              dirtyClans.clear();

              // 4. Новости
              if (NewsModel) { try { await NewsModel.deleteMany({}).exec(); } catch(e) {} }
              newsItems.length = 0;
              saveLocalNews();

              // 5. Личные сообщения
              if (DMModel) { try { await DMModel.deleteMany({}).exec(); } catch(e) {} }

              // 6. Глобальный чат
              globalChatHistory.length = 0;

              // 7. Не отключаем пользователей после полного сброса.
              // Раньше здесь был автокик всех, кроме текущего администратора:
              // из-за него игроки без роли теряли сессию сразу после сброса.
              // Теперь соединения сохраняются для всех ролей.
              wss.clients.forEach(c => {
                if (c === ws) return;
                if (c.readyState === 1) {
                  try { c.send(JSON.stringify({ action:'toast', message:'Пиксель Батл был полностью очищен администратором.' })); } catch(_) {}
                }
              });

              // 8. Рассылаем всем (включая незалогиненных зрителей) чистый холст
              wss.clients.forEach(c => { if (c.readyState===1) sendCanvasSnapshot(c); });

              ws.send(JSON.stringify({ action:'toast', message:'✅ Пиксель Батл полностью очищен и готов к новому мероприятию!' }));
              console.log(`⚠️  ПОЛНЫЙ СБРОС выполнен администратором ${ws.userData?.username}`);
            } catch (e) {
              console.error('❌ full_reset:', e.message);
              ws.send(JSON.stringify({ action:'toast', message:'Ошибка при полном сбросе: ' + e.message }));
            }
          }

          else if (cmd === 'draw_shape') {
            const { type, params } = data;
            const cidx = data.colorIdx || 0;
            const pixelsToUpdate = [];

            if (type === 'rect') {
                for (let yy = params.y; yy < params.y + params.h; yy++) {
                    for (let xx = params.x; xx < params.x + params.w; xx++) {
                        if (xx >= 0 && xx < CANVAS_WIDTH && yy >= 0 && yy < CANVAS_HEIGHT) {
                             if (params.filled || yy === params.y || yy === params.y + params.h - 1 || xx === params.x || xx === params.x + params.w - 1) {
                                 canvasData[yy * CANVAS_WIDTH + xx] = cidx;
                                clearPixelOwner(xx, yy);
                                 pixelsToUpdate.push({x: xx, y: yy, c: cidx});
                            }
                        }
                    }
                }
            } else if (type === 'circle') {
                for (let yy = params.cy - params.r; yy <= params.cy + params.r; yy++) {
                    for (let xx = params.cx - params.r; xx <= params.cx + params.r; xx++) {
                        if (xx >= 0 && xx < CANVAS_WIDTH && yy >= 0 && yy < CANVAS_HEIGHT) {
                            let dist = Math.hypot(xx - params.cx, yy - params.cy);
                             if (params.filled ? dist <= params.r : Math.abs(dist - params.r) < 1) {
                                 canvasData[yy * CANVAS_WIDTH + xx] = cidx;
                                clearPixelOwner(xx, yy);
                                 pixelsToUpdate.push({x: xx, y: yy, c: cidx});
                            }
                        }
                    }
                }
            } else if (type === 'line') {
                let x0 = params.x0, y0 = params.y0, x1 = params.x1, y1 = params.y1;
                let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
                let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
                let err = dx + dy, e2;

                while (true) {
                    if (x0 >= 0 && x0 < CANVAS_WIDTH && y0 >= 0 && y0 < CANVAS_HEIGHT) {
                        canvasData[y0 * CANVAS_WIDTH + x0] = cidx;
                        clearPixelOwner(x0, y0);
                        pixelsToUpdate.push({x: x0, y: y0, c: cidx});
                    }
                    if (x0 === x1 && y0 === y1) break;
                    e2 = 2 * err;
                    if (e2 >= dy) { err += dy; x0 += sx; }
                    if (e2 <= dx) { err += dx; y0 += sy; }
                }
            }

            if (pixelsToUpdate.length > 0) {
                isDirty = true;
                sendPixelBulk(pixelsToUpdate);
                recordPixelsForTimelapse(pixelsToUpdate);
                ws.send(JSON.stringify({action: 'toast', message: `Фигура нарисована (${pixelsToUpdate.length} px)`}));
            }
          }

          else if (cmd === 'move_area') {
            const { sx, sy, w, h, dx, dy } = data.params;
            const temp          = [];
            const pixelsToUpdate = [];

            for (let py = 0; py < h; py++) {
              for (let px = 0; px < w; px++) {
                const cx = sx+px, cy = sy+py;
                if (cx>=0&&cx<CANVAS_WIDTH&&cy>=0&&cy<CANVAS_HEIGHT) {
                  temp.push({ x:px, y:py, c:canvasData[cy*CANVAS_WIDTH+cx], ownerId:getPixelOwnerId(cx, cy) });
                  canvasData[cy*CANVAS_WIDTH+cx] = 0;
                  clearPixelOwner(cx, cy);
                  pixelsToUpdate.push({ x:cx, y:cy, c:0 });
                }
              }
            }

            for (const p of temp) {
              if (p.c === 0) continue;
              const nx = dx+p.x, ny = dy+p.y;
              if (nx>=0&&nx<CANVAS_WIDTH&&ny>=0&&ny<CANVAS_HEIGHT) {
                canvasData[ny*CANVAS_WIDTH+nx] = p.c;
                setPixelOwnerId(nx, ny, p.c === 0 ? 0 : p.ownerId);
                pixelsToUpdate.push({ x:nx, y:ny, c:p.c });
              }
            }

            isDirty = true;
            await persistCanvas();

            if (pixelsToUpdate.length > 0) {
              sendPixelBulk(pixelsToUpdate);
              recordPixelsForTimelapse(pixelsToUpdate);
            }
            ws.send(JSON.stringify({ action:'move_saved' }));
          }

          else if (cmd === 'rainbow_storm') {
             const pixels = [];
             for (let y = 0; y < CANVAS_HEIGHT; y++) {
               const cc = y % 32;
               for (let x = 0; x < CANVAS_WIDTH; x++) {
                 canvasData[y*CANVAS_WIDTH+x] = cc;
                 pixels.push({x, y, c:cc});
               }
             }
             if (pixelOwners) pixelOwners.fill(0);
             isDirty = true; ownersDirty = true;
             sendPixelBulk(pixels);
             recordPixelsForTimelapse(pixels);
             ws.send(JSON.stringify({ action:'toast', message:'Радужный шторм запущен!' }));
          }

          else if (cmd === 'place_image') {
            const { pixels } = data.params;
            if (Array.isArray(pixels) && pixels.length > 0) {
              const valid = pixels.filter(p => p.x>=0&&p.x<CANVAS_WIDTH&&p.y>=0&&p.y<CANVAS_HEIGHT&&p.c>=0&&p.c<32);
              valid.forEach(p => { canvasData[p.y*CANVAS_WIDTH+p.x] = p.c; clearPixelOwner(p.x, p.y); });
              isDirty = true;
              await persistCanvas();
              sendPixelBulk(valid);
              recordPixelsForTimelapse(valid);
              ws.send(JSON.stringify({ action:'toast', message:`Изображение применено (${valid.length} px)` }));
            }
          }

          else if (cmd === 'broadcast') {
            const msg = data.params || '';
            if (msg) broadcastAll(JSON.stringify({ action:'toast', message:`📢 Админ: ${msg}` }));
          }

          else if (cmd === 'discord_campaign') {
            const msg = String(data.params || '').trim();
            if (!msg) { ws.send(JSON.stringify({ action:'toast', message:'Введите текст рассылки' })); return; }
            if (msg.length > 2000) { ws.send(JSON.stringify({ action:'toast', message:'Сообщение не должно быть длиннее 2000 символов' })); return; }
            if (!DISCORD_BOT_TOKEN) { ws.send(JSON.stringify({ action:'toast', message:'Не задан DISCORD_BOT_TOKEN' })); return; }
            if (discordCampaignRunning) { ws.send(JSON.stringify({ action:'toast', message:'Рассылка уже выполняется' })); return; }
            const now = Date.now();
            const contentHash = crypto.createHash('sha256').update(msg).digest('hex');
            if (now - discordCampaignLastStartedAt < DISCORD_CAMPAIGN_COOLDOWN_MS) { ws.send(JSON.stringify({ action:'toast', message:'Подождите 10 минут перед следующей массовой рассылкой' })); return; }
            if (contentHash === discordCampaignLastContentHash && now - discordCampaignLastContentAt < DISCORD_DUPLICATE_COOLDOWN_MS) { ws.send(JSON.stringify({ action:'toast', message:'Такое же сообщение уже отправлялось за последние 24 часа' })); return; }
            discordCampaignRunning = true;
            discordCampaignLastStartedAt = now;
            try {
              const result = await sendDiscordCampaign(msg);
              discordCampaignLastContentHash = contentHash;
              discordCampaignLastContentAt = Date.now();
              ws.send(JSON.stringify({ action:'discord_campaign_result', ...result }));
            } catch (error) {
              ws.send(JSON.stringify({ action:'toast', message:`Ошибка Discord-рассылки: ${error.message}` }));
            } finally {
              discordCampaignRunning = false;
            }
          }

          else if (cmd === 'discord_campaign_test') {
            const msg = String(data.params || '').trim() || 'Тестовое сообщение Pixel Battle';
            if (msg.length > 2000) { ws.send(JSON.stringify({ action:'toast', message:'Сообщение не должно быть длиннее 2000 символов' })); return; }
            if (!DISCORD_BOT_TOKEN) { ws.send(JSON.stringify({ action:'toast', message:'Не задан DISCORD_BOT_TOKEN' })); return; }
            try {
              await sendDiscordCampaignTest(msg);
              ws.send(JSON.stringify({ action:'discord_campaign_result', test:true, sent:1, failed:0 }));
            } catch (error) {
              ws.send(JSON.stringify({ action:'toast', message:`Ошибка тестового сообщения: ${error.message}` }));
            }
          }

          else if (cmd === 'send_dm') {
            const { target, params: msg } = data;
            if (target && msg) {
              wss.clients.forEach(c => {
                if (c.isAuthorized && c.userData?.username === target)
                  c.send(JSON.stringify({ action:'toast', message:`💬 Лс от Админа: ${msg}` }));
              });
            }
          }

          else if (cmd === 'toggle_cursors') {
            serverSettings.cursorTrackingEnabled = !!data.params;
            await saveSettings();
            broadcastAll(JSON.stringify({ action:'server_settings', settings:serverSettings }));
            ws.send(JSON.stringify({ action:'toast', message:`Курсоры: ${serverSettings.cursorTrackingEnabled?'включены':'выключены'}` }));
          }

          else if (cmd === 'set_cooldown') {
            serverSettings.cooldownMs = Math.max(500, Math.min(60000, parseInt(data.params) || 3000));
            await saveSettings();
            broadcastAll(JSON.stringify({ action:'server_settings', settings:serverSettings }));
            ws.send(JSON.stringify({ action:'toast', message:`Кулдаун: ${serverSettings.cooldownMs}мс` }));
          }

          else if (cmd === 'set_global_stencil') {
            serverSettings.globalStencil = data.params;
            await saveSettings();
            broadcastAll(JSON.stringify({ action:'server_settings', settings:serverSettings }));
          }

          else if (cmd === 'clear_global_stencil') {
            serverSettings.globalStencil = null;
            await saveSettings();
            broadcastAll(JSON.stringify({ action:'server_settings', settings:serverSettings }));
          }

          else if (cmd === 'admin_stats') {
            const allAccs = await dbGetAllAccounts();
            ws.send(JSON.stringify({
              action:       'admin_stats_data',
              total_users:  allAccs.length,
              online:       Array.from(wss.clients).filter(c => c.isAuthorized).length,
              banned:       allAccs.filter(a => a.banned).length,
              total_pixels: allAccs.reduce((s, a) => s + (a.pixels||0), 0),
              canvas_w:     CANVAS_WIDTH,
              canvas_h:     CANVAS_HEIGHT,
              cooldown_ms:  serverSettings.cooldownMs,
              board_persist: {
                last_success_at: boardPersistStatus.lastSuccessAt,
                last_attempt_at: boardPersistStatus.lastAttemptAt,
                snapshot_id: boardPersistStatus.lastSnapshotId,
                last_error: boardPersistStatus.lastError,
                consecutive_failures: boardPersistStatus.consecutiveFailures,
                dirty: isDirty || ownersDirty,
              },
            }));
          }

          else if (cmd === 'lockdown_set') {
            const p = data.params || {};
            serverSettings.lockdown = {
              active:  !!p.active,
              until:   p.active ? Number(p.until) || 0 : 0,
              message: String(p.message || '').slice(0, 300),
            };
            await saveSettings();
            broadcastAll(JSON.stringify({ action: 'server_settings', settings: serverSettings }));
            ws.send(JSON.stringify({ action:'toast', message: serverSettings.lockdown.active ? '🔒 Пиксель Батл закрыт' : '🔓 Пиксель Батл открыт' }));
          }

          else if (cmd === 'ads_set') {
            const p = data.params || {};
            serverSettings.ads = {
              active:          !!p.active,
              type:            p.type === 'popup' ? 'popup' : 'banner',
              imageUrl:        String(p.imageUrl || ''),
              link:            String(p.link || ''),
              intervalMinutes: Math.max(1, Math.min(1440, parseInt(p.intervalMinutes) || 5)),
            };
            await saveSettings();
            broadcastAll(JSON.stringify({ action: 'server_settings', settings: serverSettings }));
            ws.send(JSON.stringify({ action:'toast', message: 'Настройки рекламы сохранены' }));
          }

          else if (cmd === 'news_create') {
            const p = data.params || {};
            const id = 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            await dbSaveNews(id, {
              title:      String(p.title || '').slice(0, 200),
              tag:        String(p.tag || '').slice(0, 60),
              art:        String(p.art || '📰').slice(0, 8),
              desc:       String(p.desc || '').slice(0, 400),
              text:       String(p.text || '').slice(0, 8000),
              date:       String(p.date || new Date().toLocaleDateString('ru-RU')),
              bgImage:    p.bgImage || null,
              bgCropX:    Number.isFinite(Number(p.bgCropX)) ? Math.max(0, Math.min(1, Number(p.bgCropX))) : 0,
              bgCropY:    Number.isFinite(Number(p.bgCropY)) ? Math.max(0, Math.min(1, Number(p.bgCropY))) : 0,
              bgCropW:    Number.isFinite(Number(p.bgCropW)) ? Math.max(0.02, Math.min(1, Number(p.bgCropW))) : 1,
              bgCropH:    Number.isFinite(Number(p.bgCropH)) ? Math.max(0.02, Math.min(1, Number(p.bgCropH))) : 1,
              eventTimer: p.eventTimer ? Number(p.eventTimer) : null,
              showArt:    p.showArt !== false,
              showTag:    p.showTag !== false,
              showText:   p.showText !== false,
            });
            const items = await dbGetNews();
            broadcastPublic(JSON.stringify({ action: 'news_data', items }));
            ws.send(JSON.stringify({ action: 'toast', message: 'Новость создана', }));
          }

          else if (cmd === 'news_update') {
            const p = data.params || {};
            if (!p.id) { ws.send(JSON.stringify({ action:'toast', message:'Нет ID новости' })); return; }
            await dbSaveNews(p.id, {
              title:      String(p.title || '').slice(0, 200),
              tag:        String(p.tag || '').slice(0, 60),
              art:        String(p.art || '📰').slice(0, 8),
              desc:       String(p.desc || '').slice(0, 400),
              text:       String(p.text || '').slice(0, 8000),
              date:       String(p.date || ''),
              bgImage:    p.bgImage || null,
              bgCropX:    Number.isFinite(Number(p.bgCropX)) ? Math.max(0, Math.min(1, Number(p.bgCropX))) : 0,
              bgCropY:    Number.isFinite(Number(p.bgCropY)) ? Math.max(0, Math.min(1, Number(p.bgCropY))) : 0,
              bgCropW:    Number.isFinite(Number(p.bgCropW)) ? Math.max(0.02, Math.min(1, Number(p.bgCropW))) : 1,
              bgCropH:    Number.isFinite(Number(p.bgCropH)) ? Math.max(0.02, Math.min(1, Number(p.bgCropH))) : 1,
              eventTimer: p.eventTimer ? Number(p.eventTimer) : null,
              showArt:    p.showArt !== false,
              showTag:    p.showTag !== false,
              showText:   p.showText !== false,
            });
            const items = await dbGetNews();
            broadcastPublic(JSON.stringify({ action: 'news_data', items }));
            ws.send(JSON.stringify({ action: 'toast', message: 'Новость обновлена' }));
          }

          else if (cmd === 'news_delete') {
            const id = data.params?.id || data.target;
            if (!id) return;
            await dbDeleteNews(id);
            const items = await dbGetNews();
            broadcastPublic(JSON.stringify({ action: 'news_data', items }));
            ws.send(JSON.stringify({ action: 'toast', message: 'Новость удалена' }));
          }

          else if (cmd === 'news_reorder') {
            const ids = data.params?.ids;
            if (!Array.isArray(ids) || !ids.length) return;
            await dbReorderNews(ids);
            const items = await dbGetNews();
            broadcastPublic(JSON.stringify({ action: 'news_data', items }));
          }

          else if (cmd === 'timelapse_start') {
            try {
              if (!tl) { ws.send(JSON.stringify({ action:'toast', message:'R2 / timelapse_server.js не настроен' })); return; }
              const id = await tl.startRecording(canvasData, CANVAS_WIDTH, CANVAS_HEIGHT);
              // Рассылаем всем залогиненным пользователям, а не только админу,
              // который нажал "Начать" — иначе индикатор в топ-баре у остальных
              // обновится только при следующем 15-секундном опросе.
              broadcastAll(JSON.stringify({ action:'timelapse_status', ...tl.getStatus() }));
              ws.send(JSON.stringify({ action:'toast', message:`▶ Запись начата: ${id}` }));
            } catch(e) {
              ws.send(JSON.stringify({ action:'toast', message:'❌ ' + e.message }));
            }
          }

          else if (cmd === 'timelapse_stop') {
            try {
              if (!tl) { ws.send(JSON.stringify({ action:'toast', message:'R2 не настроен' })); return; }
              const info = await tl.stopRecording();
              broadcastAll(JSON.stringify({ action:'timelapse_status', recording: false }));
              ws.send(JSON.stringify({ action:'toast', message:`■ Запись остановлена. Событий: ${info.totalEvents}` }));
            } catch(e) {
              ws.send(JSON.stringify({ action:'toast', message:'❌ ' + e.message }));
            }
          }

          else if (cmd === 'timelapse_delete') {
            try {
              if (!tl) { ws.send(JSON.stringify({ action:'toast', message:'R2 не настроен' })); return; }
              const sid = data.sessionId;
              if (!sid) { ws.send(JSON.stringify({ action:'toast', message:'Не указан ID сессии' })); return; }
              await tl.deleteSession(sid);
              ws.send(JSON.stringify({ action:'timelapse_session_deleted', sessionId: sid }));
              ws.send(JSON.stringify({ action:'toast', message:`🗑 Сессия удалена: ${sid}` }));
            } catch(e) {
              ws.send(JSON.stringify({ action:'toast', message:'❌ ' + e.message }));
            }
          }
        }

      } catch(e) {
        console.error('❌ WS message error:', e.message);
      }
    });

    ws.on('close', () => {
      broadcastOnlineCount();
      if (ws.isAuthorized && ws.userData?.username) notifyFriendsPresence(ws.userData.username, false);
      // Discord Activity может быть перезапущена без предупреждения. Сразу
      // фиксируем принятые сервером пиксели, а не ждём фонового таймера.
      if (isDirty || ownersDirty) {
        persistCanvas().catch(e => console.error('❌ Canvas save on disconnect:', e.message));
      }
    });
    ws.on('error', () => {});
  });

  // ── TIMERS ──────────────────────────────────────────────
  // Короткое окно потери данных для активной игры; параллельные записи
  // сериализуются внутри persistCanvas(), поэтому старый снимок не перетрёт новый.
  setInterval(persistCanvas, 5000);

  process.on('SIGINT',  async () => { isDirty = true; await persistCanvas(); process.exit(0); });
  process.on('SIGTERM', async () => { isDirty = true; await persistCanvas(); process.exit(0); });
});
