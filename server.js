const express = require('express');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

// Try to load upstash redis if env vars present
let Redis = null;
try { Redis = require('@upstash/redis').Redis; } catch(e) {}

// === НАСТРОЙКИ ===
const PORT = process.env.PORT || 3000;
const CANVAS_FILE = path.join(__dirname, 'canvas.bin');
const META_FILE = path.join(__dirname, 'canvas_meta.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const SETTINGS_FILE = path.join(__dirname, 'server_settings.json');
const ADMIN_USERNAME = "Yamiko";

let CANVAS_WIDTH = 256;
let CANVAS_HEIGHT = 256;
let CANVAS_SIZE = CANVAS_WIDTH * CANVAS_HEIGHT;
let canvasData = null;
let isDirty = false; // Flag to avoid redundant saves

// === SERVER SETTINGS ===
let serverSettings = {
  cursorTrackingEnabled: false,
  cooldownMs: 3000
};
if (fs.existsSync(SETTINGS_FILE)) {
  try { serverSettings = { ...serverSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch(e) {}
}
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(serverSettings, null, 2));
}

// === ACCOUNTS ===
let accounts = {};
if (fs.existsSync(ACCOUNTS_FILE)) {
  try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch(e) { console.error("❌ Ошибка чтения accounts.json:", e); }
}
// Ensure d3cord is admin
if (accounts["d3cord"] && accounts["d3cord"].email === "otarasik10@gmail.com") {
  accounts["d3cord"].role = "admin";
}
function saveAccounts() {
  try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2)); } catch(e) {}
}
saveAccounts();

// === REDIS ===
let redis = null;
if (Redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

// === INIT DATABASES ===
async function initDatabases() {
  // Load meta (canvas size)
  let metaLoaded = false;
  if (redis) {
    try {
      const metaRaw = await redis.get('canvas_meta');
      if (metaRaw) {
        const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw;
        if (meta && meta.w && meta.h) { CANVAS_WIDTH = meta.w; CANVAS_HEIGHT = meta.h; metaLoaded = true; }
      }
    } catch(e) { console.error("❌ Redis meta error:", e.message); }
  }
  if (!metaLoaded && fs.existsSync(META_FILE)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      if (meta.w && meta.h) { CANVAS_WIDTH = meta.w; CANVAS_HEIGHT = meta.h; }
    } catch(e) {}
  }

  CANVAS_SIZE = CANVAS_WIDTH * CANVAS_HEIGHT;
  canvasData = new Uint8Array(CANVAS_SIZE);
  // Index 0 = white (first palette color) — canvas background is white
  canvasData.fill(0);

  // Load canvas data
  let canvasLoaded = false;
  if (redis) {
    try {
      console.log("⏳ Загружаем холст из Redis...");
      const savedB64 = await redis.get('pixel_canvas');
      if (savedB64) {
        const buf = Buffer.from(savedB64, 'base64');
        if (buf.length === CANVAS_SIZE) {
          canvasData.set(buf);
          canvasLoaded = true;
          console.log("✅ Холст загружен из Redis!");
        } else {
          console.log(`⚠️ Redis холст ${buf.length} != ${CANVAS_SIZE}. Пробуем локальный файл...`);
        }
      }
    } catch(e) { console.error("❌ Redis canvas load error:", e.message); }
  }

  if (!canvasLoaded && fs.existsSync(CANVAS_FILE)) {
    try {
      const savedData = fs.readFileSync(CANVAS_FILE);
      if (savedData.length === CANVAS_SIZE) {
        canvasData.set(savedData);
        canvasLoaded = true;
        console.log("✅ Холст загружен из локального файла.");
      } else {
        console.log(`⚠️ Локальный холст ${savedData.length} != ${CANVAS_SIZE}. Начинаем с чистого.`);
      }
    } catch(e) { console.error("❌ Canvas file read error:", e); }
  }

  if (!canvasLoaded) console.log("⚠️ Холст не найден. Начинаем с чистого белого холста.");
}

// === SAVE ===
async function persistCanvas() {
  if (!isDirty) return;
  isDirty = false;
  const b64 = Buffer.from(canvasData).toString('base64');
  const meta = JSON.stringify({ w: CANVAS_WIDTH, h: CANVAS_HEIGHT });

  if (redis) {
    try {
      await redis.set('canvas_meta', meta);
      await redis.set('pixel_canvas', b64);
    } catch(e) { console.error("❌ Redis save error:", e.message); }
  }
  try {
    fs.writeFileSync(META_FILE, meta);
    fs.writeFileSync(CANVAS_FILE, canvasData);
    saveAccounts();
  } catch(e) { console.error("❌ Local save error:", e); }
}

// === START SERVER ===
initDatabases().then(() => {
  const app = express();
  app.use(express.static(path.join(__dirname)));
  app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
    res.send('Pixel Battle Server Running');
  });

  const server = app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT} (${CANVAS_WIDTH}x${CANVAS_HEIGHT})`);
  });

  const wss = new WebSocketServer({ server });
  let pixelBatchBuffer = [];

  function broadcastOnlineCount() {
    const count = Array.from(wss.clients).filter(c => c.isAuthorized).length;
    const buf = new Uint8Array(3);
    buf[0] = 255; buf[1] = (count >> 8) & 0xFF; buf[2] = count & 0xFF;
    const json = JSON.stringify({ action: "online_count", count });
    wss.clients.forEach(c => {
      if (c.readyState === 1) { c.send(buf); c.send(json); }
    });
  }

  function broadcastAll(msg) {
    if (typeof msg === 'string') {
      wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(msg); });
    } else {
      wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(msg); });
    }
  }

  wss.on('connection', (ws) => {
    ws.isAuthorized = false;
    ws.userData = null;

    // Send canvas immediately so background is visible even before auth
    ws.send(canvasData);
    // Send server settings so client knows cursor tracking state
    ws.send(JSON.stringify({ action: 'server_settings', settings: serverSettings }));

    ws.on('message', async (message) => {
      // === BINARY: Pixel placement (5 bytes) ===
      if (message.length === 5) {
        if (!ws.isAuthorized || !ws.userData) return;
        if (ws.userData.banned) return ws.send(JSON.stringify({ action: "toast", message: "Ваш аккаунт забанен!" }));
        if (ws.userData.timeout_until > Date.now()) {
          const left = Math.ceil((ws.userData.timeout_until - Date.now()) / 1000);
          return ws.send(JSON.stringify({ action: "toast", message: `Таймаут! Осталось: ${left}с` }));
        }

        const x = (message[0] << 8) | message[1];
        const y = (message[2] << 8) | message[3];
        const colorIdx = message[4];

        if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT && colorIdx >= 0 && colorIdx < 32) {
          const idx = y * CANVAS_WIDTH + x;
          canvasData[idx] = colorIdx;
          pixelBatchBuffer.push({ x, y, c: colorIdx });
          isDirty = true;
          ws.userData.pixels = (ws.userData.pixels || 0) + 1;
          if (accounts[ws.userData.username]) accounts[ws.userData.username].pixels = ws.userData.pixels;
        }
        return;
      }

      // === JSON ===
      try {
        const data = JSON.parse(message.toString());
        const action = data.action || data.type;

        // === AUTH ===
        if (action === 'auth') {
          const username = (data.username || '').trim();
          const password = (data.password || '').trim();
          const email = (data.email || '').trim();
          const is_register = data.is_register;

          if (!username || !password) return ws.send(JSON.stringify({ action: 'toast', message: 'Пустые поля логина/пароля' }));

          if (is_register) {
            if (accounts[username]) return ws.send(JSON.stringify({ action: 'toast', message: 'Ник уже занят!' }));
            let role = 'user';
            if ((username === 'd3cord' && email === 'otarasik10@gmail.com') || username === ADMIN_USERNAME) role = 'admin';
            const newUser = { password, email, role, pixels: 0, rank: 'Новичок', avatar: '', emoji: '👾', banned: false, timeout_until: 0 };
            accounts[username] = newUser;
            saveAccounts();
            if (redis) try { await redis.set(`user:${username}`, newUser); } catch(e) {}
            ws.userData = { username, ...newUser };
          } else {
            if (!accounts[username]) return ws.send(JSON.stringify({ action: 'toast', message: 'Аккаунт не найден!' }));
            if (accounts[username].password !== password) return ws.send(JSON.stringify({ action: 'toast', message: 'Неверный пароль!' }));
            ws.userData = { username, ...accounts[username] };
          }

          if (ws.userData.banned) return ws.send(JSON.stringify({ action: 'toast', message: 'Ваш аккаунт заблокирован!' }));

          ws.isAuthorized = true;
          ws.send(JSON.stringify({
            action: 'auth_success',
            username: ws.userData.username,
            role: ws.userData.role,
            pixels: ws.userData.pixels || 0,
            rank: ws.userData.rank || 'Новичок',
            emoji: ws.userData.emoji || '👾',
            canvas_w: CANVAS_WIDTH,
            canvas_h: CANVAS_HEIGHT,
            settings: serverSettings
          }));
          broadcastOnlineCount();
          // Send canvas again after auth to make sure client has latest
          ws.send(canvasData);
          console.log(`✅ ${username} авторизован.`);
        }

        // === LEADERBOARD ===
        else if (action === 'get_leaderboard') {
          const tops = Object.keys(accounts)
            .map(k => ({ username: k, pixels: accounts[k].pixels || 0, emoji: accounts[k].emoji || '👾' }))
            .sort((a, b) => b.pixels - a.pixels)
            .slice(0, 20);
          ws.send(JSON.stringify({ action: 'leaderboard_data', data: tops }));
        }

        // === CURSOR ===
        else if (action === 'cursor') {
          if (!ws.isAuthorized || !ws.userData) return;
          if (!serverSettings.cursorTrackingEnabled) return; // Only broadcast if admin enabled
          const msg = JSON.stringify({
            action: 'cursor',
            u: ws.userData.username,
            x: data.x, y: data.y, c: data.c,
            emoji: ws.userData.emoji || accounts[ws.userData.username]?.emoji || '👾'
          });
          wss.clients.forEach(client => {
            if (client !== ws && client.readyState === 1 && client.isAuthorized) client.send(msg);
          });
        }

        // === SAVE EMOJI ===
        else if (action === 'save_emoji') {
          if (!ws.isAuthorized || !ws.userData) return;
          const emoji = data.emoji || '👾';
          ws.userData.emoji = emoji;
          if (accounts[ws.userData.username]) {
            accounts[ws.userData.username].emoji = emoji;
            saveAccounts();
          }
          ws.send(JSON.stringify({ action: 'toast', message: 'Аватар сохранён!' }));
        }

        // === ADMIN ===
        else if (action === 'admin_cmd') {
          if (!ws.isAuthorized || !ws.userData || ws.userData.role !== 'admin') {
            return ws.send(JSON.stringify({ action: 'toast', message: 'Нет прав доступа.' }));
          }
          const cmd = data.cmd;

          if (cmd === 'get_users') {
            const page = data.page || 1;
            const limit = 10;
            const allUsers = Object.keys(accounts).map(u => ({
              username: u, role: accounts[u].role,
              banned: accounts[u].banned || false,
              timeout_until: accounts[u].timeout_until || 0,
              pixels: accounts[u].pixels || 0
            }));
            const totalPages = Math.ceil(allUsers.length / limit) || 1;
            const startIndex = (page - 1) * limit;
            ws.send(JSON.stringify({
              action: 'admin_users_list', page, total_pages: totalPages,
              users: allUsers.slice(startIndex, startIndex + limit),
              total: allUsers.length
            }));
          }

          else if (cmd === 'ban' || cmd === 'unban') {
            const target = data.target;
            if (accounts[target]) {
              accounts[target].banned = (cmd === 'ban');
              saveAccounts();
              if (redis) try { await redis.set(`user:${target}`, accounts[target]); } catch(e) {}
              ws.send(JSON.stringify({ action: 'toast', message: `${target} ${accounts[target].banned ? 'забанен' : 'разбанен'}` }));
              // Kick banned user
              if (cmd === 'ban') {
                wss.clients.forEach(c => {
                  if (c.isAuthorized && c.userData?.username === target) {
                    c.send(JSON.stringify({ action: 'toast', message: 'Ваш аккаунт забанен.' }));
                  }
                });
              }
            }
          }

          else if (cmd === 'timeout') {
            const target = data.target;
            const secs = data.params || 300;
            if (accounts[target]) {
              accounts[target].timeout_until = Date.now() + (secs * 1000);
              saveAccounts();
              if (redis) try { await redis.set(`user:${target}`, accounts[target]); } catch(e) {}
              ws.send(JSON.stringify({ action: 'toast', message: `${target} получил таймаут на ${secs}с` }));
            }
          }

          else if (cmd === 'set_role') {
            const target = data.target;
            if (accounts[target]) {
              accounts[target].role = data.params;
              saveAccounts();
              if (redis) try { await redis.set(`user:${target}`, accounts[target]); } catch(e) {}
              ws.send(JSON.stringify({ action: 'toast', message: `Роль ${target} → [${data.params}]` }));
            }
          }

          else if (cmd === 'resize_canvas') {
            const newW = data.params.w, newH = data.params.h;
            if (newW > 0 && newH > 0 && newW <= 2048 && newH <= 2048) {
              const newSize = newW * newH;
              const newCanvas = new Uint8Array(newSize); // fills with 0 = white
              const minW = Math.min(CANVAS_WIDTH, newW);
              const minH = Math.min(CANVAS_HEIGHT, newH);
              for (let y = 0; y < minH; y++) {
                for (let x = 0; x < minW; x++) {
                  newCanvas[y * newW + x] = canvasData[y * CANVAS_WIDTH + x];
                }
              }
              CANVAS_WIDTH = newW; CANVAS_HEIGHT = newH; CANVAS_SIZE = newSize; canvasData = newCanvas;
              isDirty = true;
              const resizeMsg = JSON.stringify({ action: 'resize', w: newW, h: newH });
              wss.clients.forEach(c => {
                if (c.readyState === 1 && c.isAuthorized) { c.send(resizeMsg); c.send(canvasData); }
              });
              ws.send(JSON.stringify({ action: 'toast', message: `Холст изменён до ${newW}x${newH}` }));
            }
          }

          else if (cmd === 'clear_canvas') {
            canvasData.fill(0); isDirty = true;
            wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(canvasData); });
            ws.send(JSON.stringify({ action: 'toast', message: 'Холст очищен!' }));
          }

          else if (cmd === 'fill_rect') {
            // Fill a rectangle area with a color
            const { x, y, w, h, colorIdx } = data.params;
            if (colorIdx >= 0 && colorIdx < 32) {
              const pixels = [];
              for (let row = y; row < Math.min(y + h, CANVAS_HEIGHT); row++) {
                for (let col = x; col < Math.min(x + w, CANVAS_WIDTH); col++) {
                  canvasData[row * CANVAS_WIDTH + col] = colorIdx;
                  pixels.push({ x: col, y: row, c: colorIdx });
                }
              }
              isDirty = true;
              // Broadcast in batches
              const batchSize = pixels.length;
              const sendBuf = new Uint8Array(batchSize * 5);
              for (let i = 0; i < batchSize; i++) {
                const p = pixels[i];
                sendBuf[i*5] = (p.x >> 8) & 0xFF; sendBuf[i*5+1] = p.x & 0xFF;
                sendBuf[i*5+2] = (p.y >> 8) & 0xFF; sendBuf[i*5+3] = p.y & 0xFF;
                sendBuf[i*5+4] = p.c;
              }
              wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(sendBuf); });
              ws.send(JSON.stringify({ action: 'toast', message: `Залито ${pixels.length} пикселей` }));
            }
          }

          else if (cmd === 'place_image') {
            // Place image pixels array [{x,y,c}] onto canvas
            const { pixels } = data.params;
            if (Array.isArray(pixels) && pixels.length > 0) {
              const batchSize = pixels.length;
              const sendBuf = new Uint8Array(batchSize * 5);
              for (let i = 0; i < batchSize; i++) {
                const p = pixels[i];
                if (p.x >= 0 && p.x < CANVAS_WIDTH && p.y >= 0 && p.y < CANVAS_HEIGHT && p.c >= 0 && p.c < 32) {
                  canvasData[p.y * CANVAS_WIDTH + p.x] = p.c;
                  sendBuf[i*5] = (p.x >> 8) & 0xFF; sendBuf[i*5+1] = p.x & 0xFF;
                  sendBuf[i*5+2] = (p.y >> 8) & 0xFF; sendBuf[i*5+3] = p.y & 0xFF;
                  sendBuf[i*5+4] = p.c;
                }
              }
              isDirty = true;
              wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(sendBuf); });
              ws.send(JSON.stringify({ action: 'toast', message: `Картинка загружена (${batchSize} пикселей)` }));
            }
          }

          else if (cmd === 'broadcast') {
            const msg = data.params || '';
            if (msg) {
              const broadMsg = JSON.stringify({ action: 'toast', message: `📢 Админ: ${msg}` });
              broadcastAll(broadMsg);
            }
          }

          else if (cmd === 'send_dm') {
            const target = data.target, msg = data.params;
            if (target && msg) {
              wss.clients.forEach(c => {
                if (c.isAuthorized && c.userData?.username === target) {
                  c.send(JSON.stringify({ action: 'toast', message: `💬 Лс от Админа: ${msg}` }));
                }
              });
            }
          }

          else if (cmd === 'toggle_cursors') {
            serverSettings.cursorTrackingEnabled = !!data.params;
            saveSettings();
            broadcastAll(JSON.stringify({ action: 'server_settings', settings: serverSettings }));
            ws.send(JSON.stringify({ action: 'toast', message: `Курсоры: ${serverSettings.cursorTrackingEnabled ? 'включены' : 'выключены'}` }));
          }

          else if (cmd === 'set_cooldown') {
            serverSettings.cooldownMs = Math.max(500, Math.min(60000, parseInt(data.params) || 3000));
            saveSettings();
            broadcastAll(JSON.stringify({ action: 'server_settings', settings: serverSettings }));
            ws.send(JSON.stringify({ action: 'toast', message: `Cooldown: ${serverSettings.cooldownMs}ms` }));
          }
        }

      } catch(e) {
        // ignore parse errors
      }
    });

    ws.on('close', () => { broadcastOnlineCount(); });
    ws.on('error', () => {});
  });

  // Broadcast pixel batches every 50ms
  setInterval(() => {
    if (pixelBatchBuffer.length === 0) return;
    const batch = pixelBatchBuffer.splice(0, pixelBatchBuffer.length);
    const sendBuf = new Uint8Array(batch.length * 5);
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i];
      sendBuf[i*5] = (p.x >> 8) & 0xFF; sendBuf[i*5+1] = p.x & 0xFF;
      sendBuf[i*5+2] = (p.y >> 8) & 0xFF; sendBuf[i*5+3] = p.y & 0xFF;
      sendBuf[i*5+4] = p.c;
    }
    wss.clients.forEach(c => { if (c.readyState === 1 && c.isAuthorized) c.send(sendBuf); });
  }, 50);

  // Persist canvas every 10 seconds (only if dirty)
  setInterval(persistCanvas, 10000);

  // Persist immediately on process exit
  process.on('SIGINT', async () => {
    isDirty = true;
    await persistCanvas();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    isDirty = true;
    await persistCanvas();
    process.exit(0);
  });
});
