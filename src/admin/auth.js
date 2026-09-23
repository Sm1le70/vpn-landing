// Авторизация администраторов: пароль (scrypt) + TOTP (RFC 6238), резервные коды,
// сессии в cookie, защита от перебора, одноразовые ссылки настройки доступа.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { db, tx } from '../db.js';
import { getSettings } from '../settings.js';

export class AdminAuthError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export const ROLES = { admin: 'Администратор', support: 'Поддержка' };
export const ADMIN_COOKIE = 'asid';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SETUP_TTL = { bootstrap: 60 * 60 * 1000, invite: 24 * 60 * 60 * 1000, reset: 24 * 60 * 60 * 1000 };

const hmac = (value) => crypto.createHmac('sha256', config.appSecret).update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

// ---------- Пароли ----------

export function validatePassword(password) {
    const p = String(password ?? '');
    if (p.length < 10) throw new AdminAuthError('Пароль должен быть не короче 10 символов');
    if (p.length > 200) throw new AdminAuthError('Слишком длинный пароль');
    return p;
}

export function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
    const [scheme, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password ?? ''), Buffer.from(saltB64, 'base64'), expected.length);
    return crypto.timingSafeEqual(expected, actual);
}

// Для выравнивания времени ответа, когда логин не найден.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export const validateLogin = (login) => {
    const l = String(login ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(l)) throw new AdminAuthError('Логин: 3–32 символа, латиница, цифры, точка, _ и -');
    return l;
};

// ---------- TOTP ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(str) {
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of str.replace(/=+$/, '').toUpperCase()) {
        const idx = B32.indexOf(ch);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

function hotp(secret, counter) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
    const offset = digest[digest.length - 1] & 0xf;
    const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    return String(code).padStart(6, '0');
}

// Защита от повторного использования одного и того же кода.
const lastTotpCounter = new Map();

function verifyTotp(secret, code, replayKey) {
    const c = String(code ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(c)) return false;
    const now = Math.floor(Date.now() / 30_000);
    for (const counter of [now - 1, now, now + 1]) {
        const expected = hotp(secret, counter);
        if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) {
            if (replayKey && (lastTotpCounter.get(replayKey) ?? -1) >= counter) return false;
            if (replayKey) lastTotpCounter.set(replayKey, counter);
            return true;
        }
    }
    return false;
}

// Для тестов и демо.
export const currentTotp = (secret) => hotp(secret, Math.floor(Date.now() / 30_000));

async function totpEnrollment(login) {
    const secret = base32Encode(crypto.randomBytes(20));
    const issuer = `${getSettings().brandName} Admin`;
    const otpauthUrl = `otpauth://totp/${encodeURIComponent(`${issuer}:${login}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    const qrSvg = await QRCode.toString(otpauthUrl, { type: 'svg', margin: 1 });
    return { secret, otpauthUrl, qrSvg };
}

function generateBackupCodes() {
    const codes = Array.from({ length: 10 }, () => {
        const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
        return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    return { codes, hashes: codes.map((c) => hmac(`backup:${c}`)) };
}

function consumeBackupCode(admin, code) {
    const normalized = String(code ?? '').trim().toUpperCase();
    if (!/^[0-9A-F]{5}-[0-9A-F]{5}$/.test(normalized)) return false;
    const hashes = JSON.parse(admin.backup_codes || '[]');
    const h = hmac(`backup:${normalized}`);
    const idx = hashes.indexOf(h);
    if (idx < 0) return false;
    hashes.splice(idx, 1);
    db.prepare('UPDATE admins SET backup_codes = ? WHERE id = ?').run(JSON.stringify(hashes), admin.id);
    return true;
}

// ---------- Защита от перебора ----------

const failures = new Map();
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

function assertNotLocked(keys) {
    const now = Date.now();
    for (const key of keys) {
        const f = failures.get(key);
        if (f?.lockedUntil > now) {
            const min = Math.ceil((f.lockedUntil - now) / 60_000);
            throw new AdminAuthError(`Слишком много неудачных попыток. Повторите через ${min} мин.`, 429);
        }
    }
}

function registerFailure(keys) {
    const now = Date.now();
    for (const key of keys) {
        const f = failures.get(key) ?? { count: 0, first: now, lockedUntil: 0 };
        if (now - f.first > LOCK_MS) Object.assign(f, { count: 0, first: now });
        f.count += 1;
        if (f.count >= LOCK_AFTER) f.lockedUntil = now + LOCK_MS;
        failures.set(key, f);
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [k, f] of failures) if (f.lockedUntil < now && now - f.first > LOCK_MS) failures.delete(k);
}, 10 * 60 * 1000).unref();

// ---------- Вход ----------

const loginTickets = new Map();

export function passwordStep(login, password, ip) {
    const l = String(login ?? '').trim().toLowerCase();
    const keys = [`login:${l}`, `ip:${ip}`];
    assertNotLocked(keys);
    const admin = db.prepare('SELECT * FROM admins WHERE login = ?').get(l);
    const ok = verifyPassword(password, admin?.password_hash ?? DUMMY_HASH) && admin && !admin.disabled;
    if (!ok) {
        registerFailure(keys);
        throw new AdminAuthError('Неверный логин или пароль', 401);
    }
    failures.delete(`login:${l}`);
    // Демо-учётки создаются без 2FA; все остальные админы всегда проходят второй шаг.
    if (config.admin.demoNo2fa && !admin.totp_secret) return { admin, done: true };
    if (!admin.totp_secret) throw new AdminAuthError('Для учётной записи не настроена 2FA — сбросьте доступ командой admin:reset', 403);
    const ticket = randomToken();
    loginTickets.set(ticket, { adminId: admin.id, expires: Date.now() + 5 * 60 * 1000, ip });
    return { admin, ticket };
}

export function secondFactorStep(ticket, code, ip) {
    const t = loginTickets.get(String(ticket ?? ''));
    if (!t || t.expires < Date.now()) throw new AdminAuthError('Сессия входа истекла, введите пароль заново', 401);
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(t.adminId);
    const keys = [`login:${admin.login}`, `ip:${ip}`];
    assertNotLocked(keys);
    const ok = verifyTotp(admin.totp_secret, code, `admin:${admin.id}`) || consumeBackupCode(admin, code);
    if (!ok || admin.disabled) {
        registerFailure(keys);
        throw new AdminAuthError('Неверный код', 401);
    }
    loginTickets.delete(ticket);
    failures.delete(`login:${admin.login}`);
    return admin;
}

export function createSession(adminId, ip) {
    const token = randomToken();
    db.prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at, ip) VALUES (?, ?, ?, ?)').run(
        hmac(token),
        adminId,
        Date.now() + SESSION_TTL_MS,
        ip,
    );
    db.prepare("UPDATE admins SET last_login_at = datetime('now') WHERE id = ?").run(adminId);
    return token;
}

export function getSessionAdmin(token) {
    if (!token) return null;
    return (
        db
            .prepare(
                `SELECT a.* FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
                 WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled = 0`,
            )
            .get(hmac(token), Date.now()) ?? null
    );
}

export const destroySession = (token) => token && db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hmac(token));
export const destroyAdminSessions = (adminId) => db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(adminId);

export function sessionCookieOptions() {
    return { httpOnly: true, secure: config.isHttps, sameSite: 'strict', maxAge: SESSION_TTL_MS, path: config.admin.path };
}

export function cleanupAdminAuth() {
    const now = Date.now();
    db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM admin_setup_tokens WHERE expires_at < ? AND used_at IS NULL').run(now - 24 * 60 * 60 * 1000);
    for (const [k, t] of loginTickets) if (t.expires < now) loginTickets.delete(k);
}

// ---------- Ссылки настройки доступа ----------

export function setupUrl(token) {
    return `${config.siteUrl}${config.admin.path}/#/setup/${token}`;
}

// enableAdmin — при завершении сброса включить учётку (admin:reset из консоли).
// До этого старые пароль и 2FA отключённого администратора не работают.
export function createSetupToken({ kind, adminId = null, login = null, role, createdBy = null, enableAdmin = false }) {
    const token = randomToken();
    tx(() => {
        // Для одного администратора действует только последняя ссылка.
        if (kind === 'bootstrap') db.prepare("DELETE FROM admin_setup_tokens WHERE kind = 'bootstrap' AND used_at IS NULL").run();
        if (adminId) db.prepare('DELETE FROM admin_setup_tokens WHERE admin_id = ? AND used_at IS NULL').run(adminId);
        if (login && !adminId) db.prepare('DELETE FROM admin_setup_tokens WHERE login = ? AND used_at IS NULL').run(login);
        db.prepare(
            'INSERT INTO admin_setup_tokens (token_hash, kind, admin_id, login, role, expires_at, created_by, enable_admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(hmac(token), kind, adminId, login, role, Date.now() + SETUP_TTL[kind], createdBy, enableAdmin ? 1 : 0);
    });
    return { token, url: setupUrl(token), expiresInHours: SETUP_TTL[kind] / 3_600_000 };
}

function getSetupRow(token) {
    const row = db.prepare('SELECT * FROM admin_setup_tokens WHERE token_hash = ?').get(hmac(String(token ?? '')));
    if (!row || row.used_at || row.expires_at < Date.now()) throw new AdminAuthError('Ссылка недействительна или устарела', 404);
    if (row.kind === 'bootstrap' && db.prepare('SELECT COUNT(*) AS n FROM admins').get().n > 0) {
        throw new AdminAuthError('Администратор уже создан. Используйте обычный вход.', 404);
    }
    return row;
}

export function setupInfo(token) {
    const row = getSetupRow(token);
    const login = row.admin_id ? db.prepare('SELECT login FROM admins WHERE id = ?').get(row.admin_id)?.login : row.login;
    return { kind: row.kind, login, loginEditable: row.kind === 'bootstrap', role: row.role, roleTitle: ROLES[row.role] };
}

export async function setupStart(token, { login, password }) {
    const row = getSetupRow(token);
    const info = setupInfo(token);
    const finalLogin = info.loginEditable ? validateLogin(login) : info.login;
    const passwordHash = hashPassword(validatePassword(password));
    const enrollment = await totpEnrollment(finalLogin);
    db.prepare('UPDATE admin_setup_tokens SET pending = ? WHERE token_hash = ?').run(
        JSON.stringify({ login: finalLogin, passwordHash, secret: enrollment.secret }),
        row.token_hash,
    );
    return { login: finalLogin, secret: enrollment.secret, otpauthUrl: enrollment.otpauthUrl, qrSvg: enrollment.qrSvg };
}

export function setupFinish(token, code) {
    const row = getSetupRow(token);
    const pending = row.pending ? JSON.parse(row.pending) : null;
    if (!pending) throw new AdminAuthError('Сначала задайте пароль');
    if (!verifyTotp(pending.secret, code)) throw new AdminAuthError('Неверный код из приложения. Проверьте время на телефоне.');
    const backup = generateBackupCodes();

    const admin = tx(() => {
        let adminId = row.admin_id;
        if (row.kind === 'reset') {
            db.prepare(
                'UPDATE admins SET password_hash = ?, totp_secret = ?, backup_codes = ?, disabled = CASE WHEN ? THEN 0 ELSE disabled END WHERE id = ?',
            ).run(pending.passwordHash, pending.secret, JSON.stringify(backup.hashes), row.enable_admin, adminId);
            destroyAdminSessions(adminId);
        } else {
            if (db.prepare('SELECT 1 FROM admins WHERE login = ?').get(pending.login)) {
                throw new AdminAuthError('Администратор с таким логином уже существует');
            }
            adminId = Number(
                db
                    .prepare('INSERT INTO admins (login, role, password_hash, totp_secret, backup_codes) VALUES (?, ?, ?, ?, ?)')
                    .run(pending.login, row.role, pending.passwordHash, pending.secret, JSON.stringify(backup.hashes)).lastInsertRowid,
            );
        }
        db.prepare("UPDATE admin_setup_tokens SET used_at = datetime('now'), pending = NULL WHERE token_hash = ?").run(row.token_hash);
        return db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId);
    });
    return { admin, backupCodes: backup.codes, kind: row.kind };
}

// Если администраторов нет — в лог выводится ссылка для создания первого.
export function ensureBootstrap() {
    if (!config.admin.path) return;
    if (db.prepare('SELECT COUNT(*) AS n FROM admins').get().n > 0) return;
    const { url } = createSetupToken({ kind: 'bootstrap', role: 'admin' });
    console.log(`
==============================================================
  Администраторов ещё нет. Создайте первого по ссылке (действует 1 час):
  ${url}
  Ссылка генерируется заново при каждом запуске, пока админ не создан.
==============================================================`);
}

// Демо: администратор admin / admin без 2FA.
export function ensureDemoAdmin() {
    if (db.prepare("SELECT 1 FROM admins WHERE login = 'admin'").get()) return;
    db.prepare("INSERT INTO admins (login, role, password_hash) VALUES ('admin', 'admin', ?)").run(hashPassword('admin'));
    db.prepare("INSERT OR IGNORE INTO admins (login, role, password_hash) VALUES ('support', 'support', ?)").run(hashPassword('support'));
}
