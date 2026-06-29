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

// ── OPTIONAL DEPS ──────────────────────────────────────────
let Redis = null, mongoose = null, cloudinary = null;
try { Redis      = require('@upstash/redis').Redis; }  catch(e) {}
try { mongoose   = require('mongoose'); }              catch(e) {}
try { cloudinary = require('cloudinary').v2; }         catch(e) {}

// ── CONFIG ─────────────────────────────────────────────────
const PORT           = process.env.PORT || 3000;
const ADMIN_USERNAME = 'Yamiko';
const CANVAS_FILE    = path.join(__dirname, 'canvas.bin');
const META_FILE      = path.join(__dirname, 'canvas_meta.json');

// ── CANVAS STATE ───────────────────────────────────────────
let CANVAS_WIDTH  = 256;
let CANVAS_HEIGHT = 256;
let CANVAS_SIZE   = CANVAS_WIDTH * CANVAS_HEIGHT;
let canvasData    = null;
let isDirty       = false;

// ── SERVER SETTINGS ────────────────────────────────────────
let serverSettings = {
  cursorTrackingEnabled: false,
  cooldownMs: 3000,
  globalStencil: null
};

// ── IN-MEMORY STORES ───────────────────────────────────────
let accounts  = {};
let clans     = {};
let templates = [];

// Глобальный чат (хранится только в памяти, сбрасывается при рестарте)
const globalChatHistory = [];
const CHAT_HISTORY_LIMIT = 100;

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

const RANK_THRESHOLDS = [
  { name:'Новичок',       icon:'🌱', min:0 },
  { name:'Художник',      icon:'🎨', min:50 },
  { name:'Маэстро',       icon:'🖌️', min:200 },
  { name:'Легенда',       icon:'⭐', min:1000 },
  { name:'Архитектор',    icon:'🏛️', min:5000 },
  { name:'Бог Пикселей',  icon:'👑', min:20000 },
];

function getRank(pixels) {
  return [...RANK_THRESHOLDS].reverse().find(r => pixels >= r.min) || RANK_THRESHOLDS[0];
}

// ── SHOP CATALOGUE ─────────────────────────────────────────
const SHOP_ITEMS = [
  // USER
  { id: 'stencil_auto_1', title:'Авто-подбор цветов Ур.1', cost:100, role:'user', type:'upgrade' },
  { id: 'stencil_auto_2', title:'Авто-подбор цветов Ур.2', cost:300, role:'user', type:'upgrade' },
  // VIP
  { id: 'bomb_3x3',       title:'Цветная бомбочка 3×3',    cost:50,  role:'vip',  type:'consumable' },
  { id: 'rainbow_5x5',    title:'Радужный взрыв 5×5',      cost:80,  role:'vip',  type:'consumable' },
  { id: 'eraser_10x10',   title:'Большой Ластик 10×10',    cost:120, role:'vip',  type:'consumable' },
  { id: 'mirror_stamp',   title:'Зеркальный штамп',        cost:200, role:'vip',  type:'consumable' },
];

// ── DB TIMEOUT HELPER ──────────────────────────────────────
const dbTimeout = (promise, ms = 4000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(
    () => reject(new Error('Таймаут MongoDB')), ms
  )),
]);

// ── MONGOOSE SCHEMAS ───────────────────────────────────────
let AccountModel = null, ClanModel = null, TemplateModel = null, SettingsModel = null;

if (mongoose) {
  mongoose.set('bufferCommands', false);
  mongoose.set('autoIndex', false);

  const AccountSchema = new mongoose.Schema({
    username:          { type: String, unique: true, index: true },
    password:          String,
    discord_id:        { type: String, default: '', index: true }, // ← Discord Activity
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
    active_stencil:    { type: Object, default: null }, // Текущий трафарет
    saved_stencils:    { type: Array, default: [] },    // Сохраненные пресеты трафаретов
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

    // Новые настройки клана
    icon:           { type: String, default: '🏴' },
    tag_color:      { type: String, default: '#818cf8' },
    join_type:      { type: String, default: 'open' }, // 'open', 'request', 'closed'
    min_pixels:     { type: Number, default: 0 },
    is_public:      { type: Boolean, default: true },
    share_cursor:   { type: Boolean, default: false },
    social_link:    { type: String, default: '' }
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

  AccountModel  = mongoose.model('Account',  AccountSchema);
  ClanModel     = mongoose.model('Clan',      ClanSchema);
  TemplateModel = mongoose.model('Template',  TemplateSchema);
  SettingsModel = mongoose.model('Setting',   SettingsSchema);
}

// ── REDIS ──────────────────────────────────────────────────
let redis = null;
if (Redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  console.log('✅ Upstash Redis подключён');
}

// ── DB HELPERS ─────────────────────────────────────────────
async function dbGetAccount(username) {
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

async function dbGetClan(name) {
  if (ClanModel) {
    try {
      const doc = await dbTimeout(ClanModel.findOne({ name }).lean().exec());
      if (doc) clans[name] = { ...clans[name], ...doc };
    } catch(e) { console.error(`❌ dbGetClan(${name}):`, e.message); }
  }
  return clans[name] || null;
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
      mongoose = null; AccountModel = null; ClanModel = null; TemplateModel = null; SettingsModel = null;
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

  // Метаданные холста
  let metaLoaded = false;
  if (redis) {
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
  canvasData  = new Uint8Array(CANVAS_SIZE);

  let canvasLoaded = false;
  if (redis) {
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
}

// ── PERSIST ────────────────────────────────────────────────
async function persistCanvas() {
  if (!isDirty) return;
  isDirty = false;
  const b64  = Buffer.from(canvasData).toString('base64');
  const meta = JSON.stringify({ w: CANVAS_WIDTH, h: CANVAS_HEIGHT });
  if (redis) {
    try { await redis.set('canvas_meta', meta); await redis.set('pixel_canvas', b64); } catch(e) { console.error('❌ Redis save:', e.message); }
  }
  try { fs.writeFileSync(META_FILE, meta); fs.writeFileSync(CANVAS_FILE, canvasData); } catch(e) {}
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
        try { await dbSaveAccount(username, { pixels: accounts[username].pixels, coins: accounts[username].coins, rank: accounts[username].rank, inventory: accounts[username].inventory }); } catch(e) {}
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

initDatabases().then(() => {
  const app = express();
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
        const result = await cloudinary.uploader.upload(imageBase64, {
          folder: 'pixel_battle_templates',
          public_id: `tmpl_${Date.now()}`,
        });
        cloudUrl = result.secure_url; cloudId = result.public_id;
      }
      await dbSaveTemplate({ name, cloudinary_url: cloudUrl, cloudinary_id: cloudId, uploader: username || 'anon' });
      res.json({ success: true, url: cloudUrl, name });
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

  function broadcastToClan(clanName, msg, excludeWs) {
    wss.clients.forEach(c => {
      if (c.readyState === 1 && c.isAuthorized && c.userData?.clan === clanName && c !== excludeWs)
        c.send(msg);
    });
  }

  // Если участник, поделившийся трафаретом клана, уходит (кик/выход) —
  // трафарет нужно автоматически снять, иначе он "осиротеет" и останется
  // висеть на холсте у всех навечно без возможности его убрать.
  async function clearClanStencilIfOwner(clanName, username) {
    const clan = await dbGetClan(clanName);
    if (!clan || !clan.shared_stencil || clan.shared_stencil.owner !== username) return;
    await dbSaveClan(clanName, { active_stencil: null, shared_stencil: null });
    broadcastToClan(clanName, JSON.stringify({ action:'clan_stencil_update', stencil: null, from: username, removed: true }), null);
  }

  setInterval(() => {
    if (!pixelBatchBuffer.length) return;
    const batch  = pixelBatchBuffer.splice(0);
    const buf    = new Uint8Array(batch.length * 5);
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i];
      buf[i*5]   = (p.x >> 8) & 0xFF; buf[i*5+1] = p.x & 0xFF;
      buf[i*5+2] = (p.y >> 8) & 0xFF; buf[i*5+3] = p.y & 0xFF;
      buf[i*5+4] = p.c;
    }
    wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(buf); });
  }, 50);

  function sendPixelBulk(pixels) {
    const buf = new Uint8Array(pixels.length * 5);
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i];
      buf[i*5]   = (p.x >> 8) & 0xFF; buf[i*5+1] = p.x & 0xFF;
      buf[i*5+2] = (p.y >> 8) & 0xFF; buf[i*5+3] = p.y & 0xFF;
      buf[i*5+4] = p.c;
    }
    wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(buf); });
  }

  function hasRole(userData, role) {
    if (userData.role === 'admin') return true;
    if (role === 'vip' && userData.role === 'vip') return true;
    if (role === 'user') return true;
    return false;
  }

  async function useConsumable(ws, itemId, reqData) {
    const acc = ws.userData;
    const inv = acc.inventory || {};
    if (!inv[itemId] || inv[itemId] <= 0) {
      ws.send(JSON.stringify({ action:'toast', message:'Предмет не найден в инвентаре' })); return;
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
          const rc = Math.floor(Math.random()*32); 
          canvasData[ny*CANVAS_WIDTH+nx] = rc;
          pixels.push({x:nx, y:ny, c:rc});
        }
      }
    } else if (itemId === 'eraser_10x10') {
      for (let dy = -4; dy <= 5; dy++) for (let dx = -4; dx <= 5; dx++) {
        const nx = px+dx, ny = py+dy;
        if (nx>=0&&nx<CANVAS_WIDTH&&ny>=0&&ny<CANVAS_HEIGHT) {
          canvasData[ny*CANVAS_WIDTH+nx] = 0;
          pixels.push({x:nx, y:ny, c:reqColor});
        }
      }
    } else if (itemId === 'mirror_stamp') {
      const temp = [];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = px+dx, ny = py+dy;
          if (nx>=0&&nx<CANVAS_WIDTH&&ny>=0&&ny<CANVAS_HEIGHT) {
            temp.push({ dx, dy, c: canvasData[ny*CANVAS_WIDTH+nx] });
          }
        }
      }
      for (const p of temp) {
         const mx = px - p.dx; 
         const my = py + p.dy;
         if (mx>=0&&mx<CANVAS_WIDTH&&my>=0&&my<CANVAS_HEIGHT) {
            canvasData[my*CANVAS_WIDTH+mx] = p.c;
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
      isDirty = true;
      sendPixelBulk(pixels);
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
    ws.isAuthorized = false;
    ws.userData     = null;

    ws.send(canvasData);
    ws.send(JSON.stringify({ action: 'server_settings', settings: serverSettings }));
    if (globalChatHistory.length > 0) {
      ws.send(JSON.stringify({ action: 'chat_history', messages: globalChatHistory }));
    }

    ws.on('message', async (message) => {
      // ── BINARY: установка пикселя (5 байт) ──────────────
      if (message.length === 5) {
        if (!ws.isAuthorized) return;
        const acc = ws.userData;
        if (acc.banned) { ws.send(JSON.stringify({ action:'toast', message:'Ваш аккаунт забанен!' })); return; }
        if (acc.timeout_until > Date.now()) {
          const left = Math.ceil((acc.timeout_until - Date.now()) / 1000);
          ws.send(JSON.stringify({ action:'toast', message:`Таймаут! Осталось: ${left}с` })); return;
        }

        const x       = (message[0] << 8) | message[1];
        const y       = (message[2] << 8) | message[3];
        const colorIdx = message[4];

        if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT && colorIdx >= 0 && colorIdx < 32) {
          canvasData[y * CANVAS_WIDTH + x] = colorIdx;
          pixelBatchBuffer.push({ x, y, c: colorIdx });
          isDirty = true;

          acc._lastPixel = { x, y };
          acc._lastColor = colorIdx;

          const prevCoins = acc.coins || 0;
          acc.pixels = (acc.pixels || 0) + 1;
          acc.coins = (acc.coins || 0) + COINS_PER_PIXEL;
          acc.rank  = getRank(acc.pixels).name;

          accounts[acc.username] = { ...accounts[acc.username], pixels: acc.pixels, coins: acc.coins, rank: acc.rank };
          dirtyAccounts.add(acc.username);

          if (acc.clan) {
            if (!clans[acc.clan]) clans[acc.clan] = { pixels: 0 };
            clans[acc.clan].pixels = (clans[acc.clan].pixels || 0) + 1;
            dirtyClans.add(acc.clan);
          }

          if (Math.floor(acc.coins) > Math.floor(prevCoins)) {
            ws.send(JSON.stringify({ action: 'coins_update', coins: acc.coins, pixels: acc.pixels }));
          }
        }
        return;
      }

      // ── JSON MESSAGES ─────────────────────────────────────
      try {
        const data   = JSON.parse(message.toString());
        const action = data.action || data.type;

        if (action === 'auth') {
          // ── Discord Activity авторизация ──────────────────
          if (data.discord_token) {
            try {
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
                  active_stencil: null,
                  saved_stencils: []
                };
                await dbSaveAccount(username, acc);
              } else if (!acc.discord_id) {
                // Привязываем discord_id к существующему аккаунту
                acc.discord_id = discordUser.id;
                await dbSaveAccount(username, { discord_id: discordUser.id });
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
                coins:           ws.userData.coins     || 0,
                clan:            ws.userData.clan      || '',
                purchased_items: clientItems,
                canvas_w:        CANVAS_WIDTH,
                canvas_h:        CANVAS_HEIGHT,
                settings:        serverSettings,
                stencil:         ws.userData.active_stencil,
                saved_stencils:  ws.userData.saved_stencils,
              }));
              broadcastOnlineCount();
              ws.send(canvasData);
              return;

            } catch(e) {
              console.error('Discord auth error:', e);
              ws.send(JSON.stringify({ action: 'toast', message: 'Ошибка сервера при Discord авторизации' }));
              return;
            }
          }
          // ── Обычная авторизация username+password ─────────
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
            const newUser = { username, password, email, role, pixels: 0, rank: 'Новичок', emoji: '👾', banned: false, timeout_until: 0, coins: 0, clan: '', inventory: {}, upgrades: [], active_stencil: null, saved_stencils: [] };
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
            coins:     ws.userData.coins     || 0,
            clan:      ws.userData.clan      || '',
            purchased_items: clientItems,
            canvas_w:  CANVAS_WIDTH,
            canvas_h:  CANVAS_HEIGHT,
            settings:  serverSettings,
            stencil:   ws.userData.active_stencil,
            saved_stencils: ws.userData.saved_stencils
          }));
          broadcastOnlineCount();
          ws.send(canvasData);
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
          const allAccs  = await dbGetAllAccounts();
          const players  = allAccs
            .map(a => ({ username: a.username, pixels: a.pixels||0, emoji: a.emoji||'👾', rank: a.rank||'Новичок' }))
            .sort((a, b) => b.pixels - a.pixels).slice(0, 30);
          const allClans = await dbGetAllClans();
          const clanTop  = allClans
            .filter(c => c.is_public !== false)
            .map(c => ({ name: c.name, tag: c.tag||'', icon: c.icon||'', tag_color: c.tag_color||'#818cf8', pixels: c.pixels||0, members: (c.members||[]).length }))
            .sort((a, b) => b.pixels - a.pixels).slice(0, 20);
          ws.send(JSON.stringify({ action: 'leaderboard_data', players, clans: clanTop }));
        }

        else if (action === 'cursor') {
          if (!ws.isAuthorized) return;
          if (!serverSettings.cursorTrackingEnabled && !(ws.userData.clan && data.clan_only)) return;
          const msg = JSON.stringify({ action:'cursor', u:ws.userData.username, x:data.x, y:data.y, c:data.c, emoji:ws.userData.emoji||'👾', clan:ws.userData.clan||'' });
          if (data.clan_only && ws.userData.clan) broadcastToClan(ws.userData.clan, msg, ws);
          else wss.clients.forEach(c => { if (c !== ws && c.readyState === 1 && c.isAuthorized) c.send(msg); });
        }

        else if (action === 'save_emoji') {
          if (!ws.isAuthorized) return;
          ws.userData.emoji = data.emoji || '👾';
          await dbSaveAccount(ws.userData.username, { emoji: ws.userData.emoji });
          ws.send(JSON.stringify({ action:'toast', message:'Аватар сохранён!' }));
        }

        else if (action === 'chat_send') {
          if (!ws.isAuthorized) return;
          const text = (data.text || '').trim().slice(0, 200);
          if (!text) return;
          const msg = { username: ws.userData.username, role: ws.userData.role || 'user', emoji: ws.userData.emoji || '👾', text, ts: Date.now() };
          globalChatHistory.push(msg);
          if (globalChatHistory.length > CHAT_HISTORY_LIMIT) globalChatHistory.shift();
          broadcastAll(JSON.stringify({ action: 'chat_message', msg }));
        }

        else if (action === 'clan_chat_send') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const text = (data.text || '').trim().slice(0, 200);
          if (!text) return;
          const msg = { username: ws.userData.username, emoji: ws.userData.emoji||'👾', text, ts: Date.now() };
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_chat_message', msg }), null);
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
             join_requests:[], pixels:0, share_cursor:false, active_stencil:null, shared_stencil:null,
             icon: '🏴', tag_color: '#818cf8', join_type: 'open', min_pixels: 0, is_public: true, social_link: ''
          });
          ws.send(JSON.stringify({ action:'clan_update', clan: await dbGetClan(name), coins: ws.userData.coins, message:`Клан "${name}" создан!` }));
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
        }

        else if (action === 'clan_update_settings') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || clan.leader !== ws.userData.username) { ws.send(JSON.stringify({ action:'toast', message:'Нет прав' })); return; }
          
          const settings = data.settings || {};
          const update = {
             icon: settings.icon || '🏴',
             tag_color: settings.tag_color || '#818cf8',
             join_type: settings.join_type || 'open',
             min_pixels: parseInt(settings.min_pixels) || 0,
             is_public: !!settings.is_public,
             share_cursor: !!settings.share_cursor,
             social_link: settings.social_link || '',
             message_of_day: (settings.message_of_day || '').slice(0, 200)
          };
          
          await dbSaveClan(ws.userData.clan, update);
          const newClanData = await dbGetClan(ws.userData.clan);
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_data', clan: newClanData }), null);
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_settings_update', share_cursor: update.share_cursor }), null);
          ws.send(JSON.stringify({ action:'toast', message:'Настройки клана сохранены', type:'success' }));
        }

        else if (action === 'clan_get_requests') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (clan && clan.leader === ws.userData.username) {
            ws.send(JSON.stringify({ action: 'clan_requests', requests: clan.join_requests || [] }));
          }
        }

        else if (action === 'clan_accept_request') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const target = data.username;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || clan.leader !== ws.userData.username) return;
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
        }

        else if (action === 'clan_deny_request') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const target = data.username;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || clan.leader !== ws.userData.username) return;
          const requests = (clan.join_requests||[]).filter(r => r !== target);
          await dbSaveClan(ws.userData.clan, { join_requests: requests });
          ws.send(JSON.stringify({ action:'toast', message:`Заявка от ${target} отклонена` }));
          ws.send(JSON.stringify({ action:'clan_requests', requests }));
        }

        else if (action === 'clan_kick') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const targetUser = data.username || data.target;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || clan.leader !== ws.userData.username || targetUser === ws.userData.username) return;
          const newMembers = (clan.members||[]).filter(m => m !== targetUser);
          await dbSaveClan(ws.userData.clan, { members: newMembers });
          await dbSaveAccount(targetUser, { clan: '' });
          await clearClanStencilIfOwner(ws.userData.clan, targetUser);
          wss.clients.forEach(c => {
            if (c.isAuthorized && c.userData?.username === targetUser) {
              c.userData.clan = '';
              c.send(JSON.stringify({ action:'clan_update', clan:null, message:'Вас исключили из клана' }));
            }
          });
          ws.send(JSON.stringify({ action:'toast', message:`${targetUser} исключён из клана` }));
        }

        else if (action === 'clan_leave') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clanName = ws.userData.clan;
          const clan     = await dbGetClan(clanName);
          if (!clan) return;
          const newMembers = (clan.members||[]).filter(m => m !== ws.userData.username);
          if (newMembers.length === 0) {
            await dbDeleteClan(clanName);
          } else {
            const newLeader = clan.leader === ws.userData.username ? newMembers[0] : clan.leader;
            await dbSaveClan(clanName, { members: newMembers, leader: newLeader });
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
          const existing = clan.shared_stencil || null;
          // В клане может быть только ОДИН активный трафарет одновременно.
          // Менять/обновлять его может только текущий владелец (или кто угодно,
          // если трафарета сейчас нет вообще).
          if (existing && existing.owner !== ws.userData.username) {
            ws.send(JSON.stringify({ action:'toast', message:`В клане уже есть трафарет от ${existing.owner}. Попросите снять его или подождите.` }));
            return;
          }
          const sharedStencil = { owner: ws.userData.username, emoji: ws.userData.emoji || '👾', stencil: data.stencil };
          await dbSaveClan(ws.userData.clan, { active_stencil: data.stencil, shared_stencil: sharedStencil });
          // Уведомляем всех (включая отправителя) — у всех обновляется единый трафарет клана.
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_stencil_update', stencil: sharedStencil, from: ws.userData.username }), null);
        }
        else if (action === 'clan_unshare_stencil') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan) return;
          const existing = clan.shared_stencil || null;
          if (!existing) return;
          if (existing.owner !== ws.userData.username) {
            ws.send(JSON.stringify({ action:'toast', message:'Снять трафарет может только его владелец' }));
            return;
          }
          await dbSaveClan(ws.userData.clan, { active_stencil: null, shared_stencil: null });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_stencil_update', stencil: null, from: ws.userData.username, removed: true }), null);
        }
        else if (action === 'clan_get_stencils') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          ws.send(JSON.stringify({ action:'clan_stencils_list', stencil: (clan && clan.shared_stencil) || null }));
        }

        else if (action === 'clan_get') {
          if (!ws.isAuthorized) return;
          const target = data.name || ws.userData.clan;
          if (target) {
            const clan = await dbGetClan(target);
            ws.send(JSON.stringify({ action:'clan_data', clan }));
          }
        }

        else if (action === 'clan_list') {
          const allClans = await dbGetAllClans();
          ws.send(JSON.stringify({ action:'clan_list_data', clans: allClans.filter(c => c.is_public !== false).map(c => ({
            name: c.name, tag: c.tag, tag_color: c.tag_color, icon: c.icon, join_type: c.join_type, members: (c.members||[]).length, pixels: c.pixels||0, description: c.description||''
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
        }

        else if (action === 'use_item') {
          if (!ws.isAuthorized) return;
          await useConsumable(ws, data.item_id || data.itemId, data);
        }

        // ══════════════════════════════════════════════════
        //  ADMIN COMMANDS
        // ══════════════════════════════════════════════════
        else if (action === 'admin_cmd') {
          if (!ws.isAuthorized || ws.userData?.role !== 'admin') {
            ws.send(JSON.stringify({ action:'toast', message:'Нет прав доступа.' })); return;
          }
          const cmd = data.cmd;

          if (cmd === 'get_users') {
            const page = data.page || 1, limit = 10;
            const allAccs = await dbGetAllAccounts();
            const users   = allAccs.map(a => ({
              username:      a.username,
              role:          a.role  || 'user',
              banned:        a.banned || false,
              timeout_until: a.timeout_until || 0,
              pixels:        a.pixels || 0,
              coins:         a.coins  || 0,
              clan:          a.clan   || '',
            }));
            const totalPages = Math.ceil(users.length / limit) || 1;
            const start      = (page - 1) * limit;
            ws.send(JSON.stringify({ action:'admin_users_list', page, total_pages:totalPages, users:users.slice(start, start+limit), total:users.length }));
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
              const secs = data.params || 300;
              await dbSaveAccount(data.target, { timeout_until: Date.now() + secs * 1000 });
              ws.send(JSON.stringify({ action:'toast', message:`${data.target} получил таймаут на ${secs}с` }));
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

          else if (cmd === 'resize_canvas') {
            const { w: newW, h: newH } = data.params;
            if (newW > 0 && newH > 0 && newW <= 2048 && newH <= 2048) {
              const newCanvas = new Uint8Array(newW * newH);
              const minW = Math.min(CANVAS_WIDTH, newW), minH = Math.min(CANVAS_HEIGHT, newH);
              for (let y = 0; y < minH; y++) for (let x = 0; x < minW; x++) newCanvas[y*newW+x] = canvasData[y*CANVAS_WIDTH+x];
              CANVAS_WIDTH = newW; CANVAS_HEIGHT = newH; CANVAS_SIZE = newW * newH; canvasData = newCanvas;
              isDirty = true;
              const msg = JSON.stringify({ action:'resize', w:newW, h:newH });
              wss.clients.forEach(c => { if (c.readyState===1&&c.isAuthorized) { c.send(msg); c.send(canvasData); } });
              ws.send(JSON.stringify({ action:'toast', message:`Холст изменён до ${newW}×${newH}` }));
            }
          }

          else if (cmd === 'clear_canvas') {
            canvasData.fill(0); isDirty = true;
            wss.clients.forEach(c => { if (c.readyState===1&&c.isAuthorized) c.send(canvasData); });
            ws.send(JSON.stringify({ action:'toast', message:'Холст очищен!' }));
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
                  temp.push({ x:px, y:py, c:canvasData[cy*CANVAS_WIDTH+cx] });
                  canvasData[cy*CANVAS_WIDTH+cx] = 0;
                  pixelsToUpdate.push({ x:cx, y:cy, c:0 });
                }
              }
            }

            for (const p of temp) {
              if (p.c === 0) continue;
              const nx = dx+p.x, ny = dy+p.y;
              if (nx>=0&&nx<CANVAS_WIDTH&&ny>=0&&ny<CANVAS_HEIGHT) {
                canvasData[ny*CANVAS_WIDTH+nx] = p.c;
                pixelsToUpdate.push({ x:nx, y:ny, c:p.c });
              }
            }

            isDirty = true;
            await persistCanvas();

            if (pixelsToUpdate.length > 0) sendPixelBulk(pixelsToUpdate);
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
             isDirty = true;
             sendPixelBulk(pixels);
             ws.send(JSON.stringify({ action:'toast', message:'Радужный шторм запущен!' }));
          }

          else if (cmd === 'place_image') {
            const { pixels } = data.params;
            if (Array.isArray(pixels) && pixels.length > 0) {
              const valid = pixels.filter(p => p.x>=0&&p.x<CANVAS_WIDTH&&p.y>=0&&p.y<CANVAS_HEIGHT&&p.c>=0&&p.c<32);
              valid.forEach(p => { canvasData[p.y*CANVAS_WIDTH+p.x] = p.c; });
              isDirty = true;
              await persistCanvas();
              sendPixelBulk(valid);
              ws.send(JSON.stringify({ action:'toast', message:`Изображение применено (${valid.length} px)` }));
            }
          }

          else if (cmd === 'broadcast') {
            const msg = data.params || '';
            if (msg) broadcastAll(JSON.stringify({ action:'toast', message:`📢 Админ: ${msg}` }));
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
            }));
          }
        }

      } catch(e) {
        console.error('❌ WS message error:', e.message);
      }
    });

    ws.on('close', () => { broadcastOnlineCount(); });
    ws.on('error', () => {});
  });

  // ── TIMERS ──────────────────────────────────────────────
  setInterval(persistCanvas, 10000);

  process.on('SIGINT',  async () => { isDirty = true; await persistCanvas(); process.exit(0); });
  process.on('SIGTERM', async () => { isDirty = true; await persistCanvas(); process.exit(0); });
});