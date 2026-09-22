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
        -- 'pending' | 'paid' | 'applied' | 'canceled' | 'chargeback'
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
db.exec('CREATE INDEX IF NOT EXISTS users_expire ON users(expire_at)');

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
