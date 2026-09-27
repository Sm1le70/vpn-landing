import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);

db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT NOT NULL UNIQUE,
        rw_user_id    INTEGER,
        rw_username   TEXT,
        -- 'none' | 'trial' | 'paid'
        plan_kind     TEXT NOT NULL DEFAULT 'none',
        trial_used_at TEXT,
        trial_blocked INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS login_codes (
        email      TEXT PRIMARY KEY,
        code_hash  TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        sent_at    INTEGER NOT NULL
    );

    -- Постоянные коды входа (тестовые аккаунты): выдаются командой login-code --permanent, не истекают
    CREATE TABLE IF NOT EXISTS static_login_codes (
        email      TEXT PRIMARY KEY,
        code_hash  TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- События входа по коду: отправленные письма ('code') и неверные вводы ('fail') — для суточных лимитов на email
    CREATE TABLE IF NOT EXISTS login_events (
        email      TEXT NOT NULL,
        kind       TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_events_email ON login_events(email, kind, created_at);

    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
        id              TEXT PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(id),
        plan_id         TEXT NOT NULL,
        days            INTEGER NOT NULL,
        amount          REAL NOT NULL,
        -- 'pending' | 'paid' | 'applied' | 'canceled' | 'chargeback' | 'refund_pending' | 'refunded'
        status          TEXT NOT NULL DEFAULT 'pending',
        platega_tx_id   TEXT UNIQUE,
        payment_url     TEXT,
        error           TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        paid_at         TEXT,
        applied_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS orders_status ON orders(status);

    -- HWID устройств, замеченных на пробных подписках
    CREATE TABLE IF NOT EXISTS trial_hwids (
        hwid       TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        first_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Тарифы (при первом запуске импортируются из config/plans.json)
    CREATE TABLE IF NOT EXISTS plans (
        id     TEXT PRIMARY KEY,
        title  TEXT NOT NULL,
        days   INTEGER NOT NULL,
        price  REAL NOT NULL,
        badge  TEXT,
        sort   INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0
    );

    -- Настройки, изменяемые из админки (значение — JSON)
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        login         TEXT NOT NULL UNIQUE,
        -- 'admin' | 'support'
        role          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        totp_secret   TEXT,
        backup_codes  TEXT NOT NULL DEFAULT '[]',
        disabled      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        ip         TEXT
    );

    -- Одноразовые ссылки: первичная настройка, приглашение, сброс доступа
    CREATE TABLE IF NOT EXISTS admin_setup_tokens (
        token_hash     TEXT PRIMARY KEY,
        -- 'bootstrap' | 'invite' | 'reset'
        kind           TEXT NOT NULL,
        admin_id       INTEGER REFERENCES admins(id) ON DELETE CASCADE,
        login          TEXT,
        role           TEXT NOT NULL,
        pending        TEXT,
        expires_at     INTEGER NOT NULL,
        used_at        TEXT,
        created_by     INTEGER
    );

    CREATE TABLE IF NOT EXISTS audit_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id     INTEGER,
        admin_login  TEXT,
        action       TEXT NOT NULL,
        target_type  TEXT,
        target_id    TEXT,
        target_label TEXT,
        reason       TEXT,
        details      TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS audit_target ON audit_log(target_type, target_id);
    CREATE INDEX IF NOT EXISTS audit_admin ON audit_log(admin_id);

    -- Обращения в поддержку (входящая почта через Resend Inbound)
    CREATE TABLE IF NOT EXISTS support_threads (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        email           TEXT NOT NULL,
        user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        subject         TEXT NOT NULL DEFAULT '',
        -- тема без Re:/Fwd:, в нижнем регистре — для привязки писем без заголовков цепочки
        subject_norm    TEXT NOT NULL DEFAULT '',
        -- 'new' | 'waiting' | 'answered' | 'closed'
        status          TEXT NOT NULL DEFAULT 'new',
        unread          INTEGER NOT NULL DEFAULT 1,
        last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS support_threads_status ON support_threads(status, last_message_at);
    CREATE INDEX IF NOT EXISTS support_threads_email ON support_threads(email, subject_norm);

    CREATE TABLE IF NOT EXISTS support_messages (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id      INTEGER NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        -- 'in' | 'out'
        direction      TEXT NOT NULL,
        -- email_id входящего письма или id отправленного в Resend
        resend_id      TEXT UNIQUE,
        message_id     TEXT,
        in_reply_to    TEXT,
        references_hdr TEXT,
        from_addr      TEXT,
        from_name      TEXT,
        to_addrs       TEXT,
        cc_addrs       TEXT,
        subject        TEXT,
        text           TEXT,
        html           TEXT,
        truncated      INTEGER NOT NULL DEFAULT 0,
        -- содержимое письма получить не удалось, сохранены только метаданные
        content_missing INTEGER NOT NULL DEFAULT 0,
        admin_id       INTEGER,
        admin_login    TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS support_messages_thread ON support_messages(thread_id, id);
    CREATE INDEX IF NOT EXISTS support_messages_mid ON support_messages(message_id);

    -- Содержимое вложений не храним: скачивается по требованию через API Resend
    CREATE TABLE IF NOT EXISTS support_attachments (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id           INTEGER NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
        resend_attachment_id TEXT NOT NULL,
        filename             TEXT,
        content_type         TEXT,
        size                 INTEGER,
        content_disposition  TEXT,
        content_id           TEXT
    );
    CREATE INDEX IF NOT EXISTS support_attachments_msg ON support_attachments(message_id);

    -- Очередь входящих вебхуков: email_id уникален, повторная доставка не создаёт дубль
    CREATE TABLE IF NOT EXISTS support_inbox (
        email_id        TEXT PRIMARY KEY,
        payload         TEXT NOT NULL,
        -- 'pending' | 'done' | 'ignored'
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        ignore_reason   TEXT,
        received_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS support_inbox_pending ON support_inbox(status, next_attempt_at);

    -- Поддержка в Telegram: клиент бота и его тема в группе поддержки
    CREATE TABLE IF NOT EXISTS tg_clients (
        tg_user_id      INTEGER PRIMARY KEY,
        user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        first_name      TEXT,
        last_name       TEXT,
        username        TEXT,
        topic_id        INTEGER,
        topic_closed    INTEGER NOT NULL DEFAULT 0,
        -- сообщения клиента не пересылаются в группу
        banned          INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_message_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tg_clients_topic ON tg_clients(topic_id);
    CREATE INDEX IF NOT EXISTS tg_clients_user ON tg_clients(user_id);

    -- Одноразовые ссылки t.me/<бот>?start=<токен> из кабинета для привязки аккаунта
    CREATE TABLE IF NOT EXISTS tg_link_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    );

    -- Соответствие сообщений в личке клиента и в теме — чтобы «Ответить» работал в обе стороны
    CREATE TABLE IF NOT EXISTS tg_messages (
        tg_user_id   INTEGER NOT NULL,
        user_msg_id  INTEGER NOT NULL,
        group_msg_id INTEGER NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS tg_messages_user ON tg_messages(tg_user_id, user_msg_id);
    CREATE INDEX IF NOT EXISTS tg_messages_group ON tg_messages(group_msg_id);

    -- Очередь входящих обновлений: update_id уникален, повторная доставка не создаёт дубль
    CREATE TABLE IF NOT EXISTS tg_updates (
        update_id       INTEGER PRIMARY KEY,
        -- чат клиента или тема: порядок сообщений соблюдается внутри одного ключа
        chat_key        TEXT NOT NULL,
        payload         TEXT NOT NULL,
        -- 'pending' | 'done' | 'failed'
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        received_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS tg_updates_pending ON tg_updates(status, update_id);

    -- Оповещения об email-обращениях в теме «Обращения»: очередь отправки.
    -- thread_id без внешнего ключа: задача удаления оповещений переживает удаление обращения.
    CREATE TABLE IF NOT EXISTS tg_outbox (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id       INTEGER NOT NULL,
        -- 'event' | 'purge'
        kind            TEXT NOT NULL,
        payload         TEXT NOT NULL,
        -- 'pending' | 'done' | 'failed'
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS tg_outbox_pending ON tg_outbox(status, id);
    CREATE INDEX IF NOT EXISTS tg_outbox_thread ON tg_outbox(thread_id);

    -- Отправленные оповещения: чтобы удалить их из Telegram вместе с аккаунтом клиента
    CREATE TABLE IF NOT EXISTS tg_notify_messages (
        thread_id  INTEGER NOT NULL,
        chat_id    TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS tg_notify_messages_thread ON tg_notify_messages(thread_id);

    -- Служебные алерты (src/alerts.js): очередь отправки в тему «Алерты» и защита от повторов по dedup_key.
    -- Без персональных данных: клиент указывается номером и ссылкой на карточку в админке.
    CREATE TABLE IF NOT EXISTS alerts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        dedup_key       TEXT,
        text            TEXT NOT NULL,
        link            TEXT,
        -- 'pending' | 'done' | 'failed' | 'skipped' (Telegram не настроен или алерты выключены — только лог)
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS alerts_pending ON alerts(status, id);
    CREATE INDEX IF NOT EXISTS alerts_key ON alerts(dedup_key, created_at);

    -- Промокоды (src/promo.js). Использования считаются по оплаченным заказам с этим кодом.
    CREATE TABLE IF NOT EXISTS promo_codes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code        TEXT NOT NULL UNIQUE,
        -- 'percent' | 'fixed' (рубли)
        kind        TEXT NOT NULL,
        value       REAL NOT NULL,
        -- NULL — без лимита
        max_uses    INTEGER,
        -- JSON-массив ID тарифов; пустой — все тарифы
        plan_ids    TEXT NOT NULL DEFAULT '[]',
        valid_from  TEXT,
        valid_until TEXT,
        active      INTEGER NOT NULL DEFAULT 1,
        note        TEXT,
        created_by  INTEGER,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Отправленные напоминания об окончании подписки: одно напоминание на дату окончания и порог (дней).
    -- После продления дата окончания другая — напоминания начинаются заново.
    CREATE TABLE IF NOT EXISTS expiry_reminders (
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expire_at   TEXT NOT NULL,
        days_before INTEGER NOT NULL,
        sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, expire_at, days_before)
    );
`);

// Миграции существующих баз: добавляем недостающие колонки.
function addColumn(table, column, definition) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// Кэш данных Remnawave для списков и статистики (источник истины — панель)
addColumn('users', 'expire_at', 'TEXT');
addColumn('users', 'rw_status', 'TEXT');
// Отключён администратором: оплата из кабинета запрещена до включения
addColumn('users', 'blocked', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'refunded_at', 'TEXT');
addColumn('orders', 'refund_info', 'TEXT');
// Срок, до которого продлевает подписку этот заказ: защита от двойного продления при повторе после таймаута
addColumn('orders', 'target_expire_at', 'TEXT');
// Срок подписки до продления по этому заказу: если при повторе срок не равен ни прежнему, ни ожидаемому,
// подписку меняли после прошлой попытки — повтор не продлевает, а сообщает администратору
addColumn('orders', 'prev_expire_at', 'TEXT');
// До какого момента действует платёжная ссылка Platega (для кнопки «Оплатить» в кабинете)
addColumn('orders', 'payment_expires_at', 'TEXT');
// Первое оповещение об обращении в теме «Обращения»: остальные события приходят ответом на него
addColumn('support_threads', 'tg_msg_id', 'INTEGER');
// Промокод заказа и цена тарифа до скидки (amount — к оплате, со скидкой)
addColumn('orders', 'promo_code', 'TEXT');
addColumn('orders', 'price_before', 'REAL');
// Проверка отправителя входящего письма по данным Resend (SPF, DKIM, DMARC): 'pass' | 'fail' | 'unknown'
addColumn('support_messages', 'sender_auth', 'TEXT');
addColumn('support_messages', 'sender_auth_details', 'TEXT');
// Переписка начата подтверждённым отправителем (1) или нет (0); NULL — обращения до появления проверки
addColumn('support_threads', 'sender_verified', 'INTEGER');
// Сброс доступа из консоли: включить отключённого администратора после завершения сброса
addColumn('admin_setup_tokens', 'enable_admin', 'INTEGER NOT NULL DEFAULT 0');
// Имя пользователя в панели, запрошенное при создании: если панель создала пользователя, но ответ не дошёл,
// повтор найдёт его по этому имени и не создаст второго
addColumn('users', 'rw_pending_username', 'TEXT');
// Администратор сбросил отключение пробного периода: проверка устройств для текущего пробного периода не применяется
// (отметка устройства остаётся за первым аккаунтом, иначе проверка сразу отключила бы подписку снова)
addColumn('users', 'trial_devices_allowed', 'INTEGER NOT NULL DEFAULT 0');
// Адрес отправителя входящего письма: при удалении аккаунта его письма в очереди удаляются по индексу,
// без разбора всех сохранённых вебхуков. NULL — письма, полученные до появления колонки
addColumn('support_inbox', 'sender_email', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS support_inbox_sender ON support_inbox(sender_email)');
db.exec('CREATE INDEX IF NOT EXISTS users_expire ON users(expire_at)');
db.exec('CREATE INDEX IF NOT EXISTS orders_promo ON orders(promo_code)');
// Аналитика посещений (src/tracking.js). Посетитель — случайный id из cookie; IP не хранится.
// Сырые события хранятся 90 дней, итоги по дням (web_daily) — всегда.
db.exec(`
    -- Первый визит: источник (utm-метки, ?ref=, домен реферера), страница входа, тип устройства
    CREATE TABLE IF NOT EXISTS visitors (
        vid        TEXT PRIMARY KEY,
        first_seen INTEGER NOT NULL,
        source     TEXT NOT NULL,
        medium     TEXT,
        campaign   TEXT,
        content    TEXT,
        term       TEXT,
        referrer   TEXT,
        landing    TEXT,
        device     TEXT,
        os         TEXT
    );
    CREATE INDEX IF NOT EXISTS visitors_first_seen ON visitors(first_seen);

    -- 'view' (name — путь страницы), 'click' (name — элемент с data-track), 'code' (запрошен код входа), 'login' (вход, user_id)
    CREATE TABLE IF NOT EXISTS web_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        vid        TEXT NOT NULL,
        kind       TEXT NOT NULL,
        name       TEXT,
        user_id    INTEGER,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS web_events_time ON web_events(created_at);
    CREATE INDEX IF NOT EXISTS web_events_vid ON web_events(vid, kind);
    CREATE INDEX IF NOT EXISTS web_events_user ON web_events(user_id);

    -- Итоги по московским суткам: metric + key → n (например, views + '/' → 120)
    CREATE TABLE IF NOT EXISTS web_daily (
        day    TEXT NOT NULL,
        metric TEXT NOT NULL,
        key    TEXT NOT NULL DEFAULT '',
        n      INTEGER NOT NULL,
        PRIMARY KEY (day, metric, key)
    );
`);
// Первый источник клиента: переносится из visitors при первом входе в кабинет и хранится бессрочно
addColumn('users', 'source', 'TEXT');
addColumn('users', 'utm_medium', 'TEXT');
addColumn('users', 'utm_campaign', 'TEXT');
addColumn('users', 'referrer', 'TEXT');
addColumn('users', 'landing', 'TEXT');
addColumn('users', 'first_visit_at', 'TEXT');
// Активация (данные панели, обновляются синхронизацией раз в 30 минут): первое устройство (HWID) — ссылка добавлена
// в приложение; первое подключение и трафик за всё время. rw_activity_at — когда панель последний раз сообщила
// эти данные; NULL — ещё не сообщала (такие клиенты не считаются «не подключившимися»)
addColumn('users', 'rw_first_device_at', 'TEXT');
addColumn('users', 'rw_first_connected_at', 'TEXT');
addColumn('users', 'rw_online_at', 'TEXT');
addColumn('users', 'rw_lifetime_traffic', 'INTEGER');
addColumn('users', 'rw_activity_at', 'TEXT');
// Отметка пробного периода у платных клиентов (раньше не снималась при оплате) исключала их из напоминаний
db.exec("UPDATE users SET trial_blocked = 0 WHERE plan_kind = 'paid' AND trial_blocked = 1");

export function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
