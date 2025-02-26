const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Используем /data/ads.db на Render и ./ads.db локально
const dbPath = process.env.NODE_ENV === 'production' ? '/data/ads.db' : './ads.db';

// Проверка и создание директории для Render
if (process.env.NODE_ENV === 'production') {
    if (!fs.existsSync('/data')) {
        fs.mkdirSync('/data', { recursive: true });
        console.log('Создана директория /data на Render');
    }
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к базе:', err);
        process.exit(1); // Завершаем процесс при ошибке
    } else {
        console.log('Подключено к базе данных:', dbPath);
    }
});

// Создание таблиц
db.run(`CREATE TABLE IF NOT EXISTS ads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    photo TEXT,
    description TEXT,
    userId TEXT,
    isPremium BOOLEAN DEFAULT 0,
    status TEXT DEFAULT 'pending'
)`);

db.run(`CREATE TABLE IF NOT EXISTS promo_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    used INTEGER DEFAULT 0
)`);

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d' // Кэш статических файлов на сутки
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/generate-promo', (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') { // Замените на свой пароль
        res.status(403).send('Доступ запрещён');
        return;
    }
    const promoCode = 'PREMIUM_' + Math.random().toString(36).substr(2, 8).toUpperCase();
    db.run('INSERT INTO promo_codes (code) VALUES (?)', [promoCode], (err) => {
        if (err) {
            console.error('Ошибка при сохранении промокода:', err);
            res.status(500).send('Ошибка сервера');
            return;
        }
        res.send(`Ваш промокод: ${promoCode}`);
    });
});

app.get('/moderate', (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    db.all("SELECT * FROM ads WHERE status = 'pending'", (err, rows) => {
        if (err) {
            res.status(500).send('Ошибка сервера');
            return;
        }
        let html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Модерация объявлений</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        margin: 20px;
                        background-color: #f0f2f5;
                        color: #333;
                    }
                    h1 {
                        text-align: center;
                        color: #28a745;
                    }
                    ul {
                        list-style: none;
                        padding: 0;
                        max-width: 800px;
                        margin: 0 auto;
                    }
                    li {
                        border: 1px solid #ccc;
                        padding: 15px;
                        margin-bottom: 15px;
                        border-radius: 5px;
                        background: white;
                        box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
                    }
                    img {
                        max-width: 200px;
                        border-radius: 5px;
                    }
                    a {
                        margin-right: 10px;
                        color: #007BFF;
                        text-decoration: none;
                        font-weight: bold;
                    }
                    a:hover {
                        text-decoration: underline;
                    }
                    .approve {
                        color: #28a745;
                    }
                    .reject {
                        color: #dc3545;
                    }
                    .premium {
                        color: gold;
                        font-weight: bold;
                    }
                </style>
            </head>
            <body>
                <h1>Модерация объявлений</h1>
                <ul>`;
        if (rows.length === 0) {
            html += `<li style="text-align: center;">Нет объявлений на проверке</li>`;
        } else {
            rows.forEach(ad => {
                html += `
                    <li>
                        <strong>${ad.title}</strong><br>
                        <img src="${ad.photo}"><br>
                        ${ad.description}<br>
                        <span class="premium">Премиум: ${ad.isPremium ? 'Да' : 'Нет'}</span><br>
                        <a href="/approve/${ad.id}?secret=${secret}" class="approve">Одобрить</a> |
                        <a href="/reject/${ad.id}?secret=${secret}" class="reject">Отклонить</a>
                    </li>`;
            });
        }
        html += `</ul></body></html>`;
        res.send(html);
    });
});

app.get('/approve/:id', (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    db.run("UPDATE ads SET status = 'approved' WHERE id = ?", [req.params.id], (err) => {
        if (err) {
            res.status(500).send('Ошибка сервера');
            return;
        }
        io.emit('new-ad', getAdById(req.params.id));
        res.redirect('/moderate?secret=mysecret123');
    });
});

app.get('/reject/:id', (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    db.run("DELETE FROM ads WHERE id = ?", [req.params.id], (err) => {
        if (err) {
            res.status(500).send('Ошибка сервера');
            return;
        }
        res.redirect('/moderate?secret=mysecret123');
    });
});

const RESET_INTERVAL = 24 * 60 * 60 * 1000;
let nextReset = Date.now() + RESET_INTERVAL;

function resetAds() {
    db.run("DELETE FROM ads WHERE status = 'approved'", (err) => {
        if (err) console.error('Ошибка при сбросе объявлений:', err);
        else console.log('Объявления сброшены');
        io.emit('initial-ads', []);
        nextReset = Date.now() + RESET_INTERVAL;
        io.emit('reset-time', nextReset);
    });
}

setInterval(() => {
    const now = Date.now();
    if (now >= nextReset) resetAds();
}, 1000 * 60);

io.on('connection', (socket) => {
    console.log('Пользователь подключен:', socket.id);

    db.all("SELECT * FROM ads WHERE status = 'approved'", (err, rows) => {
        if (err) {
            console.error('Ошибка получения объявлений:', err);
            return;
        }
        socket.emit('initial-ads', rows);
    });

    socket.emit('reset-time', nextReset);

    socket.on('new-ad', (ad, callback) => {
        const { title, photo, description, userId, promoCode } = ad;

        db.get('SELECT COUNT(*) as count FROM ads WHERE userId = ?', [userId], (err, row) => {
            if (err) {
                callback({ success: false, message: 'Ошибка сервера' });
                return;
            }
            if (row.count > 0) {
                callback({ success: false, message: 'У вас уже есть одно объявление. Удалите его, чтобы добавить новое.' });
                return;
            }

            if (promoCode) {
                db.get('SELECT * FROM promo_codes WHERE code = ? AND used = 0', [promoCode], (err, row) => {
                    console.log('Проверка промокода:', promoCode, 'Найден:', row); // Отладка
                    if (err || !row) {
                        callback({ success: false, message: 'Неверный или использованный промокод' });
                        return;
                    }
                    db.run('UPDATE promo_codes SET used = 1 WHERE code = ?', [promoCode], (err) => {
                        if (err) {
                            callback({ success: false, message: 'Ошибка сервера' });
                            return;
                        }
                        saveAd(title, photo, description, userId, true, callback);
                    });
                });
            } else {
                saveAd(title, photo, description, userId, false, callback);
            }
        });
    });

    socket.on('delete-ad', (data, callback) => {
        db.get('SELECT userId FROM ads WHERE id = ?', [data.adId], (err, row) => {
            if (err || !row) {
                callback({ success: false, message: 'Объявление не найдено' });
                return;
            }
            if (row.userId !== data.userId) {
                callback({ success: false, message: 'Вы не можете удалить это объявление' });
                return;
            }
            db.run('DELETE FROM ads WHERE id = ?', [data.adId], (err) => {
                if (err) {
                    callback({ success: false, message: 'Ошибка сервера' });
                    return;
                }
                io.emit('delete-ad', data.adId);
                callback({ success: true });
            });
        });
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключен:', socket.id);
    });
});

function saveAd(title, photo, description, userId, isPremium, callback) {
    db.run(
        'INSERT INTO ads (title, photo, description, userId, isPremium, status) VALUES (?, ?, ?, ?, ?, ?)',
        [title, photo, description, userId, isPremium, 'pending'],
        function (err) {
            if (err) {
                console.error('Ошибка добавления объявления:', err);
                callback({ success: false, message: 'Ошибка сервера' });
                return;
            }
            callback({ success: true });
        }
    );
}

function getAdById(id) {
    return new Promise((resolve) => {
        db.get("SELECT * FROM ads WHERE id = ?", [id], (err, row) => {
            resolve(row);
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    resetAds();
});