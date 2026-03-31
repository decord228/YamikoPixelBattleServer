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
    share_cursor:   { type: Boolean, default: false },
    active_stencil: { type: Object, default: null },
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
    // Хардкод-фикс для d3cord
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
  app.use(express.static(path.join(__dirname)));

  app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
    res.send('Pixel Battle Server Running');
  });

  // Загрузка шаблонов в Cloudinary
  app.post('/api/upload-template', async (req, res) => {
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
  });

  app.get('/api/templates', async (req, res) => {
    try { res.json(await dbGetTemplates()); } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── WEB SOCKET ─────────────────────────────────────────
  const server = app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT} (${CANVAS_WIDTH}×${CANVAS_HEIGHT})`);
  });

  const wss = new WebSocketServer({ server });
  let pixelBatchBuffer = [];

  // ── BROADCAST HELPERS ────────────────────────────────────
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

  // ── PIXEL BROADCAST LOOP (50ms batch) ───────────────────
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

  // ── ПРИМЕНЕНИЕ ПРЕДМЕТА (ИСПРАВЛЕНО) ───────────────────
  async function useConsumable(ws, itemId, reqData) {
    const acc = ws.userData;
    const inv = acc.inventory || {};
    if (!inv[itemId] || inv[itemId] <= 0) {
      ws.send(JSON.stringify({ action:'toast', message:'Предмет не найден в инвентаре' })); return;
    }

    // Берем координаты клика из запроса (обязательно!)
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
          const rc = Math.floor(Math.random()*32); // Случайный цвет палитры
          canvasData[ny*CANVAS_WIDTH+nx] = rc;
          pixels.push({x:nx, y:ny, c:rc});
        }
      }
    } else if (itemId === 'eraser_10x10') {
      for (let dy = -4; dy <= 5; dy++) for (let dx = -4; dx <= 5; dx++) {
        const nx = px+dx, ny = py+dy;
        if (nx>=0&&nx<CANVAS_WIDTH&&ny>=0&&ny<CANVAS_HEIGHT) {
          canvasData[ny*CANVAS_WIDTH+nx] = 0; // Белый
          pixels.push({x:nx, y:ny, c:0});
        }
      }
    } else if (itemId === 'mirror_stamp') {
      const temp = [];
      // Копируем квадрат 5x5
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = px+dx, ny = py+dy;
          if (nx>=0&&nx<CANVAS_WIDTH&&ny>=0&&ny<CANVAS_HEIGHT) {
            temp.push({ dx, dy, c: canvasData[ny*CANVAS_WIDTH+nx] });
          }
        }
      }
      // Отражаем по горизонтали и применяем
      for (const p of temp) {
         const mx = px - p.dx; // Миррор по X
         const my = py + p.dy;
         if (mx>=0&&mx<CANVAS_WIDTH&&my>=0&&my<CANVAS_HEIGHT) {
            canvasData[my*CANVAS_WIDTH+mx] = p.c;
            pixels.push({x:mx, y:my, c:p.c});
         }
      }
    }

    // Списываем предмет из инвентаря
    inv[itemId]--;
    if (inv[itemId] <= 0) delete inv[itemId];
    acc.inventory = inv;
    accounts[acc.username] = { ...accounts[acc.username], inventory: inv };
    await dbSaveAccount(acc.username, { inventory: inv });

    if (pixels.length > 0) {
      isDirty = true;
      sendPixelBulk(pixels);
    }
    
    // Обновляем клиент
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
            const newUser = { username, password, email, role, pixels: 0, rank: 'Новичок', emoji: '👾', banned: false, timeout_until: 0, coins: 0, clan: '', inventory: {}, upgrades: [] };
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
          }));
          broadcastOnlineCount();
          ws.send(canvasData);
        }

        else if (action === 'get_leaderboard') {
          const allAccs  = await dbGetAllAccounts();
          const players  = allAccs
            .map(a => ({ username: a.username, pixels: a.pixels||0, emoji: a.emoji||'👾', rank: a.rank||'Новичок' }))
            .sort((a, b) => b.pixels - a.pixels).slice(0, 30);
          const allClans = await dbGetAllClans();
          const clanTop  = allClans
            .map(c => ({ name: c.name, tag: c.tag||'', pixels: c.pixels||0, members: (c.members||[]).length }))
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
          await dbSaveClan(name, { name, tag: tag||name.slice(0,4).toUpperCase(), description: description||'', message_of_day:'', leader: ws.userData.username, members:[ws.userData.username], join_requests:[], pixels:0, share_cursor:false, active_stencil:null });
          ws.send(JSON.stringify({ action:'clan_update', clan: await dbGetClan(name), coins: ws.userData.coins, message:`Клан "${name}" создан!` }));
        }

        else if (action === 'clan_join') {
          if (!ws.isAuthorized) return;
          const { name } = data;
          const clan = await dbGetClan(name);
          if (!clan) { ws.send(JSON.stringify({ action:'toast', message:'Клан не найден' })); return; }
          const acc = await dbGetAccount(ws.userData.username);
          if (acc.clan) { ws.send(JSON.stringify({ action:'toast', message:'Сначала покиньте текущий клан' })); return; }
          const newMembers = [...(clan.members||[]), ws.userData.username];
          await dbSaveClan(name, { members: newMembers });
          await dbSaveAccount(ws.userData.username, { clan: name });
          ws.userData.clan = name;
          ws.send(JSON.stringify({ action:'clan_update', clan:{...clan, members:newMembers}, coins:ws.userData.coins, message:`Вы вступили в клан "${name}"!` }));
          broadcastToClan(name, JSON.stringify({ action:'clan_member_joined', username:ws.userData.username }), ws);
        }

        else if (action === 'clan_join_request') {
          if (!ws.isAuthorized) return;
          const { name } = data;
          const clan = await dbGetClan(name);
          if (!clan) return;
          if ((clan.join_requests||[]).includes(ws.userData.username)) return;
          const requests = [...(clan.join_requests||[]), ws.userData.username];
          await dbSaveClan(name, { join_requests: requests });
          broadcastToClan(name, JSON.stringify({ action:'clan_join_request_in', username:ws.userData.username, clanName:name }), null);
          ws.send(JSON.stringify({ action:'toast', message:`Заявка в "${name}" отправлена` }));
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
          wss.clients.forEach(c => {
            if (c.isAuthorized && c.userData?.username === targetUser) {
              c.userData.clan = '';
              c.send(JSON.stringify({ action:'clan_update', clan:null, message:'Вас исключили из клана' }));
            }
          });
          ws.send(JSON.stringify({ action:'toast', message:`${targetUser} исключён из клана` }));
        }

        else if (action === 'clan_set_motd') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const message_of_day = data.motd || data.message_of_day;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || clan.leader !== ws.userData.username) return;
          await dbSaveClan(ws.userData.clan, { message_of_day: (message_of_day||'').slice(0,200) });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_motd', motd: message_of_day }), null);
          ws.send(JSON.stringify({ action:'toast', message:'Сообщение дня обновлено' }));
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
          ws.userData.clan = '';
          ws.send(JSON.stringify({ action:'clan_update', clan:null, message:'Вы покинули клан' }));
        }

        else if (action === 'clan_toggle_cursor') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || clan.leader !== ws.userData.username) { ws.send(JSON.stringify({ action:'toast', message:'Только лидер может управлять настройками' })); return; }
          const newVal = !clan.share_cursor;
          await dbSaveClan(ws.userData.clan, { share_cursor: newVal });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_settings_update', share_cursor: newVal }), null);
          ws.send(JSON.stringify({ action:'toast', message:`Общий курсор: ${newVal?'вкл':'выкл'}` }));
        }

        else if (action === 'clan_share_stencil') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          await dbSaveClan(ws.userData.clan, { active_stencil: data.stencil });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action:'clan_stencil_update', stencil: data.stencil }), ws);
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
          ws.send(JSON.stringify({ action:'clan_list_data', clans: allClans.map(c => ({
            name: c.name, tag: c.tag, members: (c.members||[]).length, pixels: c.pixels||0, description: c.description||''
          })) }));
        }

        // ══════════════════════════════════════════════════
        //  SHOP / INVENTORY
        // ══════════════════════════════════════════════════
        else if (action === 'buy_item') {
          if (!ws.isAuthorized) return;
          const itemId = data.item_id;
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

        // Передаём 'data', чтобы получить координаты x/y клика клиента
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