const express = require('express');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

// === НАСТРОЙКИ СЕРВЕРА ===
const PORT = process.env.PORT || 3000;
const CANVAS_WIDTH = 256;
const CANVAS_HEIGHT = 256;
const CANVAS_SIZE = CANVAS_WIDTH * CANVAS_HEIGHT;
const CANVAS_FILE = path.join(__dirname, 'canvas.bin');

let canvasData = new Uint8Array(CANVAS_SIZE);
canvasData.fill(0); // 0 = Белый цвет

// === ПОДКЛЮЧЕНИЕ REDIS (С ЗАЩИТОЙ ОТ ОБРЫВОВ) ===
const redisClient = createClient({
    url: process.env.REDIS_URL,
    pingInterval: 120000, // Пингуем базу каждые 2 минуты, чтобы не засыпала
    socket: {
        reconnectStrategy: (retries) => {
            console.log(`⚠️ Потеряно соединение с Redis. Попытка переподключения #${retries}...`);
            // Если упало - пробуем переподключиться через 3 секунды (максимум 20 раз)
            if (retries > 20) {
                console.error("❌ Redis окончательно отвалился. Больше не пытаемся.");
                return new Error("Retry time exhausted");
            }
            return 3000; 
        }
    }
});

// Отлавливаем ошибки, чтобы сервер не падал (красный крестик не убивал процесс)
redisClient.on('error', (err) => {
    // Мы глушим вывод ошибки, если это просто закрытие сокета (так как стратегия переподключения сработает сама)
    if (!err.message.includes('Socket closed unexpectedly')) {
        console.error('❌ Ошибка Redis:', err);
    }
});

async function initDatabases() {
    if (process.env.REDIS_URL) {
        try {
            await redisClient.connect();
            console.log("✅ Успешное подключение к Redis!");
            
            const savedB64 = await redisClient.get('pixel_canvas');
            if (savedB64) {
                const buf = Buffer.from(savedB64, 'base64');
                if (buf.length === CANVAS_SIZE) {
                    canvasData.set(buf);
                    console.log("✅ Холст успешно восстановлен из Redis!");
                    return; 
                }
            }
            console.log("⚠️ В Redis пусто или размер холста не совпадает. Начинаем с чистого листа.");
        } catch (e) {
            console.error("❌ Не удалось загрузить из Redis. Пробуем локальный файл...", e);
        }
    } else {
        console.log("⚠️ REDIS_URL не указан в Environment. Используем только локальное сохранение.");
    }

    // Фоллбэк на локальный файл
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

// Инициализируем базы и стартуем сервер
initDatabases().then(() => {
    const app = express();
    app.get('/', (req, res) => res.send('Pixel Battle Server is Running with Redis!'));

    const server = app.listen(PORT, () => {
        console.log(`🚀 WebSocket сервер запущен на порту ${PORT}`);
    });

    const wss = new WebSocketServer({ server });
    let pixelBatchBuffer = [];

    function broadcastOnlineCount() {
        const count = wss.clients.size;
        const buffer = new Uint8Array(3);
        buffer[0] = 255; 
        buffer[1] = (count >> 8) & 0xFF;
        buffer[2] = count & 0xFF;

        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(buffer);
            }
        });
    }

    wss.on('connection', (ws) => {
        console.log("Пользователь подключился. Всего онлайн:", wss.clients.size);
        
        ws.send(canvasData);
        broadcastOnlineCount();

        ws.on('message', (message) => {
            if (Buffer.isBuffer(message) && message.length === 5) {
                const x = (message[0] << 8) | message[1];
                const y = (message[2] << 8) | message[3];
                const colorIdx = message[4];

                if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT && colorIdx >= 0 && colorIdx < 32) {
                    const idx = y * CANVAS_WIDTH + x;
                    if (canvasData[idx] !== colorIdx) {
                        canvasData[idx] = colorIdx; 
                        pixelBatchBuffer.push({ x, y, c: colorIdx }); 
                    }
                }
            }
        });

        ws.on('close', () => {
            console.log("Пользователь отключился. Онлайн:", wss.clients.size);
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
                if (client.readyState === 1) { 
                    client.send(sendBuffer);
                }
            });
            pixelBatchBuffer = [];
        }
    }, 100);

    // === БЭКАП ХОЛСТА (каждые 15 секунд) ===
    setInterval(async () => {
        if (redisClient.isOpen) {
            try {
                await redisClient.set('pixel_canvas', Buffer.from(canvasData).toString('base64'));
            } catch (e) {
                console.error("❌ Ошибка сохранения в Redis:", e);
            }
        }
        
        try {
            fs.writeFileSync(CANVAS_FILE, canvasData);
        } catch (e) {}
    }, 15000);
});