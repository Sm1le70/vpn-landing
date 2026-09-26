// Вход по email + одноразовый код, сессии в cookie.
import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { findOrCreateUser } from './subscriptions.js';
import { sendLoginCode } from './mailer.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
// Постоянный код отключается после стольких неверных попыток — защита от подбора
const STATIC_CODE_MAX_ATTEMPTS = 20;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Суточные лимиты на email (скользящее окно): писем с кодом и неверных вводов кода из письма.
// Вместе с лимитом попыток на один код ограничивают подбор и рассылку писем на чужой адрес.
const LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_CODES = 10;
const DAILY_FAILURES = 15;
export const SESSION_COOKIE = 'sid';

const hmac = (value) => crypto.createHmac('sha256', config.appSecret).update(value).digest('hex');

export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
export const isValidEmail = (email) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

export class AuthError extends Error {}

const logEvent = (email, kind) => db.prepare('INSERT INTO login_events (email, kind, created_at) VALUES (?, ?, ?)').run(email, kind, Date.now());

// Бросает AuthError, если за последние сутки у email не меньше max событий kind
function assertDailyLimit(email, kind, max, message) {
    const since = Date.now() - LIMIT_WINDOW_MS;
    const { n, oldest } = db
        .prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM login_events WHERE email = ? AND kind = ? AND created_at > ?')
        .get(email, kind, since);
    if (n < max) return;
    const hours = Math.max(1, Math.ceil((oldest + LIMIT_WINDOW_MS - Date.now()) / 3_600_000));
    throw new AuthError(`${message} Повторить можно через ${hours} ч. Если нужна помощь — напишите в поддержку.`);
}

const TOO_MANY_FAILURES = 'Слишком много неверных попыток ввода кода.';

export async function requestLoginCode(email) {
    assertDailyLimit(email, 'fail', DAILY_FAILURES, TOO_MANY_FAILURES);
    assertDailyLimit(email, 'code', DAILY_CODES, 'Слишком много кодов за сутки.');
    const now = Date.now();
    const existing = db.prepare('SELECT sent_at FROM login_codes WHERE email = ?').get(email);
    if (existing && now - existing.sent_at < CODE_RESEND_MS) {
        const wait = Math.ceil((CODE_RESEND_MS - (now - existing.sent_at)) / 1000);
        throw new AuthError(`Код уже отправлен. Повторить можно через ${wait} с`);
    }
    await sendLoginCode(email, issueLoginCode(email));
    logEvent(email, 'code');
}

// Создаёт код входа без отправки письма (используется и консольной командой login-code).
export function issueLoginCode(email, ttlMs = CODE_TTL_MS) {
    const now = Date.now();
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    db.prepare(
        `INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`,
    ).run(email, hmac(`${email}:${code}`), now + ttlMs, now);
    return code;
}

const codeMatches = (hash, email, code) =>
    crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac(`${email}:${String(code ?? '').trim()}`)));

// Постоянный код для тестового аккаунта: не истекает и не удаляется после входа (login-code --permanent).
export function issueStaticLoginCode(email) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    db.prepare(
        `INSERT INTO static_login_codes (email, code_hash) VALUES (?, ?)
         ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, created_at = datetime('now')`,
    ).run(email, hmac(`${email}:${code}`));
    return code;
}

export const revokeStaticLoginCode = (email) => db.prepare('DELETE FROM static_login_codes WHERE email = ?').run(email).changes > 0;

export const listStaticLoginCodes = () => db.prepare('SELECT email, attempts, created_at FROM static_login_codes ORDER BY email').all();

function createSession(email) {
    const user = findOrCreateUser(email);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hmac(token), user.id, Date.now() + SESSION_TTL_MS);
    return { user, token };
}

export function verifyLoginCode(email, code) {
    const fixed = db.prepare('SELECT * FROM static_login_codes WHERE email = ?').get(email);
    if (fixed && fixed.attempts < STATIC_CODE_MAX_ATTEMPTS) {
        if (codeMatches(fixed.code_hash, email, code)) return createSession(email);
        db.prepare('UPDATE static_login_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
        // Кода из письма для этого email нет — не пишем «код истёк», код просто неверный
        if (!db.prepare('SELECT 1 FROM login_codes WHERE email = ?').get(email)) throw new AuthError('Неверный код');
    }

    const row = db.prepare('SELECT * FROM login_codes WHERE email = ?').get(email);
    if (!row || row.expires_at < Date.now()) throw new AuthError('Код истёк, запросите новый');
    assertDailyLimit(email, 'fail', DAILY_FAILURES, TOO_MANY_FAILURES);
    if (row.attempts >= CODE_MAX_ATTEMPTS) throw new AuthError('Слишком много попыток, запросите новый код');

    if (!codeMatches(row.code_hash, email, code)) {
        db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
        logEvent(email, 'fail');
        throw new AuthError('Неверный код');
    }
    db.prepare('DELETE FROM login_codes WHERE email = ?').run(email);
    return createSession(email);
}

// Выход на других устройствах: удаляются все сессии пользователя, кроме текущей. Возвращает число удалённых.
export function destroyOtherSessions(userId, currentToken) {
    return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, hmac(String(currentToken ?? ''))).changes;
}

export function destroySession(token) {
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hmac(token));
}

export function sessionCookieOptions() {
    return { httpOnly: true, secure: config.isHttps, sameSite: 'lax', maxAge: SESSION_TTL_MS, path: '/' };
}

function readCookie(req, name) {
    const header = req.headers.cookie ?? '';
    for (const part of header.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k !== name) continue;
        try {
            return decodeURIComponent(v.join('='));
        } catch {
            return null; // битое значение cookie — считаем, что сессии нет
        }
    }
    return null;
}

export function sessionMiddleware(req, _res, next) {
    const token = readCookie(req, SESSION_COOKIE);
    req.sessionToken = token;
    req.user = null;
    if (token) {
        const row = db
            .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
            .get(hmac(token), Date.now());
        req.user = row ?? null;
    }
    next();
}

export function cleanupExpired() {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('DELETE FROM login_codes WHERE expires_at < ?').run(Date.now() - CODE_TTL_MS);
    db.prepare('DELETE FROM login_events WHERE created_at < ?').run(Date.now() - LIMIT_WINDOW_MS);
}
