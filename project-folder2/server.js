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

// Создание таблиц с проверкой и отладкой
function initializeDatabase(callback) {
    db.all('SELECT name FROM sqlite_master WHERE type="table" AND name IN ("ads", "promo_codes", "permanent_ads")', (err, rows) => {
        if (err) {
            console.error('Ошибка проверки существующих таблиц:', err);
            process.exit(1);
            return;
        }
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
            callback();
            return;
        }

        let completed = 0;
        tablesToCreate.forEach((sql, index) => {
            db.run(sql, (err) => {
                if (err) {
                    console.error(`Ошибка создания таблицы ${tablesToCreate[index].split(' ')[2]}:`, err);
                    process.exit(1);
                } else {
                    console.log(`Таблица ${tablesToCreate[index].split(' ')[2]} создана успешно`);
                }
                completed++;
                if (completed === tablesToCreate.length) {
                    createIndexes(callback);
                }
            });
        });
    });
}

function createIndexes(callback) {
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_userId ON ads(userId)',
        'CREATE INDEX IF NOT EXISTS idx_status ON ads(status)',
        'CREATE INDEX IF NOT EXISTS idx_code ON promo_codes(code)',
        'CREATE INDEX IF NOT EXISTS idx_created ON ads(id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_permanent ON permanent_ads(id DESC)'
    ];
    let completed = 0;
    indexes.forEach((sql, index) => {
        db.run(sql, (err) => {
            if (err) {
                console.error(`Ошибка создания индекса ${sql.split(' ')[5]}:`, err);
            } else {
                console.log(`Индекс ${sql.split(' ')[5]} создан успешно`);
            }
            completed++;
            if (completed === indexes.length) {
                callback();
            }
        });
    });
}

// Инициализация базы данных при запуске
initializeDatabase(() => {
    console.log('База данных инициализирована');
});

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

app.get('/check-db', (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') { // Замените на свой пароль
        res.status(403).send('Доступ запрещён');
        return;
    }
    db.all('SELECT name FROM sqlite_master WHERE type="table" AND name IN ("ads", "promo_codes", "permanent_ads")', (err, rows) => {
        if (err) {
            res.status(500).send('Ошибка проверки базы: ' + err.message);
            return;
        }
        res.send(`Таблицы в базе:<br>${JSON.stringify(rows, null, 2).replace(/\n/g, '<br>')}`);
    });
});

app.get('/moderate', (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    db.all("SELECT * FROM ads WHERE status = 'pending' LIMIT 100", (err, rows) => {
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
                    .reject {
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
                    // Автоматическое обновление страницы каждые 10 секунд
                    setInterval(() => {
                        location.reload();
                    }, 10000);
                </script>
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
                        <a href="/reject/${ad.id}?secret=${secret}" class="reject">Отклонить</a> |
                        <a href="/make-permanent/${ad.id}?secret=${secret}" class="make-permanent">Сделать постоянным</a>
                        <span class="new-request" id="request-${ad.id}">Новое</span>
                    </li>`;
            });
        }
        // Показываем одобренные и постоянные объявления для удобства
        db.all("SELECT * FROM ads WHERE status = 'approved' LIMIT 100", (err, approvedRows) => {
            if (err) {
                console.error('Ошибка получения одобренных объявлений:', err);
                return;
            }
            db.all("SELECT * FROM permanent_ads", (err, permanentRows) => {
                if (err) {
                    console.error('Ошибка получения постоянных объявлений:', err);
                    return;
                }
                if (approvedRows.length > 0 || permanentRows.length > 0) {
                    html += `<h2>Одобренные и постоянные объявления</h2>`;
                }
                approvedRows.forEach(ad => {
                    html += `
                        <li style="background: #e0e0e0;">
                            <strong>${ad.title}</strong><br>
                            <img src="${ad.photo}"><br>
                            ${ad.description}<br>
                            <span class="premium">Премиум: ${ad.isPremium ? 'Да' : 'Нет'}</span><br>`;
                    // Проверяем, есть ли это объявление в permanent_ads
                    db.get("SELECT * FROM permanent_ads WHERE id = ?", [ad.id], (err, permanentAd) => {
                        if (err) {
                            console.error('Ошибка проверки постоянного статуса:', err);
                            return;
                        }
                        console.log('Проверка постоянного статуса для объявления:', { id: ad.id, isPermanent: !!permanentAd });
                        if (permanentAd) {
                            html += `<span class="permanent">Постоянное</span> |
                                    <a href="/remove-permanent/${ad.id}?secret=${secret}" class="remove-permanent">Отключить постоянный</a>`;
                        } else {
                            html += `<a href="/make-permanent/${ad.id}?secret=${secret}" class="make-permanent">Сделать постоянным</a>`;
                        }
                        html += `</li>`;
                    });
                });
                permanentRows.forEach(ad => {
                    if (!approvedRows.some(row => row.id === ad.id)) {
                        html += `
                            <li style="background: #e0e0e0;">
                                <strong>${ad.title}</strong><br>
                                <img src="${ad.photo}"><br>
                                ${ad.description}<br>
                                <span class="premium">Премиум: ${ad.isPremium ? 'Да' : 'Нет'}</span><br>
                                <span class="permanent">Постоянное</span> |
                                <a href="/remove-permanent/${ad.id}?secret=${secret}" class="remove-permanent">Отключить постоянный</a>
                            </li>`;
                    }
                });
                res.send(html);
            });
        });
    });
});

app.get('/approve/:id', (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    db.get("SELECT * FROM ads WHERE id = ?", [req.params.id], (err, ad) => {
        if (err || !ad) {
            console.error('Объявление не найдено при одобрении:', err || 'Нет данных');
            res.status(500).send('Объявление не найдено');
            return;
        }
        // Логируем текущее состояние перед обновлением
        console.log('Состояние объявления перед одобрением:', { id: req.params.id, status: ad.status });
        db.run("UPDATE ads SET status = 'approved' WHERE id = ?", [req.params.id], (err) => {
            if (err) {
                console.error('Ошибка одобрения объявления:', err);
                res.status(500).send('Ошибка сервера');
                return;
            }
            // Проверяем, обновился ли статус в базе
            db.get("SELECT status FROM ads WHERE id = ?", [req.params.id], (err, updatedAd) => {
                if (err) {
                    console.error('Ошибка проверки обновлённого статуса:', err);
                    res.status(500).send('Ошибка проверки статуса');
                    return;
                }
                console.log('Объявление одобрено, новый статус:', { id: req.params.id, status: updatedAd.status });
                // Убедимся, что одобренное объявление отображается в модерации как одобренное
                io.emit('new-ad', { ...ad, status: 'approved' });
                res.redirect('/moderate?secret=mysecret123');
            });
        });
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
            console.error('Ошибка отклонения объявления:', err);
            res.status(500).send('Ошибка сервера');
            return;
        }
        res.redirect('/moderate?secret=mysecret123');
    });
});

app.get('/make-permanent/:id', (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    db.get("SELECT * FROM ads WHERE id = ?", [req.params.id], (err, ad) => {
        if (err) {
            console.error('Ошибка получения объявления для постоянного статуса:', err);
            res.status(500).send('Ошибка сервера');
            return;
        }
        if (!ad) {
            res.status(404).send('Объявление не найдено');
            return;
        }
        // Проверяем, одобрено ли объявление, с отладкой
        console.log('Проверка статуса для постоянного:', { id: req.params.id, status: ad.status });
        if (ad.status !== 'approved') {
            res.status(400).send('Объявление должно быть одобрено');
            return;
        }
        // Проверяем, уже ли оно постоянное
        db.get("SELECT * FROM permanent_ads WHERE id = ?", [ad.id], (err, permanentAd) => {
            if (err) {
                console.error('Ошибка проверки постоянного объявления:', err);
                res.status(500).send('Ошибка сервера');
                return;
            }
            if (permanentAd) {
                res.status(400).send('Объявление уже постоянное');
                return;
            }
            db.run('INSERT INTO permanent_ads (id, title, photo, description, userId, isPremium) VALUES (?, ?, ?, ?, ?, ?)',
                [ad.id, ad.title, ad.photo, ad.description, ad.userId, ad.isPremium], (err) => {
                    if (err) {
                        console.error('Ошибка сохранения постоянного объявления:', err);
                        res.status(500).send('Ошибка сохранения постоянного объявления');
                        return;
                    }
                    console.log('Объявление сделано постоянным:', ad.id);
                    res.redirect('/moderate?secret=mysecret123');
                });
        });
    });
});

app.get('/remove-permanent/:id', (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'mysecret123') {
        res.status(403).send('Доступ запрещён');
        return;
    }
    db.run('DELETE FROM permanent_ads WHERE id = ?', [req.params.id], (err) => {
        if (err) {
            console.error('Ошибка удаления постоянного объявления:', err);
            res.status(500).send('Ошибка удаления постоянного объявления');
            return;
        }
        console.log('Постоянное объявление удалено:', req.params.id);
        res.redirect('/moderate?secret=mysecret123');
    });
});

const RESET_INTERVAL = 24 * 60 * 60 * 1000;
let nextReset = Date.now() + RESET_INTERVAL;

function resetAds() {
    db.run("DELETE FROM ads WHERE status = 'approved'", (err) => {
        if (err) console.error('Ошибка при сбросе объявлений:', err);
        else console.log('Объявления сброшены');
        // Загружаем постоянные объявления
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

    // Загружаем как временные, так и постоянные объявления
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
            console.log('Отправлены объявления:', allAds.length); // Отладка
            socket.emit('initial-ads', allAds.slice(0, 100)); // Ограничиваем до 100
        });
    });

    socket.emit('reset-time', nextReset);

    socket.on('new-ad', (ad, callback) => {
        const { title, photo, description, userId, promoCode } = ad;
        console.log('Получено фото размером:', photo ? photo.length / 1024 : 0, 'KB'); // Размер в KB

        if (photo && photo.length > 2097152) { // 2 MB в Base64
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
            // Уведомляем модератора о новом запросе
            io.emit('new-pending-ad', this.lastID);
            callback({ success: true });
        }
    );
}

function getAdById(id) {
    return new Promise((resolve) => {
        db.get("SELECT * FROM ads WHERE id = ?", [id], (err, row) => {
            resolve(row || {});
        });
    });
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    resetAds();
});