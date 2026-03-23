const express = require('express');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

// === НАСТРОЙКИ СЕРВЕРА ===
const PORT = process.env.PORT || 3000;
const CANVAS_WIDTH = 256;
const CANVAS_HEIGHT = 256;
const CANVAS_SIZE = CANVAS_WIDTH * CANVAS_HEIGHT;
const CANVAS_FILE = path.join(__dirname, 'canvas.bin');
const ADMIN_USERNAME = "Yamiko";

let canvasData = new Uint8Array(CANVAS_SIZE);
canvasData.fill(0); 

// === ПОДКЛЮЧЕНИЕ REDIS ===
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
}

async function initDatabases() {
    if (redis) {
        try {
            console.log("⏳ Пытаемся загрузить холст из Upstash Redis...");
            const savedB64 = await redis.get('pixel_canvas');
            
            if (savedB64) {
                const buf = Buffer.from(savedB64, 'base64');
                if (buf.length === CANVAS_SIZE) {
                    canvasData.set(buf);
                    console.log("✅ Холст успешно восстановлен из Redis!");
                    return; 
                }
            }
        } catch (e) {
            console.error("❌ Не удалось загрузить из Redis. Пробуем локальный файл...", e.message);
        }
    }

    if (fs.existsSync(CANVAS_FILE)) {
        try {
            const savedData = fs.readFileSync(CANVAS_FILE);
            if (savedData.length === CANVAS_SIZE) {
                canvasData.set(savedData);
                console.log("✅ Холст восстановлен из локального canvas.bin");
            }
        } catch (e) {
            console.error("❌ Ошибка чтения canvas.bin:", e);
        }
    }
}

initDatabases().then(() => {
    const app = express();
    app.get('/', (req, res) => res.send('Pixel Battle Server is Running with Auth!'));

    const server = app.listen(PORT, () => {
        console.log(`🚀 WebSocket сервер запущен на порту ${PORT}`);
    });

    const wss = new WebSocketServer({ server });
    let pixelBatchBuffer = [];

    function broadcastOnlineCount() {
        const count = Array.from(wss.clients).filter(c => c.isAuthorized).length;
        const buffer = new Uint8Array(3);
        buffer[0] = 255; 
        buffer[1] = (count >> 8) & 0xFF;
        buffer[2] = count & 0xFF;

        wss.clients.forEach(client => {
            if (client.readyState === 1) client.send(buffer);
        });
    }

    wss.on('connection', (ws) => {
        ws.isAuthorized = false;
        ws.userData = null;
        
        // Отправляем холст всем, чтобы был виден фон
        ws.send(canvasData);

        ws.on('message', async (message) => {
            // 1. Обработка пикселей (бинарные пакеты ровно по 5 байт)
            if (message.length === 5) {
                if (!ws.isAuthorized) return; // Блокировка без авторизации

                const x = (message[0] << 8) | message[1];
                const y = (message[2] << 8) | message[3];
                const colorIdx = message[4];

                if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT && colorIdx >= 0 && colorIdx < 32) {
                    const idx = y * CANVAS_WIDTH + x;
                    if (canvasData[idx] !== colorIdx) {
                        canvasData[idx] = colorIdx; 
                        pixelBatchBuffer.push({ x, y, c: colorIdx }); 
                        
                        if (ws.userData) {
                            ws.userData.pixels = (ws.userData.pixels || 0) + 1;
                            if (redis && ws.userData.pixels % 10 === 0) {
                                redis.set(`user:${ws.userData.username}`, ws.userData); 
                            }
                        }
                    }
                }
                return; // Важно прервать выполнение, чтобы не пытаться парсить 5 байт как JSON
            }

            // 2. Обработка текстовых пакетов (JSON) - АВТОРИЗАЦИЯ
            try {
                // Превращаем Buffer обратно в текст и парсим JSON
                const data = JSON.parse(message.toString());
                
                if (data.type === 'auth') {
                    console.log(`Получен запрос авторизации от: ${data.username}`);
                    const { username, password, is_register } = data;
                    
                    if (!username || !password) return ws.send(JSON.stringify({type: 'auth_error', msg: 'Пустые поля'}));
                    
                    const userKey = `user:${username}`;
                    let existing = redis ? await redis.get(userKey) : null;
                    
                    if (is_register) {
                        if (existing) return ws.send(JSON.stringify({type: 'auth_error', msg: 'Ник уже занят'}));
                        const newUser = {
                            password: password, 
                            role: username === ADMIN_USERNAME ? 'admin' : 'user',
                            pixels: 0,
                            rank: 'Новичок',
                            avatar: ''
                        };
                        if (redis) await redis.set(userKey, newUser);
                        ws.userData = { username, ...newUser };
                    } else {
                        if (!existing) return ws.send(JSON.stringify({type: 'auth_error', msg: 'Аккаунт не найден'}));
                        if (existing.password !== password) return ws.send(JSON.stringify({type: 'auth_error', msg: 'Неверный пароль'}));
                        ws.userData = { username, ...existing };
                    }
                    
                    ws.isAuthorized = true;
                    ws.send(JSON.stringify({
                        type: 'auth_ok', 
                        username: ws.userData.username, 
                        role: ws.userData.role,
                        pixels: ws.userData.pixels || 0,
                        rank: ws.userData.rank || 'Новичок'
                    }));
                    broadcastOnlineCount();
                    console.log(`${username} успешно вошел в систему.`);
                }
            } catch(e) {
                // Если прилетел какой-то мусор, который не парсится как JSON, просто игнорим
            }

            // Обработка бинарных пакетов - ПИКСЕЛИ
            if (!ws.isAuthorized) return; 

            if (message.length === 5) {
                const x = (message[0] << 8) | message[1];
                const y = (message[2] << 8) | message[3];
                const colorIdx = message[4];

                if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT && colorIdx >= 0 && colorIdx < 32) {
                    const idx = y * CANVAS_WIDTH + x;
                    if (canvasData[idx] !== colorIdx) {
                        canvasData[idx] = colorIdx; 
                        pixelBatchBuffer.push({ x, y, c: colorIdx }); 
                        
                        if (ws.userData) {
                            ws.userData.pixels = (ws.userData.pixels || 0) + 1;
                            if (redis && ws.userData.pixels % 10 === 0) {
                                redis.set(`user:${ws.userData.username}`, ws.userData); 
                            }
                        }
                    }
                }
            }
        });

        ws.on('close', () => {
            broadcastOnlineCount();
        });
    });

    setInterval(() => {
        if (pixelBatchBuffer.length > 0) {
            const batchSize = pixelBatchBuffer.length;
            const sendBuffer = new Uint8Array(batchSize * 5);
            
            for (let i = 0; i < batchSize; i++) {
                const p = pixelBatchBuffer[i];
                sendBuffer[i * 5 + 0] = (p.x >> 8) & 0xFF;
                sendBuffer[i * 5 + 1] = p.x & 0xFF;
                sendBuffer[i * 5 + 2] = (p.y >> 8) & 0xFF;
                sendBuffer[i * 5 + 3] = p.y & 0xFF;
                sendBuffer[i * 5 + 4] = p.c;
            }

            wss.clients.forEach(client => {
                if (client.readyState === 1 && client.isAuthorized) { 
                    client.send(sendBuffer);
                }
            });
            pixelBatchBuffer = [];
        }
    }, 100);

    setInterval(async () => {
        if (redis) {
            try {
                await redis.set('pixel_canvas', Buffer.from(canvasData).toString('base64'));
            } catch (e) {}
        }
        try { fs.writeFileSync(CANVAS_FILE, canvasData); } catch (e) {}
    }, 15000);
});