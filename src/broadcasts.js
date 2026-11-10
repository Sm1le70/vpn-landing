import { db, tx } from './db.js';
import { config } from './config.js';
import { isValidEmail, normalizeEmail } from './auth.js';
import { fetchRemnaUser, getUserRow } from './subscriptions.js';
import { sendServerUpdate } from './mailer.js';
import { resendEnabled } from './resend.js';
import { tg, telegramEnabled } from './telegram.js';
import { every } from './jobs.js';
import { ValidationError } from './settings.js';

// Очередь сохраняется при перезапуске. Неопределённый результат запроса не повторяем автоматически.
db.exec(`
CREATE TABLE IF NOT EXISTS broadcasts (
 id INTEGER PRIMARY KEY, subject TEXT NOT NULL, text TEXT NOT NULL,
 admin_login TEXT NOT NULL, is_test INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS broadcast_deliveries (
 id INTEGER PRIMARY KEY, broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id),
 user_id INTEGER, channel TEXT NOT NULL, address TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', error TEXT, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS broadcast_pending ON broadcast_deliveries(status, id);
`);

export const defaults = { subject: 'Обновились VPN-серверы', text: 'VPN-серверы обновлены, обновите подписку в приложении.' };
const eligible = (u) => u && !u.blocked && !u.trial_blocked && u.rw_user_id && ['paid', 'trial'].includes(u.plan_kind) && u.rw_status === 'ACTIVE' && Date.parse(u.expire_at) > Date.now();
const candidates = () => db.prepare("SELECT * FROM users WHERE blocked = 0 AND trial_blocked = 0 AND rw_user_id IS NOT NULL AND plan_kind IN ('paid', 'trial') AND rw_status = 'ACTIVE' AND expire_at > ?").all(new Date().toISOString());

function content(input) {
    const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!subject || subject.length > 200 || /[\r\n]/.test(subject)) throw new ValidationError('Тема: от 1 до 200 символов, без переноса строк');
    if (!text || text.length > 3000) throw new ValidationError('Текст: от 1 до 3000 символов');
    return { subject, text };
}

export function broadcastOverview() {
    return { defaults, recipients: candidates().length, mailReady: resendEnabled(), telegramReady: telegramEnabled(),
        history: db.prepare(`SELECT b.*, count(d.id) AS total,
        sum(d.status = 'pending') AS pending, sum(d.status = 'sending') AS sending,
        sum(d.status = 'sent') AS sent, sum(d.status = 'failed') AS failed,
        sum(d.status = 'skipped') AS skipped, sum(d.status = 'unknown') AS unknown
        FROM broadcasts b LEFT JOIN broadcast_deliveries d ON d.broadcast_id = b.id
        GROUP BY b.id ORDER BY b.id DESC LIMIT 50`).all() };
}
export function broadcastDetails(id) {
    return { broadcast: db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id),
        deliveries: db.prepare('SELECT * FROM broadcast_deliveries WHERE broadcast_id = ? ORDER BY id').all(id) };
}
export function createBroadcast(admin, input, test = false) {
    const message = content(input);
    if (!resendEnabled()) throw new ValidationError('Отправка email не настроена: нужен RESEND_API_KEY');
    const email = normalizeEmail(String(input.email ?? ''));
    if (test && !isValidEmail(email)) throw new ValidationError('Введите корректный email для теста');
    return tx(() => {
        if (!test && db.prepare("SELECT 1 FROM broadcast_deliveries d JOIN broadcasts b ON b.id = d.broadcast_id WHERE b.is_test = 0 AND d.status IN ('pending','sending')").get()) throw new ValidationError('Предыдущая рассылка ещё выполняется');
        const users = test ? [] : candidates();
        if (!test && !users.length) throw new ValidationError('Нет активных получателей');
        const id = Number(db.prepare('INSERT INTO broadcasts(subject, text, admin_login, is_test) VALUES (?, ?, ?, ?)').run(message.subject, message.text, admin.login, Number(test)).lastInsertRowid);
        const insert = db.prepare('INSERT INTO broadcast_deliveries(broadcast_id, user_id, channel, address) VALUES (?, ?, ?, ?)');
        if (test) insert.run(id, null, 'email', email);
        for (const u of users) {
            insert.run(id, u.id, 'email', u.email);
            if (telegramEnabled()) for (const c of db.prepare('SELECT tg_user_id FROM tg_clients WHERE user_id = ? AND banned = 0').all(u.id)) insert.run(id, u.id, 'telegram', String(c.tg_user_id));
        }
        return { id };
    });
}
let running = false;
export async function processBroadcasts() {
    if (running) return;
    running = true;
    try {
        // Один запрос за проход: ограничиваем скорость и не блокируем HTTP-запрос администратора.
        const d = db.prepare("SELECT d.*, b.subject, b.text, b.is_test FROM broadcast_deliveries d JOIN broadcasts b ON b.id = d.broadcast_id WHERE d.status = 'pending' ORDER BY b.is_test DESC, d.id LIMIT 1").get();
        if (!d) return;
        db.prepare("UPDATE broadcast_deliveries SET status = 'sending' WHERE id = ?").run(d.id);
        try {
            if (!d.is_test) {
                let u = getUserRow(d.user_id);
                const rw = eligible(u) ? await fetchRemnaUser(u) : null;
                u = getUserRow(d.user_id);
                const linked = d.channel !== 'telegram' || db.prepare('SELECT 1 FROM tg_clients WHERE tg_user_id = ? AND user_id = ? AND banned = 0').get(d.address, d.user_id);
                if (!eligible(u) || !rw || rw.status !== 'ACTIVE' || Date.parse(rw.expireAt) <= Date.now() || !linked) {
                    db.prepare("UPDATE broadcast_deliveries SET status = 'skipped' WHERE id = ?").run(d.id);
                    return;
                }
            }
            if (d.channel === 'email') {
                if (!resendEnabled()) throw new Error('Отправка email не настроена');
                const result = await sendServerUpdate(d.address, d);
                if (!result.id) throw new Error('Провайдер не подтвердил отправку');
            } else {
                await tg('sendMessage', { chat_id: d.address, text: `${d.subject}\n\n${d.text}`, reply_markup: { inline_keyboard: [[{ text: 'Открыть личный кабинет', url: `${config.siteUrl}/cabinet` }]] } });
            }
            db.prepare("UPDATE broadcast_deliveries SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(d.id);
        } catch (err) {
            db.prepare("UPDATE broadcast_deliveries SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).slice(0, 500), d.id);
        }
    } finally { running = false; }
}
export function startBroadcasts() {
    db.prepare("UPDATE broadcast_deliveries SET status = 'unknown', error = 'Процесс прерван во время отправки; проверьте результат у провайдера' WHERE status = 'sending'").run();
    every('broadcasts', 1100, processBroadcasts, { firstDelayMs: 1100 });
}
