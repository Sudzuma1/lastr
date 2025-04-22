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

// Проверка, смонтирован ли диск на Render
if (process.env.NODE_ENV === 'production') {
    if (!fs.existsSync('/data')) {
        console.error('Persistent Disk /data не смонтирован. Проверьте настройки в Render.');
        process.exit(1);
    }
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к базе:', err);
        process.exit(1);
    } else {
        console.log('Подключено к базе данных:', dbPath);
    }
});

// Промисы для работы с SQLite
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
    });
});

// Создание таблиц с проверкой и отладкой
async function initializeDatabase() {
    try {
        const rows = await dbAll('SELECT name FROM sqlite_master WHERE type="table" AND name IN ("ads", "promo_codes", "permanent_ads")');
        console.log('Найденные таблицы:', rows.map(row => row.name).join(', '));

        const tablesToCreate = [];
        if (!rows.some(row => row.name === 'ads')) {
            tablesToCreate.push(`CREATE TABLE ads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                photo TEXT,
                description TEXT,
                userId TEXT,
                isPremium BOOLEAN DEFAULT 0,
                status TEXT DEFAULT 'pending'
            )`);
        }
        if (!rows.some(row => row.name === 'promo_codes')) {
            tablesToCreate.push(`CREATE TABLE promo_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT UNIQUE,
                used INTEGER DEFAULT 0
            )`);
        }
        if (!rows.some(row => row.name === 'permanent_ads')) {
            tablesToCreate.push(`CREATE TABLE permanent_ads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                photo TEXT,
                description TEXT,
                userId TEXT,
                isPremium BOOLEAN DEFAULT 0
            )`);
        }

        if (tablesToCreate.length === 0) {
            console.log('Все таблицы уже существуют');
            await createIndexes();
            return;
        }

        for (const sql of tablesToCreate) {
            await dbRun(sql);
            console.log(`Таблица ${sql.split(' ')[2]} создана успешно`);
        }
        await createIndexes();
    } catch (err) {
        console.error('Ошибка инициализации базы:', err);
        process.exit(1);
    }
}

async function createIndexes() {
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_userId ON ads(userId)',
        'CREATE INDEX IF NOT EXISTS idx_status ON ads(status)',
        'CREATE INDEX IF NOT EXISTS idx_code ON promo_codes(code)',
        'CREATE INDEX IF NOT EXISTS idx_created ON ads(id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_permanent ON permanent_ads(id DESC)'
    ];
    for (const sql of indexes) {
        try {
            await dbRun(sql);
            console.log(`Индекс ${sql.split(' ')[5]} создан успешно`);
        } catch (err) {
            console.error(`Ошибка создания индекса ${sql.split(' ')[5]}:`, err);
        }
    }
}

// Инициализация базы данных при запуске
initializeDatabase().then(() => {
    console.log('База данных инициализирована');
});

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d' // Кэш статических файлов на сутки
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/generate-promo', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    const promoCode = 'PREMIUM_' + Math.random().toString(36).substr(2, 8).toUpperCase();
    try {
        await dbRun('INSERT INTO promo_codes (code) VALUES (?)', [promoCode]);
        res.send(`Ваш промокод: ${promoCode}`);
    } catch (err) {
        console.error('Ошибка при сохранении промокода:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/check-db', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        const rows = await dbAll('SELECT name FROM sqlite_master WHERE type="table" AND name IN ("ads", "promo_codes", "permanent_ads")');
        res.send(`Таблицы в базе:<br>${JSON.stringify(rows, null, 2).replace(/\n/g, '<br>')}`);
    } catch (err) {
        res.status(500).send('Ошибка проверки базы: ' + err.message);
    }
});

app.get('/moderate', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        const pendingRows = await dbAll("SELECT * FROM ads WHERE status = 'pending' LIMIT 100");
        const approvedRows = await dbAll("SELECT * FROM ads WHERE status = 'approved' LIMIT 100");
        const permanentRows = await dbAll("SELECT * FROM permanent_ads");

        console.log('Данные для /moderate:', {
            pendingCount: pendingRows.length,
            approvedCount: approvedRows.length,
            permanentCount: permanentRows.length
        });

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
                    h1, h2 {
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
                    .approve, .make-permanent, .remove-permanent {
                        color: #28a745;
                    }
                    .reject, .delete {
                        color: #dc3545;
                    }
                    .premium {
                        color: gold;
                        font-weight: bold;
                    }
                    .new-request {
                        background: #ffeb3b;
                        padding: 5px;
                        border-radius: 3px;
                        font-weight: bold;
                    }
                    .permanent {
                        background: #4CAF50;
                        color: white;
                        padding: 3px 6px;
                        border-radius: 3px;
                        margin-left: 5px;
                    }
                </style>
                <script>
                    setInterval(() => {
                        location.reload();
                    }, 10000);
                </script>
            </head>
            <body>
                <h1>Модерация объявлений</h1>
                <h2>Ожидающие модерации</h2>
                <ul>`;
        if (pendingRows.length === 0) {
            html += `<li style="text-align: center;">Нет объявлений на проверке</li>`;
        } else {
            pendingRows.forEach(ad => {
                html += `
                    <li>
                        <strong>${ad.title}</strong><br>
                        <img src="${ad.photo}"><br>
                        ${ad.description}<br>
                        <span class="premium">Премиум: ${ad.isPremium ? 'Да' : 'Нет'}</span><br>
                        <a href="/approve/${ad.id}?secret=${secret}" class="approve">Одобрить</a> |
                        <a href="/reject/${ad.id}?secret=${secret}" class="reject">Отклонить</a> |
                        <a href="/make-permanent/${ad.id}?secret=${secret}" class="make-permanent">Сделать постоянным</a>
                        <span class="new-request" id="request-${ad.id}">Новое</span>
                    </li>`;
            });
        }
        html += `</ul><h2>Одобренные и постоянные объявления</h2><ul>`;
        if (approvedRows.length === 0 && permanentRows.length === 0) {
            html += `<li style="text-align: center;">Нет одобренных или постоянных объявлений</li>`;
        } else {
            approvedRows.forEach(ad => {
                const isPermanent = permanentRows.some(p => p.id === ad.id);
                console.log('Объявление в списке одобренных:', { id: ad.id, status: ad.status, isPermanent });
                html += `
                    <li style="background: #e0e0e0;">
                        <strong>${ad.title}</strong><br>
                        <img src="${ad.photo}"><br>
                        ${ad.description}<br>
                        <span class="premium">Премиум: ${ad.isPremium ? 'Да' : 'Нет'}</span><br>`;
                if (isPermanent) {
                    html += `<span class="permanent">Постоянное</span> |
                            <a href="/remove-permanent/${ad.id}?secret=${secret}" class="remove-permanent">Отключить постоянный</a> |`;
                } else {
                    html += `<a href="/make-permanent/${ad.id}?secret=${secret}" class="make-permanent">Сделать постоянным</a> |`;
                }
                html += `<a href="/delete-ad/${ad.id}?secret=${secret}" class="delete">Удалить</a></li>`;
            });
            permanentRows.forEach(ad => {
                if (!approvedRows.some(row => row.id === ad.id)) {
                    console.log('Объявление только в permanent_ads:', { id: ad.id });
                    html += `
                        <li style="background: #e0e0e0;">
                            <strong>${ad.title}</strong><br>
                            <img src="${ad.photo}"><br>
                            ${ad.description}<br>
                            <span class="premium">Премиум: ${ad.isPremium ? 'Да' : 'Нет'}</span><br>
                            <span class="permanent">Постоянное</span> |
                            <a href="/remove-permanent/${ad.id}?secret=${secret}" class="remove-permanent">Отключить постоянный</a> |
                            <a href="/delete-ad/${ad.id}?secret=${secret}" class="delete">Удалить</a>
                        </li>`;
                }
            });
        }
        html += `</ul></body></html>`;
        res.send(html);
    } catch (err) {
        console.error('Ошибка в /moderate:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/approve/:id', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        const ad = await dbGet("SELECT * FROM ads WHERE id = ?", [req.params.id]);
        if (!ad) {
            console.error('Объявление не найдено при одобрении:', { id: req.params.id });
            res.status(404).send('Объявление не найдено');
            return;
        }
        console.log('Состояние объявления перед одобрением:', { id: req.params.id, status: ad.status });
        const result = await dbRun("UPDATE ads SET status = 'approved' WHERE id = ?", [req.params.id]);
        console.log('Объявление одобрено:', { id: req.params.id, rowsAffected: result.changes });
        const updatedAd = await dbGet("SELECT * FROM ads WHERE id = ?", [req.params.id]);
        console.log('Объявление после одобрения:', { id: req.params.id, status: updatedAd.status });
        io.emit('new-ad', { ...updatedAd, status: 'approved' });
        res.redirect('/moderate?secret=mysecret123');
    } catch (err) {
        console.error('Ошибка в /approve:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/reject/:id', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        await dbRun("DELETE FROM ads WHERE id = ?", [req.params.id]);
        console.log('Объявление отклонено и удалено:', { id: req.params.id });
        res.redirect('/moderate?secret=mysecret123');
    } catch (err) {
        console.error('Ошибка в /reject:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/make-permanent/:id', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        const ad = await dbGet("SELECT * FROM ads WHERE id = ?", [req.params.id]);
        if (!ad) {
            res.status(404).send('Объявление не найдено');
            return;
        }
        console.log('Проверка статуса для постоянного:', { id: req.params.id, status: ad.status });
        if (ad.status !== 'approved') {
            res.status(400).send('Объявление должно быть одобрено');
            return;
        }
        const permanentAd = await dbGet("SELECT * FROM permanent_ads WHERE id = ?", [ad.id]);
        if (permanentAd) {
            res.status(400).send('Объявление уже постоянное');
            return;
        }
        await dbRun('INSERT INTO permanent_ads (id, title, photo, description, userId, isPremium) VALUES (?, ?, ?, ?, ?, ?)',
            [ad.id, ad.title, ad.photo, ad.description, ad.userId, ad.isPremium]);
        console.log('Объявление сделано постоянным:', ad.id);
        res.redirect('/moderate?secret=mysecret123');
    } catch (err) {
        console.error('Ошибка в /make-permanent:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/remove-permanent/:id', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        await dbRun('DELETE FROM permanent_ads WHERE id = ?', [req.params.id]);
        console.log('Постоянное объявление удалено:', req.params.id);
        res.redirect('/moderate?secret=mysecret123');
    } catch (err) {
        console.error('Ошибка в /remove-permanent:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/delete-ad/:id', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        // Удаляем из обеих таблиц
        const adInAds = await dbGet("SELECT * FROM ads WHERE id = ?", [req.params.id]);
        const adInPermanent = await dbGet("SELECT * FROM permanent_ads WHERE id = ?", [req.params.id]);

        if (!adInAds && !adInPermanent) {
            console.error('Объявление не найдено для удаления:', { id: req.params.id });
            res.status(404).send('Объявление не найдено');
            return;
        }

        if (adInAds) {
            await dbRun("DELETE FROM ads WHERE id = ?", [req.params.id]);
            console.log('Объявление удалено из ads:', { id: req.params.id });
        }
        if (adInPermanent) {
            await dbRun("DELETE FROM permanent_ads WHERE id = ?", [req.params.id]);
            console.log('Объявление удалено из permanent_ads:', { id: req.params.id });
        }

        // Уведомляем клиентов через WebSocket
        io.emit('delete-ad', req.params.id);
        res.redirect('/moderate?secret=mysecret123');
    } catch (err) {
        console.error('Ошибка в /delete-ad:', err);
        res.status(500).send('Ошибка сервера');
    }
});

const RESET_INTERVAL = 24 * 60 * 60 * 1000;
let nextReset = Date.now() + RESET_INTERVAL;

function resetAds() {
    db.run("DELETE FROM ads WHERE status = 'approved'", (err) => {
        if (err) console.error('Ошибка при сбросе объявлений:', err);
        else console.log('Объявления сброшены');
        db.all("SELECT * FROM permanent_ads", (err, permanentRows) => {
            if (err) {
                console.error('Ошибка загрузки постоянных объявлений:', err);
                return;
            }
            io.emit('initial-ads', permanentRows);
        });
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

    db.all("SELECT * FROM ads WHERE status = 'approved' LIMIT 100", (err, tempRows) => {
        if (err) {
            console.error('Ошибка получения временных объявлений:', err);
            socket.emit('initial-ads', []);
            return;
        }
        db.all("SELECT * FROM permanent_ads", (err, permanentRows) => {
            if (err) {
                console.error('Ошибка получения постоянных объявлений:', err);
                socket.emit('initial-ads', tempRows);
                return;
            }
            const allAds = [...tempRows, ...permanentRows].sort((a, b) => b.isPremium - a.isPremium);
            console.log('Отправлены объявления:', allAds.length);
            socket.emit('initial-ads', allAds.slice(0, 100));
        });
    });

    socket.emit('reset-time', nextReset);

    socket.on('new-ad', (ad, callback) => {
        const { title, photo, description, userId, promoCode } = ad;
        console.log('Получено фото размером:', photo ? photo.length / 1024 : 0, 'KB');

        if (photo && photo.length > 2097152) {
            callback({ success: false, message: 'Фото слишком большое! Максимум 2 MB. Сжмите изображение.' });
            return;
        }

        db.get('SELECT COUNT(*) as count FROM ads WHERE userId = ?', [userId], (err, row) => {
            if (err) {
                console.error('Ошибка проверки userId:', err);
                callback({ success: false, message: 'Ошибка сервера' });
                return;
            }
            if (row.count > 0) {
                callback({ success: false, message: 'У вас уже есть одно объявление. Удалите его, чтобы добавить новое.' });
                return;
            }

            if (promoCode) {
                db.get('SELECT * FROM promo_codes WHERE code = ? AND used = 0', [promoCode], (err, row) => {
                    console.log('Проверка промокода:', promoCode, 'Найден:', row);
                    if (err || !row) {
                        callback({ success: false, message: 'Неверный или использованный промокод' });
                        return;
                    }
                    db.run('UPDATE promo_codes SET used = 1 WHERE code = ?', [promoCode], (err) => {
                        if (err) {
                            console.error('Ошибка обновления промокода:', err);
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
            if (err) {
                console.error('Ошибка получения объявления для удаления:', err);
                callback({ success: false, message: 'Объявление не найдено' });
                return;
            }
            if (!row) {
                callback({ success: false, message: 'Объявление не найдено' });
                return;
            }
            if (row.userId !== data.userId) {
                callback({ success: false, message: 'Вы не можете удалить это объявление' });
                return;
            }
            db.run('DELETE FROM ads WHERE id = ?', [data.adId], (err) => {
                if (err) {
                    console.error('Ошибка удаления объявления:', err);
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
            io.emit('new-pending-ad', this.lastID);
            callback({ success: true });
        }
    );
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    resetAds();
});