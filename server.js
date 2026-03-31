'use strict';
const express = require('express');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

// ── OPTIONAL DEPS ──
let Redis = null, mongoose = null, cloudinary = null;
try { Redis = require('@upstash/redis').Redis; } catch(e) {}
try { mongoose = require('mongoose'); } catch(e) {}
try { cloudinary = require('cloudinary').v2; } catch(e) {}

// ── CONFIG ──
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = "Yamiko";
const CANVAS_FILE = path.join(__dirname, 'canvas.bin');
const META_FILE   = path.join(__dirname, 'canvas_meta.json');

let CANVAS_WIDTH  = 256;
let CANVAS_HEIGHT = 256;
let CANVAS_SIZE   = CANVAS_WIDTH * CANVAS_HEIGHT;
let canvasData    = null;
let isDirty       = false;

// ── SERVER SETTINGS ──
let serverSettings = { cursorTrackingEnabled: false, cooldownMs: 3000 };

// ── IN-MEMORY STORES (fallback if no DB) ──
let accounts  = {};  // username -> accountDoc
let clans     = {};  // clanName -> clanDoc
let templates = [];  // array of template meta

// ── CLOUDINARY SETUP ──
if (cloudinary && process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// ── MONGOOSE SCHEMAS ──
let AccountModel = null, ClanModel = null, TemplateModel = null, SettingsModel = null;

if (mongoose) {
  const AccountSchema = new mongoose.Schema({
    username:       { type: String, unique: true, index: true },
    password:       String,
    email:          String,
    role:           { type: String, default: 'user' },
    pixels:         { type: Number, default: 0 },
    rank:           { type: String, default: 'Новичок' },
    emoji:          { type: String, default: '👾' },
    banned:         { type: Boolean, default: false },
    timeout_until:  { type: Number, default: 0 },
    coins:          { type: Number, default: 0 },
    clan:           { type: String, default: '' },
    stencil_level:  { type: Number, default: 0 }, // purchased stencil assistant levels
    purchased_levels: { type: [Number], default: [] },
  }, { timestamps: true });

  const ClanSchema = new mongoose.Schema({
    name:           { type: String, unique: true, index: true },
    tag:            String,
    description:    String,
    leader:         String,
    members:        [String],
    pixels:         { type: Number, default: 0 },
    share_cursor:   { type: Boolean, default: false },
    active_stencil: { type: Object, default: null }, // shared stencil data
  }, { timestamps: true });

  const TemplateSchema = new mongoose.Schema({
    name:           String,
    cloudinary_url: String,
    cloudinary_id:  String,
    uploader:       String,
    width:          Number,
    height:         Number,
    pixelData:      String, // base64 compressed pixel indices
  }, { timestamps: true });

  const SettingsSchema = new mongoose.Schema({
    key:   { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed,
  });

  AccountModel  = mongoose.model('Account',  AccountSchema);
  ClanModel     = mongoose.model('Clan',      ClanSchema);
  TemplateModel = mongoose.model('Template',  TemplateSchema);
  SettingsModel = mongoose.model('Setting',   SettingsSchema);
}

// ── REDIS ──
let redis = null;
if (Redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

// ── DB HELPERS ──
async function dbGetAccount(username) {
  if (AccountModel) return await AccountModel.findOne({ username }).lean();
  return accounts[username] || null;
}

async function dbSaveAccount(username, data) {
  if (AccountModel) {
    await AccountModel.findOneAndUpdate({ username }, data, { upsert: true, new: true });
  } else {
    accounts[username] = { ...accounts[username], ...data };
    saveLocalAccounts();
  }
}

async function dbGetAllAccounts() {
  if (AccountModel) return await AccountModel.find({}).lean();
  return Object.entries(accounts).map(([username, v]) => ({ username, ...v }));
}

async function dbGetClan(name) {
  if (ClanModel) return await ClanModel.findOne({ name }).lean();
  return clans[name] || null;
}

async function dbSaveClan(name, data) {
  if (ClanModel) {
    await ClanModel.findOneAndUpdate({ name }, data, { upsert: true, new: true });
  } else {
    clans[name] = { ...clans[name], ...data };
  }
}

async function dbGetAllClans() {
  if (ClanModel) return await ClanModel.find({}).lean();
  return Object.values(clans);
}

async function dbDeleteClan(name) {
  if (ClanModel) await ClanModel.deleteOne({ name });
  else delete clans[name];
}

async function dbGetTemplates() {
  if (TemplateModel) return await TemplateModel.find({}).lean();
  return templates;
}

async function dbSaveTemplate(data) {
  if (TemplateModel) return await new TemplateModel(data).save();
  templates.push(data);
}

async function dbDeleteTemplate(id) {
  if (TemplateModel) await TemplateModel.findByIdAndDelete(id);
}

async function dbGetSettings() {
  if (SettingsModel) {
    const doc = await SettingsModel.findOne({ key: 'server_settings' }).lean();
    return doc ? doc.value : null;
  }
  return null;
}

async function dbSaveSettings(settings) {
  if (SettingsModel) {
    await SettingsModel.findOneAndUpdate(
      { key: 'server_settings' },
      { value: settings },
      { upsert: true }
    );
  }
}

function saveLocalAccounts() {
  try { fs.writeFileSync(path.join(__dirname,'accounts.json'), JSON.stringify(accounts, null, 2)); } catch(e) {}
}

// ── INIT ──
async function initDatabases() {
  // Connect MongoDB
  if (mongoose && process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 8000,
        socketTimeoutMS: 30000,
      });
      console.log('✅ MongoDB Atlas подключён');
    } catch(e) {
      console.error('❌ MongoDB ошибка:', e.message);
      mongoose = null; AccountModel = null; ClanModel = null; TemplateModel = null;
    }
  }

  // Load server settings
  const savedSettings = await dbGetSettings();
  if (savedSettings) serverSettings = { ...serverSettings, ...savedSettings };
  else {
    const settingsFile = path.join(__dirname, 'server_settings.json');
    if (fs.existsSync(settingsFile)) {
      try { serverSettings = { ...serverSettings, ...JSON.parse(fs.readFileSync(settingsFile,'utf8')) }; } catch(e) {}
    }
  }

  // Load local accounts fallback
  if (!AccountModel) {
    const af = path.join(__dirname, 'accounts.json');
    if (fs.existsSync(af)) {
      try { accounts = JSON.parse(fs.readFileSync(af,'utf8')); } catch(e) {}
    }
    // Ensure admin accounts
    if (accounts['d3cord'] && accounts['d3cord'].email === 'otarasik10@gmail.com') {
      accounts['d3cord'].role = 'admin';
    }
  }

  // Load canvas meta
  let metaLoaded = false;
  if (redis) {
    try {
      const metaRaw = await redis.get('canvas_meta');
      if (metaRaw) {
        const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw;
        if (meta && meta.w && meta.h) { CANVAS_WIDTH = meta.w; CANVAS_HEIGHT = meta.h; metaLoaded = true; }
      }
    } catch(e) { console.error('❌ Redis meta:', e.message); }
  }
  if (!metaLoaded && fs.existsSync(META_FILE)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_FILE,'utf8'));
      if (meta.w && meta.h) { CANVAS_WIDTH = meta.w; CANVAS_HEIGHT = meta.h; }
    } catch(e) {}
  }

  CANVAS_SIZE = CANVAS_WIDTH * CANVAS_HEIGHT;
  canvasData  = new Uint8Array(CANVAS_SIZE);
  canvasData.fill(0);

  // Load canvas data
  let canvasLoaded = false;
  if (redis) {
    try {
      console.log('⏳ Загружаем холст из Redis...');
      const savedB64 = await redis.get('pixel_canvas');
      if (savedB64) {
        const buf = Buffer.from(savedB64, 'base64');
        if (buf.length === CANVAS_SIZE) { canvasData.set(buf); canvasLoaded = true; console.log('✅ Холст из Redis!'); }
      }
    } catch(e) { console.error('❌ Redis canvas:', e.message); }
  }
  if (!canvasLoaded && fs.existsSync(CANVAS_FILE)) {
    try {
      const saved = fs.readFileSync(CANVAS_FILE);
      if (saved.length === CANVAS_SIZE) { canvasData.set(saved); canvasLoaded = true; console.log('✅ Холст из файла.'); }
    } catch(e) {}
  }
  if (!canvasLoaded) console.log('⚠️ Чистый холст.');
}

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
  try { fs.writeFileSync(path.join(__dirname,'server_settings.json'), JSON.stringify(serverSettings, null, 2)); } catch(e) {}
}

// ── COIN REWARDS ──
const COINS_PER_PIXEL   = 0.1;  // 1 coin every 10 pixels
const COINS_FOR_LEVEL   = [0, 100, 300, 700, 1500, 3000]; // coins needed per stencil level
const RANK_THRESHOLDS   = [
  { name:'Новичок', icon:'🌱', min:0 },
  { name:'Художник', icon:'🎨', min:50 },
  { name:'Маэстро', icon:'🖌️', min:200 },
  { name:'Легенда', icon:'⭐', min:1000 },
  { name:'Архитектор', icon:'🏛️', min:5000 },
  { name:'Бог Пикселей', icon:'👑', min:20000 },
];

function getRank(pixels) {
  return [...RANK_THRESHOLDS].reverse().find(r => pixels >= r.min) || RANK_THRESHOLDS[0];
}

// ── SERVER START ──
initDatabases().then(() => {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(express.static(path.join(__dirname)));
  app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
    res.send('Pixel Battle Server Running');
  });

  // ── REST: Upload template image via Cloudinary ──
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
        cloudUrl = result.secure_url;
        cloudId  = result.public_id;
      }

      const tmplData = { name, cloudinary_url: cloudUrl, cloudinary_id: cloudId, uploader: username || 'anon', width: 0, height: 0, pixelData: '' };
      await dbSaveTemplate(tmplData);
      res.json({ success: true, url: cloudUrl, name });
    } catch(e) {
      console.error('Upload template error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── REST: Get templates ──
  app.get('/api/templates', async (req, res) => {
    try {
      const list = await dbGetTemplates();
      res.json(list);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  const server = app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT} (${CANVAS_WIDTH}x${CANVAS_HEIGHT})`);
  });

  const wss = new WebSocketServer({ server });
  let pixelBatchBuffer = [];

  function broadcastOnlineCount() {
    const count = Array.from(wss.clients).filter(c => c.isAuthorized).length;
    const buf   = new Uint8Array(3);
    buf[0] = 255; buf[1] = (count >> 8) & 0xFF; buf[2] = count & 0xFF;
    const json  = JSON.stringify({ action: 'online_count', count });
    wss.clients.forEach(c => { if (c.readyState === 1) { c.send(buf); c.send(json); } });
  }

  function broadcastAll(msg) {
    wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(typeof msg === 'string' ? msg : msg); });
  }

  function broadcastToClan(clanName, msg, excludeWs) {
    wss.clients.forEach(c => {
      if (c.readyState === 1 && c.isAuthorized && c.userData?.clan === clanName && c !== excludeWs) {
        c.send(typeof msg === 'string' ? msg : msg);
      }
    });
  }

  wss.on('connection', (ws) => {
    ws.isAuthorized = false;
    ws.userData     = null;

    ws.send(canvasData);
    ws.send(JSON.stringify({ action: 'server_settings', settings: serverSettings }));

    ws.on('message', async (message) => {
      // ── BINARY: pixel placement ──
      if (message.length === 5) {
        if (!ws.isAuthorized || !ws.userData) return;
        const acc = ws.userData;
        if (acc.banned) return ws.send(JSON.stringify({ action: 'toast', message: 'Ваш аккаунт забанен!' }));
        if (acc.timeout_until > Date.now()) {
          const left = Math.ceil((acc.timeout_until - Date.now()) / 1000);
          return ws.send(JSON.stringify({ action: 'toast', message: `Таймаут! Осталось: ${left}с` }));
        }
        const x = (message[0] << 8) | message[1];
        const y = (message[2] << 8) | message[3];
        const colorIdx = message[4];
        if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT && colorIdx >= 0 && colorIdx < 32) {
          canvasData[y * CANVAS_WIDTH + x] = colorIdx;
          pixelBatchBuffer.push({ x, y, c: colorIdx });
          isDirty = true;
          acc.pixels = (acc.pixels || 0) + 1;
          // Coins reward
          const prevCoins = acc.coins || 0;
          acc.coins = Math.floor(acc.pixels * COINS_PER_PIXEL);
          const newCoins = acc.coins;
          const rank = getRank(acc.pixels);
          acc.rank = rank.name;
          // Persist to DB
          try {
            await dbSaveAccount(acc.username, {
              pixels: acc.pixels,
              coins:  acc.coins,
              rank:   acc.rank,
            });
            // Clan pixel contribution
            if (acc.clan) {
              const clan = await dbGetClan(acc.clan);
              if (clan) {
                await dbSaveClan(acc.clan, { pixels: (clan.pixels || 0) + 1 });
              }
            }
          } catch(e) {}
          // Notify player if coins increased
          if (Math.floor(newCoins) > Math.floor(prevCoins)) {
            ws.send(JSON.stringify({ action: 'coins_update', coins: acc.coins, pixels: acc.pixels }));
          }
        }
        return;
      }

      // ── JSON ──
      try {
        const data   = JSON.parse(message.toString());
        const action = data.action || data.type;

        // ─ AUTH ─
        if (action === 'auth') {
          const username    = (data.username || '').trim();
          const password    = (data.password || '').trim();
          const email       = (data.email || '').trim();
          const is_register = data.is_register;

          if (!username || !password)
            return ws.send(JSON.stringify({ action: 'toast', message: 'Пустые поля логина/пароля' }));

          if (is_register) {
            const existing = await dbGetAccount(username);
            if (existing) return ws.send(JSON.stringify({ action: 'toast', message: 'Ник уже занят!' }));
            let role = 'user';
            if ((username === 'd3cord' && email === 'otarasik10@gmail.com') || username === ADMIN_USERNAME) role = 'admin';
            const newUser = { username, password, email, role, pixels: 0, rank: 'Новичок', emoji: '👾', banned: false, timeout_until: 0, coins: 0, clan: '', stencil_level: 0, purchased_levels: [] };
            await dbSaveAccount(username, newUser);
            ws.userData = { ...newUser };
          } else {
            const acc = await dbGetAccount(username);
            if (!acc) return ws.send(JSON.stringify({ action: 'toast', message: 'Аккаунт не найден!' }));
            if (acc.password !== password) return ws.send(JSON.stringify({ action: 'toast', message: 'Неверный пароль!' }));
            ws.userData = { ...acc, username };
          }

          // Ensure d3cord is always admin
          if (username === 'd3cord' && ws.userData.email === 'otarasik10@gmail.com') {
            ws.userData.role = 'admin';
          }

          if (ws.userData.banned)
            return ws.send(JSON.stringify({ action: 'toast', message: 'Ваш аккаунт заблокирован!' }));

          ws.isAuthorized = true;
          ws.send(JSON.stringify({
            action:         'auth_success',
            username:       ws.userData.username,
            role:           ws.userData.role,
            pixels:         ws.userData.pixels || 0,
            rank:           ws.userData.rank   || 'Новичок',
            emoji:          ws.userData.emoji  || '👾',
            coins:          ws.userData.coins  || 0,
            clan:           ws.userData.clan   || '',
            stencil_level:  ws.userData.stencil_level || 0,
            purchased_levels: ws.userData.purchased_levels || [],
            canvas_w:       CANVAS_WIDTH,
            canvas_h:       CANVAS_HEIGHT,
            settings:       serverSettings,
          }));
          broadcastOnlineCount();
          ws.send(canvasData);
          console.log(`✅ ${username} авторизован.`);
        }

        // ─ LEADERBOARD ─
        else if (action === 'get_leaderboard') {
          const allAccs  = await dbGetAllAccounts();
          const players  = allAccs
            .map(a => ({ username: a.username, pixels: a.pixels || 0, emoji: a.emoji || '👾', rank: a.rank || 'Новичок' }))
            .sort((a, b) => b.pixels - a.pixels)
            .slice(0, 30);
          const allClans = await dbGetAllClans();
          const clanTop  = allClans
            .map(c => ({ name: c.name, tag: c.tag || '', pixels: c.pixels || 0, members: (c.members || []).length }))
            .sort((a, b) => b.pixels - a.pixels)
            .slice(0, 20);
          ws.send(JSON.stringify({ action: 'leaderboard_data', players, clans: clanTop }));
        }

        // ─ CURSOR ─
        else if (action === 'cursor') {
          if (!ws.isAuthorized || !ws.userData) return;
          if (!serverSettings.cursorTrackingEnabled && !(ws.userData.clan && data.clan_only)) return;
          const msg = JSON.stringify({ action: 'cursor', u: ws.userData.username, x: data.x, y: data.y, c: data.c, emoji: ws.userData.emoji || '👾', clan: ws.userData.clan || '' });
          if (data.clan_only && ws.userData.clan) {
            broadcastToClan(ws.userData.clan, msg, ws);
          } else {
            wss.clients.forEach(c => { if (c !== ws && c.readyState === 1 && c.isAuthorized) c.send(msg); });
          }
        }

        // ─ SAVE EMOJI ─
        else if (action === 'save_emoji') {
          if (!ws.isAuthorized) return;
          ws.userData.emoji = data.emoji || '👾';
          await dbSaveAccount(ws.userData.username, { emoji: ws.userData.emoji });
          ws.send(JSON.stringify({ action: 'toast', message: 'Аватар сохранён!' }));
        }

        // ─ CLAN ACTIONS ─
        else if (action === 'clan_create') {
          if (!ws.isAuthorized) return;
          const { name, tag, description } = data;
          if (!name || name.length < 2 || name.length > 24) return ws.send(JSON.stringify({ action: 'toast', message: 'Название клана: 2–24 символа' }));
          const existing = await dbGetClan(name);
          if (existing) return ws.send(JSON.stringify({ action: 'toast', message: 'Клан с таким именем уже есть!' }));
          // Cost to create clan
          const acc = await dbGetAccount(ws.userData.username);
          if ((acc.coins || 0) < 50) return ws.send(JSON.stringify({ action: 'toast', message: 'Нужно 50 монет для создания клана!' }));
          if (acc.clan) return ws.send(JSON.stringify({ action: 'toast', message: 'Сначала покиньте текущий клан' }));
          await dbSaveAccount(ws.userData.username, { coins: (acc.coins - 50), clan: name });
          ws.userData.coins = acc.coins - 50;
          ws.userData.clan  = name;
          await dbSaveClan(name, {
            name, tag: tag || name.slice(0,4).toUpperCase(), description: description || '',
            leader: ws.userData.username, members: [ws.userData.username], pixels: 0, share_cursor: false, active_stencil: null,
          });
          ws.send(JSON.stringify({ action: 'clan_update', clan: await dbGetClan(name), coins: ws.userData.coins, message: `Клан "${name}" создан!` }));
        }

        else if (action === 'clan_join') {
          if (!ws.isAuthorized) return;
          const { name } = data;
          const clan = await dbGetClan(name);
          if (!clan) return ws.send(JSON.stringify({ action: 'toast', message: 'Клан не найден' }));
          const acc = await dbGetAccount(ws.userData.username);
          if (acc.clan) return ws.send(JSON.stringify({ action: 'toast', message: 'Сначала покиньте текущий клан' }));
          const newMembers = [...(clan.members || []), ws.userData.username];
          await dbSaveClan(name, { members: newMembers });
          await dbSaveAccount(ws.userData.username, { clan: name });
          ws.userData.clan = name;
          ws.send(JSON.stringify({ action: 'clan_update', clan: { ...clan, members: newMembers }, coins: ws.userData.coins, message: `Вы вступили в клан "${name}"!` }));
          broadcastToClan(name, JSON.stringify({ action: 'clan_member_joined', username: ws.userData.username }), ws);
        }

        else if (action === 'clan_leave') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clanName = ws.userData.clan;
          const clan     = await dbGetClan(clanName);
          if (!clan) return;
          const newMembers = (clan.members || []).filter(m => m !== ws.userData.username);
          if (newMembers.length === 0) {
            await dbDeleteClan(clanName);
          } else {
            const newLeader = clan.leader === ws.userData.username ? newMembers[0] : clan.leader;
            await dbSaveClan(clanName, { members: newMembers, leader: newLeader });
          }
          await dbSaveAccount(ws.userData.username, { clan: '' });
          ws.userData.clan = '';
          ws.send(JSON.stringify({ action: 'clan_update', clan: null, message: `Вы покинули клан` }));
        }

        else if (action === 'clan_toggle_cursor') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const clan = await dbGetClan(ws.userData.clan);
          if (!clan || clan.leader !== ws.userData.username) return ws.send(JSON.stringify({ action: 'toast', message: 'Только лидер может управлять настройками' }));
          const newVal = !clan.share_cursor;
          await dbSaveClan(ws.userData.clan, { share_cursor: newVal });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action: 'clan_settings_update', share_cursor: newVal }), null);
          ws.send(JSON.stringify({ action: 'toast', message: `Показ курсоров в клане: ${newVal ? 'вкл' : 'выкл'}` }));
        }

        else if (action === 'clan_share_stencil') {
          if (!ws.isAuthorized || !ws.userData.clan) return;
          const { stencil } = data;
          await dbSaveClan(ws.userData.clan, { active_stencil: stencil });
          broadcastToClan(ws.userData.clan, JSON.stringify({ action: 'clan_stencil_update', stencil }), ws);
          ws.send(JSON.stringify({ action: 'toast', message: 'Трафарет отправлен соклановцам!' }));
        }

        else if (action === 'clan_get') {
          if (!ws.isAuthorized) return;
          const search = data.name;
          if (search) {
            const clan = await dbGetClan(search);
            ws.send(JSON.stringify({ action: 'clan_data', clan }));
          } else if (ws.userData.clan) {
            const clan = await dbGetClan(ws.userData.clan);
            ws.send(JSON.stringify({ action: 'clan_data', clan }));
          }
        }

        else if (action === 'clan_list') {
          const allClans = await dbGetAllClans();
          ws.send(JSON.stringify({ action: 'clan_list_data', clans: allClans.map(c => ({ name: c.name, tag: c.tag, members: c.members?.length || 0, pixels: c.pixels || 0, description: c.description || '' })) }));
        }

        // ─ STENCIL PURCHASE ─
        else if (action === 'buy_stencil_level') {
          if (!ws.isAuthorized) return;
          const { level } = data;
          const acc = await dbGetAccount(ws.userData.username);
          const cost = COINS_FOR_LEVEL[level];
          if (!cost || (acc.purchased_levels || []).includes(level)) return ws.send(JSON.stringify({ action: 'toast', message: 'Уже куплено или не существует' }));
          if ((acc.coins || 0) < cost) return ws.send(JSON.stringify({ action: 'toast', message: `Нужно ${cost} монет. У вас ${acc.coins || 0}` }));
          const newPurchased = [...(acc.purchased_levels || []), level];
          const newCoins     = acc.coins - cost;
          await dbSaveAccount(ws.userData.username, { coins: newCoins, stencil_level: level, purchased_levels: newPurchased });
          ws.userData.coins           = newCoins;
          ws.userData.stencil_level   = level;
          ws.userData.purchased_levels = newPurchased;
          ws.send(JSON.stringify({ action: 'stencil_level_update', level, coins: newCoins, purchased_levels: newPurchased, message: `Режим трафарета Ур.${level} куплен!` }));
        }

        // ─ GET TEMPLATES ─
        else if (action === 'get_templates') {
          const list = await dbGetTemplates();
          ws.send(JSON.stringify({ action: 'templates_data', templates: list }));
        }

        // ─ ADMIN ─
        else if (action === 'admin_cmd') {
          if (!ws.isAuthorized || ws.userData?.role !== 'admin')
            return ws.send(JSON.stringify({ action: 'toast', message: 'Нет прав доступа.' }));
          const cmd = data.cmd;

          if (cmd === 'get_users') {
            const page  = data.page || 1;
            const limit = 10;
            const allAccs = await dbGetAllAccounts();
            const allUsers = allAccs.map(a => ({
              username: a.username, role: a.role,
              banned: a.banned || false, timeout_until: a.timeout_until || 0,
              pixels: a.pixels || 0, coins: a.coins || 0, clan: a.clan || '',
            }));
            const totalPages = Math.ceil(allUsers.length / limit) || 1;
            const startIndex = (page - 1) * limit;
            ws.send(JSON.stringify({ action: 'admin_users_list', page, total_pages: totalPages, users: allUsers.slice(startIndex, startIndex + limit), total: allUsers.length }));
          }

          else if (cmd === 'ban' || cmd === 'unban') {
            const target = data.target;
            const acc    = await dbGetAccount(target);
            if (acc) {
              const banned = (cmd === 'ban');
              await dbSaveAccount(target, { banned });
              ws.send(JSON.stringify({ action: 'toast', message: `${target} ${banned ? 'забанен' : 'разбанен'}` }));
              if (banned) {
                wss.clients.forEach(c => {
                  if (c.isAuthorized && c.userData?.username === target) c.send(JSON.stringify({ action: 'toast', message: 'Ваш аккаунт забанен.' }));
                });
              }
            }
          }

          else if (cmd === 'timeout') {
            const target = data.target, secs = data.params || 300;
            const acc    = await dbGetAccount(target);
            if (acc) {
              await dbSaveAccount(target, { timeout_until: Date.now() + secs * 1000 });
              ws.send(JSON.stringify({ action: 'toast', message: `${target} получил таймаут на ${secs}с` }));
            }
          }

          else if (cmd === 'set_role') {
            const target = data.target;
            const acc    = await dbGetAccount(target);
            if (acc) {
              await dbSaveAccount(target, { role: data.params });
              ws.send(JSON.stringify({ action: 'toast', message: `Роль ${target} → [${data.params}]` }));
            }
          }

          else if (cmd === 'give_coins') {
            const target = data.target, amount = parseInt(data.params) || 0;
            const acc    = await dbGetAccount(target);
            if (acc && amount > 0) {
              const newCoins = (acc.coins || 0) + amount;
              await dbSaveAccount(target, { coins: newCoins });
              wss.clients.forEach(c => {
                if (c.isAuthorized && c.userData?.username === target) {
                  c.userData.coins = newCoins;
                  c.send(JSON.stringify({ action: 'coins_update', coins: newCoins, pixels: c.userData.pixels || 0 }));
                }
              });
              ws.send(JSON.stringify({ action: 'toast', message: `${target} получил ${amount} монет` }));
            }
          }

          else if (cmd === 'resize_canvas') {
            const newW = data.params.w, newH = data.params.h;
            if (newW > 0 && newH > 0 && newW <= 2048 && newH <= 2048) {
              const newSize   = newW * newH;
              const newCanvas = new Uint8Array(newSize);
              const minW = Math.min(CANVAS_WIDTH, newW), minH = Math.min(CANVAS_HEIGHT, newH);
              for (let y = 0; y < minH; y++) for (let x = 0; x < minW; x++) newCanvas[y * newW + x] = canvasData[y * CANVAS_WIDTH + x];
              CANVAS_WIDTH = newW; CANVAS_HEIGHT = newH; CANVAS_SIZE = newSize; canvasData = newCanvas;
              isDirty = true;
              const resizeMsg = JSON.stringify({ action: 'resize', w: newW, h: newH });
              wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) { c.send(resizeMsg); c.send(canvasData); } });
              ws.send(JSON.stringify({ action: 'toast', message: `Холст изменён до ${newW}x${newH}` }));
            }
          }

          else if (cmd === 'clear_canvas') {
            canvasData.fill(0); isDirty = true;
            wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(canvasData); });
            ws.send(JSON.stringify({ action: 'toast', message: 'Холст очищен!' }));
          }

          else if (cmd === 'draw_shape') {
            // Generic shape: {type:'circle'|'line'|'ellipse'|'rect', params, colorIdx}
            const { type, params, colorIdx } = data;
            if (colorIdx < 0 || colorIdx >= 32) return;
            const pixels = [];
            
            if (type === 'rect') {
              const { x, y, w, h } = params;
              const filled = params.filled !== false;
              for (let py = y; py < y + h; py++) {
                for (let px = x; px < x + w; px++) {
                  const onEdge = px === x || px === x + w - 1 || py === y || py === y + h - 1;
                  if (filled ? true : onEdge) {
                    if (px >= 0 && px < CANVAS_WIDTH && py >= 0 && py < CANVAS_HEIGHT) pixels.push({ x: px, y: py, c: colorIdx });
                  }
                }
              }
            } else if (type === 'circle') {
              const { cx, cy, r } = params;
              const filled = params.filled !== false;
              for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                const dist2 = dx*dx + dy*dy;
                const inside = dist2 <= r*r;
                const onEdge = dist2 >= (r-1)*(r-1);
                if (filled ? inside : onEdge) {
                  const px = cx+dx, py = cy+dy;
                  if (px>=0&&px<CANVAS_WIDTH&&py>=0&&py<CANVAS_HEIGHT) pixels.push({x:px,y:py,c:colorIdx});
                }
              }
            } else if (type === 'line') {
              let { x0, y0, x1, y1 } = params;
              const dx = Math.abs(x1-x0), dy = Math.abs(y1-y0);
              const sx = x0<x1?1:-1, sy = y0<y1?1:-1;
              let err = dx-dy;
              while (true) {
                if (x0>=0&&x0<CANVAS_WIDTH&&y0>=0&&y0<CANVAS_HEIGHT) pixels.push({x:x0,y:y0,c:colorIdx});
                if (x0===x1&&y0===y1) break;
                const e2 = 2*err;
                if (e2>-dy){err-=dy;x0+=sx;}
                if (e2<dx){err+=dx;y0+=sy;}
              }
            } else if (type === 'ellipse') {
              const { cx, cy, rx, ry } = params;
              const filled = params.filled !== false;
              for (let py = cy-ry; py <= cy+ry; py++) for (let px = cx-rx; px <= cx+rx; px++) {
                const dx = px-cx, dy = py-cy;
                const v = (dx*dx)/(rx*rx) + (dy*dy)/(ry*ry);
                const onEdge = v <= 1.05 && v >= 0.85;
                if (filled ? v<=1 : onEdge) {
                  if (px>=0&&px<CANVAS_WIDTH&&py>=0&&py<CANVAS_HEIGHT) pixels.push({x:px,y:py,c:colorIdx});
                }
              }
            }
            if (pixels.length > 0) {
              pixels.forEach(p => { canvasData[p.y*CANVAS_WIDTH+p.x] = p.c; });
              isDirty = true;
              const sendBuf = new Uint8Array(pixels.length*5);
              for (let i=0;i<pixels.length;i++){const p=pixels[i];sendBuf[i*5]=(p.x>>8)&0xFF;sendBuf[i*5+1]=p.x&0xFF;sendBuf[i*5+2]=(p.y>>8)&0xFF;sendBuf[i*5+3]=p.y&0xFF;sendBuf[i*5+4]=p.c;}
              wss.clients.forEach(c => { if (c.readyState===1&&c.isAuthorized) c.send(sendBuf); });
              ws.send(JSON.stringify({ action: 'toast', message: `Фигура нарисована (${pixels.length} пикселей)` }));
            }
          }

          else if (cmd === 'move_area') {
            const { sx, sy, w, h, dx, dy } = data.params;
            const temp = [];
            const pixelsToUpdate = [];

            // Read source and clear it
            for (let py = 0; py < h; py++) {
                for (let px = 0; px < w; px++) {
                    const cx = sx + px, cy = sy + py;
                    if (cx >= 0 && cx < CANVAS_WIDTH && cy >= 0 && cy < CANVAS_HEIGHT) {
                        temp.push({ x: px, y: py, c: canvasData[cy * CANVAS_WIDTH + cx] });
                        canvasData[cy * CANVAS_WIDTH + cx] = 0;
                        pixelsToUpdate.push({ x: cx, y: cy, c: 0 });
                    }
                }
            }

            // Write to destination
            for (const p of temp) {
                const nx = dx + p.x, ny = dy + p.y;
                if (nx >= 0 && nx < CANVAS_WIDTH && ny >= 0 && ny < CANVAS_HEIGHT) {
                    canvasData[ny * CANVAS_WIDTH + nx] = p.c;
                    pixelsToUpdate.push({ x: nx, y: ny, c: p.c });
                }
            }

            isDirty = true;
            if (pixelsToUpdate.length > 0) {
                const sendBuf = new Uint8Array(pixelsToUpdate.length * 5);
                for (let i = 0; i < pixelsToUpdate.length; i++) {
                    const p = pixelsToUpdate[i];
                    sendBuf[i*5] = (p.x>>8)&0xFF; sendBuf[i*5+1] = p.x&0xFF;
                    sendBuf[i*5+2] = (p.y>>8)&0xFF; sendBuf[i*5+3] = p.y&0xFF; sendBuf[i*5+4] = p.c;
                }
                wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(sendBuf); });
            }
            ws.send(JSON.stringify({ action: 'toast', message: `Область перемещена` }));
          }

          else if (cmd === 'place_image') {
            const { pixels } = data.params;
            if (Array.isArray(pixels) && pixels.length > 0) {
              const sendBuf = new Uint8Array(pixels.length * 5);
              for (let i = 0; i < pixels.length; i++) {
                const p = pixels[i];
                if (p.x>=0&&p.x<CANVAS_WIDTH&&p.y>=0&&p.y<CANVAS_HEIGHT&&p.c>=0&&p.c<32) {
                  canvasData[p.y*CANVAS_WIDTH+p.x] = p.c;
                  sendBuf[i*5]=(p.x>>8)&0xFF;sendBuf[i*5+1]=p.x&0xFF;sendBuf[i*5+2]=(p.y>>8)&0xFF;sendBuf[i*5+3]=p.y&0xFF;sendBuf[i*5+4]=p.c;
                }
              }
              isDirty = true;
              wss.clients.forEach(c => { if (c.readyState===1&&c.isAuthorized) c.send(sendBuf); });
              ws.send(JSON.stringify({ action: 'toast', message: `Картинка загружена (${pixels.length} пикселей)` }));
            }
          }

          else if (cmd === 'broadcast') {
            const msg = data.params || '';
            if (msg) broadcastAll(JSON.stringify({ action: 'toast', message: `📢 Админ: ${msg}` }));
          }

          else if (cmd === 'send_dm') {
            const target = data.target, msg = data.params;
            if (target && msg) {
              wss.clients.forEach(c => {
                if (c.isAuthorized && c.userData?.username === target) c.send(JSON.stringify({ action: 'toast', message: `💬 Лс от Админа: ${msg}` }));
              });
            }
          }

          else if (cmd === 'toggle_cursors') {
            serverSettings.cursorTrackingEnabled = !!data.params;
            await saveSettings();
            broadcastAll(JSON.stringify({ action: 'server_settings', settings: serverSettings }));
            ws.send(JSON.stringify({ action: 'toast', message: `Курсоры: ${serverSettings.cursorTrackingEnabled ? 'включены' : 'выключены'}` }));
          }

          else if (cmd === 'set_cooldown') {
            serverSettings.cooldownMs = Math.max(500, Math.min(60000, parseInt(data.params) || 3000));
            await saveSettings();
            broadcastAll(JSON.stringify({ action: 'server_settings', settings: serverSettings }));
            ws.send(JSON.stringify({ action: 'toast', message: `Cooldown: ${serverSettings.cooldownMs}ms` }));
          }

          else if (cmd === 'admin_stats') {
            const allAccs = await dbGetAllAccounts();
            ws.send(JSON.stringify({
              action: 'admin_stats_data',
              total_users:  allAccs.length,
              online:       Array.from(wss.clients).filter(c=>c.isAuthorized).length,
              banned:       allAccs.filter(a=>a.banned).length,
              total_pixels: allAccs.reduce((s,a)=>s+(a.pixels||0),0),
              canvas_w:     CANVAS_WIDTH,
              canvas_h:     CANVAS_HEIGHT,
            }));
          }
        }

      } catch(e) { /* ignore parse errors */ }
    });

    ws.on('close', () => { broadcastOnlineCount(); });
    ws.on('error', () => {});
  });

  // Broadcast pixel batches every 50ms
  setInterval(() => {
    if (pixelBatchBuffer.length === 0) return;
    const batch   = pixelBatchBuffer.splice(0, pixelBatchBuffer.length);
    const sendBuf = new Uint8Array(batch.length * 5);
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i];
      sendBuf[i*5]=(p.x>>8)&0xFF;sendBuf[i*5+1]=p.x&0xFF;sendBuf[i*5+2]=(p.y>>8)&0xFF;sendBuf[i*5+3]=p.y&0xFF;sendBuf[i*5+4]=p.c;
    }
    wss.clients.forEach(c => { if (c.readyState===1&&c.isAuthorized) c.send(sendBuf); });
  }, 50);

  setInterval(persistCanvas, 10000);

  process.on('SIGINT',  async () => { isDirty = true; await persistCanvas(); process.exit(0); });
  process.on('SIGTERM', async () => { isDirty = true; await persistCanvas(); process.exit(0); });
});