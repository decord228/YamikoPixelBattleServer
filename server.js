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
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const ADMIN_USERNAME = "Yamiko"; // Резервный админ

let canvasData = new Uint8Array(CANVAS_SIZE);
canvasData.fill(0); 

// === БАЗА АККАУНТОВ (Локальный кэш для быстрой работы админки) ===
let accounts = {};
if (fs.existsSync(ACCOUNTS_FILE)) {
    try {
        accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    } catch (e) {
        console.error("❌ Ошибка чтения accounts.json:", e);
    }
}

// Принудительно делаем тебя админом при запуске, если аккаунт уже есть
if (accounts["d3cord"] && accounts["d3cord"].email === "otarasik10@gmail.com") {
    accounts["d3cord"].role = "admin";
}
saveAccounts();

function saveAccounts() {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

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
    app.get('/', (req, res) => res.send('Pixel Battle Server is Running with Auth & Admin Panel!'));

    const server = app.listen(PORT, () => {
        console.log(`🚀 WebSocket сервер запущен на порту ${PORT}`);
    });

    const wss = new WebSocketServer({ server });
    let pixelBatchBuffer = [];

    function broadcastOnlineCount() {
        const count = Array.from(wss.clients).filter(c => c.isAuthorized).length;
        // Бинарный пакет для счетчика онлайна
        const buffer = new Uint8Array(3);
        buffer[0] = 255; 
        buffer[1] = (count >> 8) & 0xFF;
        buffer[2] = count & 0xFF;

        // JSON пакет для старых клиентов
        const jsonMsg = JSON.stringify({ action: "online_count", count: count });

        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(buffer);
                client.send(jsonMsg);
            }
        });
    }

    wss.on('connection', (ws) => {
        ws.isAuthorized = false;
        ws.userData = null;
        
        // Отправляем холст всем, чтобы был виден фон
        ws.send(canvasData);

        ws.on('message', async (message) => {
            // 1. ОБРАБОТКА ПИКСЕЛЕЙ (бинарные пакеты ровно по 5 байт)
            if (message.length === 5) {
                if (!ws.isAuthorized || !ws.userData) return;

                // Проверка на бан и таймаут
                if (ws.userData.banned) {
                    return ws.send(JSON.stringify({ action: "toast", message: "Ваш аккаунт забанен!" }));
                }
                if (ws.userData.timeout_until > Date.now()) {
                    const left = Math.ceil((ws.userData.timeout_until - Date.now()) / 1000);
                    return ws.send(JSON.stringify({ action: "toast", message: `Таймаут! Осталось: ${left}с` }));
                }

                const x = (message[0] << 8) | message[1];
                const y = (message[2] << 8) | message[3];
                const colorIdx = message[4];

                if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT && colorIdx >= 0 && colorIdx < 32) {
                    const idx = y * CANVAS_WIDTH + x;
                    if (canvasData[idx] !== colorIdx) {
                        canvasData[idx] = colorIdx; 
                        pixelBatchBuffer.push({ x, y, c: colorIdx }); 
                        
                        // Обновляем статистику пользователя
                        ws.userData.pixels = (ws.userData.pixels || 0) + 1;
                        if (accounts[ws.userData.username]) {
                            accounts[ws.userData.username].pixels = ws.userData.pixels;
                        }
                    }
                }
                return; // Прерываем выполнение, чтобы не парсить 5 байт как JSON
            }

            // 2. ОБРАБОТКА ТЕКСТОВЫХ ПАКЕТОВ (JSON)
            try {
                const data = JSON.parse(message.toString());
                const action = data.action || data.type; // Поддержка обоих вариантов ключей
                
                // === АВТОРИЗАЦИЯ ===
                if (action === 'auth') {
                    console.log(`Получен запрос авторизации от: ${data.username}`);
                    const username = data.username ? data.username.trim() : "";
                    const password = data.password ? data.password.trim() : "";
                    const email = data.email ? data.email.trim() : "";
                    const is_register = data.is_register;
                    
                    if (!username || !password) return ws.send(JSON.stringify({action: 'toast', message: 'Пустые поля логина/пароля'}));
                    
                    if (is_register) {
                        if (accounts[username]) return ws.send(JSON.stringify({action: 'toast', message: 'Ник уже занят!'}));
                        
                        let role = "user";
                        if ((username === "d3cord" && email === "otarasik10@gmail.com") || username === ADMIN_USERNAME) {
                            role = "admin";
                        }

                        const newUser = {
                            password: password, 
                            email: email,
                            role: role,
                            pixels: 0,
                            rank: 'Новичок',
                            avatar: '',
                            banned: false,
                            timeout_until: 0
                        };
                        
                        accounts[username] = newUser;
                        saveAccounts();
                        if (redis) await redis.set(`user:${username}`, newUser);
                        ws.userData = { username, ...newUser };
                    } else {
                        if (!accounts[username]) return ws.send(JSON.stringify({action: 'toast', message: 'Аккаунт не найден!'}));
                        if (accounts[username].password !== password) return ws.send(JSON.stringify({action: 'toast', message: 'Неверный пароль!'}));
                        
                        ws.userData = { username, ...accounts[username] };
                    }

                    if (ws.userData.banned) {
                        return ws.send(JSON.stringify({ action: "toast", message: "Ваш аккаунт заблокирован!" }));
                    }
                    
                    ws.isAuthorized = true;
                    // Отправляем успешный вход
                    ws.send(JSON.stringify({
                        action: 'auth_success', // Это ждет Godot клиент
                        username: ws.userData.username, 
                        role: ws.userData.role,
                        pixels: ws.userData.pixels || 0,
                        rank: ws.userData.rank || 'Новичок'
                    }));
                    broadcastOnlineCount();
                    console.log(`✅ ${username} успешно вошел в систему.`);
                }
                
                // === АДМИН ПАНЕЛЬ ===
                else if (action === 'admin_cmd') {
                    if (!ws.isAuthorized || !ws.userData || ws.userData.role !== 'admin') {
                        return ws.send(JSON.stringify({ action: "toast", message: "Нет прав доступа." }));
                    }

                    const cmd = data.cmd;
                    if (cmd === "get_users") {
                        const page = data.page || 1;
                        const limit = 5;
                        const allUsers = Object.keys(accounts).map(u => ({
                            username: u,
                            role: accounts[u].role,
                            banned: accounts[u].banned || false,
                            timeout_until: accounts[u].timeout_until || 0
                        }));
                        
                        const totalPages = Math.ceil(allUsers.length / limit) || 1;
                        const startIndex = (page - 1) * limit;
                        const pageUsers = allUsers.slice(startIndex, startIndex + limit);

                        ws.send(JSON.stringify({
                            action: "admin_users_list",
                            page: page,
                            total_pages: totalPages,
                            users: pageUsers
                        }));
                    }
                    else if (cmd === "ban" || cmd === "unban") {
                        const target = data.target;
                        if (accounts[target]) {
                            accounts[target].banned = (cmd === "ban");
                            saveAccounts();
                            if (redis) redis.set(`user:${target}`, accounts[target]);
                            ws.send(JSON.stringify({ action: "toast", message: `Пользователь ${target} ${accounts[target].banned ? 'забанен' : 'разбанен'}` }));
                            // Обновляем список у админа
                            ws.emit('message', JSON.stringify({action: "admin_cmd", cmd: "get_users", page: data.page || 1}));
                        }
                    }
                    else if (cmd === "timeout") {
                        const target = data.target;
                        const durationSeconds = data.params; // Например, 300 секунд
                        if (accounts[target]) {
                            accounts[target].timeout_until = Date.now() + (durationSeconds * 1000);
                            saveAccounts();
                            if (redis) redis.set(`user:${target}`, accounts[target]);
                            ws.send(JSON.stringify({ action: "toast", message: `Пользователь ${target} получил таймаут на ${durationSeconds}с` }));
                        }
                    }
                    else if (cmd === "set_role") {
                        const target = data.target;
                        const newRole = data.params; 
                        if (accounts[target]) {
                            accounts[target].role = newRole;
                            saveAccounts();
                            if (redis) redis.set(`user:${target}`, accounts[target]);
                            ws.send(JSON.stringify({ action: "toast", message: `Роль ${target} изменена на [${newRole}]` }));
                            ws.emit('message', JSON.stringify({action: "admin_cmd", cmd: "get_users", page: data.page || 1}));
                        }
                    }
                }

            } catch(e) {
                // Игнорируем мусор, который не парсится как JSON
            }
        });

        ws.on('close', () => {
            broadcastOnlineCount();
        });
    });

    // Буферизация и отправка бинарных пикселей всем клиентам
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

    // Периодическое сохранение данных
    setInterval(async () => {
        if (redis) {
            try {
                await redis.set('pixel_canvas', Buffer.from(canvasData).toString('base64'));
            } catch (e) {
                console.error("Ошибка сохранения в Redis:", e.message);
            }
        }
        try { 
            fs.writeFileSync(CANVAS_FILE, canvasData);
            saveAccounts(); // Сохраняем аккаунты заодно
        } catch (e) {
            console.error("Ошибка сохранения локального холста/аккаунтов:", e.message);
        }
    }, 15000);
});