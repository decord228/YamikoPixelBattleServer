const express = require('express');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

// === НАСТРОЙКИ СЕРВЕРА ===
const PORT = process.env.PORT || 3000;
const CANVAS_WIDTH = 256;
const CANVAS_HEIGHT = 256;
const CANVAS_SIZE = CANVAS_WIDTH * CANVAS_HEIGHT;
const CANVAS_FILE = path.join(__dirname, 'canvas.bin');

// Инициализируем холст в оперативной памяти (1 байт = 1 пиксель = индекс цвета)
// По умолчанию заполняем 0 (Белый цвет из твоей палитры)
let canvasData = new Uint8Array(CANVAS_SIZE);
canvasData.fill(0);

// Пытаемся загрузить сохраненный холст, если сервер перезапускался
if (fs.existsSync(CANVAS_FILE)) {
    try {
        const savedData = fs.readFileSync(CANVAS_FILE);
        if (savedData.length === CANVAS_SIZE) {
            canvasData.set(savedData);
            console.log("✅ Холст успешно восстановлен из canvas.bin");
        } else {
            console.warn("⚠️ Размер canvas.bin не совпадает, начинаем с чистого листа.");
        }
    } catch (e) {
        console.error("❌ Ошибка чтения canvas.bin:", e);
    }
}

// === ПОДНЯТИЕ СЕРВЕРА ===
const app = express();
// Простой HTTP ответ, чтобы Render понимал, что сервер жив
app.get('/', (req, res) => res.send('Pixel Battle Server is Running!'));

const server = app.listen(PORT, () => {
    console.log(`🚀 WebSocket сервер запущен на порту ${PORT}`);
});

const wss = new WebSocketServer({ server });

// Буфер для сбора всех кликов за короткий промежуток времени (Батчинг)
let pixelBatchBuffer = [];

wss.on('connection', (ws) => {
    console.log("Пользователь подключился. Всего онлайн:", wss.clients.size);

    // При подключении сразу отправляем клиенту ВЕСЬ холст бинарником (65 КБ)
    // Клиент поймет, что если пришел большой файл — это фулл-синк
    ws.send(canvasData);

    ws.on('message', (message) => {
        // Ожидаем бинарное сообщение ровно 5 байт: [X_high, X_low, Y_high, Y_low, ColorIndex]
        if (Buffer.isBuffer(message) && message.length === 5) {
            const x = (message[0] << 8) | message[1];
            const y = (message[2] << 8) | message[3];
            const colorIdx = message[4];

            // Валидация координат и цвета (защита от читеров)
            if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT && colorIdx >= 0 && colorIdx < 32) {
                const idx = y * CANVAS_WIDTH + x;
                
                // Если цвет действительно изменился
                if (canvasData[idx] !== colorIdx) {
                    canvasData[idx] = colorIdx; // Пишем в оперативку (наносекунды)
                    pixelBatchBuffer.push({ x, y, c: colorIdx }); // Добавляем в очередь на рассылку
                }
            }
        }
    });

    ws.on('close', () => {
        console.log("Пользователь отключился. Онлайн:", wss.clients.size);
    });
});

// === СИСТЕМА БАТЧИНГА И РАССЫЛКИ (ТРОТТЛИНГ) ===
// Рассылаем накопившиеся пиксели всем игрокам 10 раз в секунду
setInterval(() => {
    if (pixelBatchBuffer.length > 0) {
        // Упаковываем массив объектов в сырые байты (по 5 байт на пиксель)
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

        // Рассылаем один пакет всем активным клиентам
        wss.clients.forEach(client => {
            if (client.readyState === 1) { // 1 === OPEN
                client.send(sendBuffer);
            }
        });

        // Очищаем буфер
        pixelBatchBuffer = [];
    }
}, 100);

// === СИСТЕМА БЭКАПОВ ===
// Сохраняем холст на диск каждые 5 секунд
setInterval(() => {
    try {
        fs.writeFileSync(CANVAS_FILE, canvasData);
    } catch (e) {
        console.error("❌ Ошибка сохранения бэкапа:", e);
    }
}, 5000);