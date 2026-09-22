// Вход по email + одноразовый код, сессии в cookie.
import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { findOrCreateUser } from './subscriptions.js';
import { sendLoginCode } from './mailer.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'sid';

const hmac = (value) => crypto.createHmac('sha256', config.appSecret).update(value).digest('hex');

export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
export const isValidEmail = (email) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

export class AuthError extends Error {}

export async function requestLoginCode(email) {
    const now = Date.now();
    const existing = db.prepare('SELECT sent_at FROM login_codes WHERE email = ?').get(email);
    if (existing && now - existing.sent_at < CODE_RESEND_MS) {
        const wait = Math.ceil((CODE_RESEND_MS - (now - existing.sent_at)) / 1000);
        throw new AuthError(`Код уже отправлен. Повторить можно через ${wait} с`);
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    db.prepare(
        `INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`,
    ).run(email, hmac(`${email}:${code}`), now + CODE_TTL_MS, now);
    await sendLoginCode(email, code);
}

export function verifyLoginCode(email, code) {
    const row = db.prepare('SELECT * FROM login_codes WHERE email = ?').get(email);
    if (!row || row.expires_at < Date.now()) throw new AuthError('Код истёк, запросите новый');
    if (row.attempts >= CODE_MAX_ATTEMPTS) throw new AuthError('Слишком много попыток, запросите новый код');

    const expected = Buffer.from(row.code_hash);
    const actual = Buffer.from(hmac(`${email}:${String(code ?? '').trim()}`));
    if (!crypto.timingSafeEqual(expected, actual)) {
        db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
        throw new AuthError('Неверный код');
    }
    db.prepare('DELETE FROM login_codes WHERE email = ?').run(email);

    const user = findOrCreateUser(email);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hmac(token), user.id, Date.now() + SESSION_TTL_MS);
    return { user, token };
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
        if (k === name) return decodeURIComponent(v.join('='));
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
}
