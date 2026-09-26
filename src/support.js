// Обращения в поддержку: приём писем из Resend Inbound, привязка к тредам, фоновая дозагрузка.
// Вебхук email.received содержит только метаданные — тело и заголовки забираем через API Resend.
import { config } from './config.js';
import { db, tx } from './db.js';
import { getSettings } from './settings.js';
import { resend, resendEnabled } from './resend.js';
import { sendSupportNotice, supportFrom } from './mailer.js';
import { notifyInbound } from './tgnotify.js';

export const THREAD_STATUSES = ['new', 'waiting', 'answered', 'closed'];
export const STATUS_TITLES = { new: 'Новое', waiting: 'Ждёт ответа', answered: 'Отвечено', closed: 'Закрыто' };

// Лимиты сохраняемого тела письма (символы)
const TEXT_MAX = 200_000;
const HTML_MAX = 1_000_000;
const MAX_ATTACHMENTS = 50;
// Повторы получения письма через API: 1 мин, 5 мин, 30 мин, 2 ч, 6 ч, 12 ч, 12 ч (~33 ч суммарно)
const RETRY_DELAYS_SEC = [60, 300, 1800, 7200, 21_600, 43_200, 43_200];

// ---------- Разбор адресов, тем и заголовков ----------

export function parseAddress(value) {
    const s = String(Array.isArray(value) ? value[0] ?? '' : value ?? '').trim();
    const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
    return { name: null, email: s.toLowerCase() };
}

const addressList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((a) => parseAddress(a).email).filter(Boolean);

// Убирает Re:/Fwd:/Отв:/Пересл: (в том числе повторные и вида "Re[2]:") для сравнения тем.
export function normalizeSubject(subject) {
    let s = String(subject ?? '').trim();
    const prefix = /^(re|fwd?|aw|wg|sv|vs|tr|ответ|отв|пересл|переслать)\s*(\[\d+\]|\(\d+\))?\s*:\s*/i;
    while (prefix.test(s)) s = s.replace(prefix, '').trim();
    return s.replace(/\s+/g, ' ').toLowerCase().slice(0, 300);
}

export const replySubject = (subject) => {
    const s = String(subject ?? '').trim();
    return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
};

// Все "<...>" из In-Reply-To / References
export const extractMessageIds = (...values) =>
    [...new Set(values.flatMap((v) => String(v ?? '').match(/<[^<>\s]+>/g) ?? []))];

// Заголовки из API Resend приходят с разным регистром ключей, значения — строкой или массивом.
function headerReader(headers) {
    const map = new Map();
    for (const [k, v] of Object.entries(headers ?? {})) map.set(k.toLowerCase(), Array.isArray(v) ? v.join(' ') : String(v ?? ''));
    return (name) => map.get(name) ?? '';
}

// Грубое извлечение текста из HTML — только если у письма нет текстовой части.
export function htmlToText(html) {
    return String(html ?? '')
        .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ---------- Проверка отправителя ----------

// По результатам, которые Resend вычисляет при приёме письма (authentication: spf, dkim, dmarc).
// Адрес в поле From подтверждает только DMARC (он проверяет, что домен From совпадает с проверенным отправителем):
// 'pass' — DMARC пройден; 'fail' — DMARC не пройден или не прошли и SPF, и DKIM; 'unknown' — данных нет
// или у домена нет DMARC. Неподтверждённое письмо не привязывается к аккаунту и к переписке по email и теме.
export function senderAuth(authentication) {
    const a = authentication ?? {};
    if (a.dmarc === 'pass') return 'pass';
    if (a.dmarc === 'fail' || (a.spf === 'fail' && a.dkim === 'fail')) return 'fail';
    return 'unknown';
}

// ---------- Защита от петель ----------

function ownAddresses() {
    return new Set(
        [getSettings().supportEmail, config.supportEmail, supportFrom(), config.mail.from, config.support.notifyEmail]
            .map((a) => parseAddress(a).email)
            .filter(Boolean),
    );
}

// Причина пропуска письма или null. header — функция чтения заголовка (может вернуть '' для всех).
function autoReplyReason(fromEmail, header) {
    if (ownAddresses().has(fromEmail)) return 'письмо от нашего адреса';
    if (/^(mailer-daemon|postmaster)@/i.test(fromEmail)) return 'уведомление почтового сервера';
    const auto = header('auto-submitted').trim().toLowerCase();
    if (auto && auto !== 'no') return `Auto-Submitted: ${auto}`;
    const precedence = header('precedence').trim().toLowerCase();
    if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return `Precedence: ${precedence}`;
    if (header('x-autoreply') || header('x-autorespond')) return 'автоответ (X-Autoreply)';
    if (header('list-id')) return 'рассылка (List-Id)';
    if (/multipart\/report/i.test(header('content-type'))) return 'отчёт о доставке';
    return null;
}

// ---------- Очередь входящих ----------

// Вызывается из вебхука. Возвращает false, если это повторная доставка.
export function enqueueInbound(data) {
    const emailId = String(data?.email_id ?? '');
    if (!emailId) return false;
    const { changes } = db
        .prepare('INSERT OR IGNORE INTO support_inbox (email_id, payload) VALUES (?, ?)')
        .run(emailId, JSON.stringify(data));
    if (changes) processInboxItem(emailId).catch((err) => console.error('[support] обработка письма:', err));
    return changes > 0;
}

const processing = new Set();

export async function processInboxItem(emailId) {
    if (processing.has(emailId)) return;
    processing.add(emailId);
    try {
        const row = db.prepare("SELECT * FROM support_inbox WHERE email_id = ? AND status = 'pending'").get(emailId);
        if (!row) return;
        const meta = JSON.parse(row.payload);

        let full = null;
        try {
            if (!resendEnabled()) throw new Error('RESEND_API_KEY не задан');
            full = await resend.getReceivedEmail(emailId);
        } catch (err) {
            const attempts = row.attempts + 1;
            if (attempts <= RETRY_DELAYS_SEC.length) {
                db.prepare('UPDATE support_inbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE email_id = ?').run(
                    attempts,
                    Date.now() + RETRY_DELAYS_SEC[attempts - 1] * 1000,
                    String(err.message).slice(0, 500),
                    emailId,
                );
                console.warn(`[support] письмо ${emailId} не получено (попытка ${attempts}): ${err.message}`);
                return;
            }
            // Попытки исчерпаны — сохраняем то, что есть в вебхуке, чтобы обращение не потерялось.
            console.error(`[support] письмо ${emailId} так и не получено, сохраняю метаданные`);
        }

        const header = full ? headerReader(full.headers) : () => '';
        const from = parseAddress(full ? header('from') || full.from : meta.from);
        if (!from.email) from.email = parseAddress(meta.from).email;
        const reason = autoReplyReason(from.email, header);
        if (reason) {
            db.prepare("UPDATE support_inbox SET status = 'ignored', ignore_reason = ? WHERE email_id = ?").run(reason, emailId);
            console.log(`[support] письмо ${emailId} от ${from.email} пропущено: ${reason}`);
            return;
        }

        const auth = senderAuth(full?.authentication);
        const result = storeInbound(emailId, meta, full, from, header, auth);
        db.prepare("UPDATE support_inbox SET status = 'done', last_error = NULL WHERE email_id = ?").run(emailId);
        if (result) {
            // Оповещение в теме «Обращения» группы поддержки Telegram (если включено в настройках)
            const status = db.prepare('SELECT status FROM support_threads WHERE id = ?').get(result.threadId)?.status;
            notifyInbound({
                threadId: result.threadId,
                kind: result.isNew ? 'new' : result.reopened ? 'reopen' : 'client',
                email: from.email,
                name: from.name,
                subject: result.subject,
                text: result.text,
                attachments: result.attachments,
                contentMissing: !full,
                senderAuth: auth,
                statusTitle: STATUS_TITLES[status] ?? status,
            });
        }
        if (result && (result.isNew || result.reopened) && config.support.notifyEmail) {
            sendSupportNotice(config.support.notifyEmail, { threadId: result.threadId, email: from.email, reopened: result.reopened })
                .catch((err) => console.error('[support] уведомление не отправлено:', err.message));
        }
    } finally {
        processing.delete(emailId);
    }
}

// bySubject — искать и по email и теме (только для подтверждённого отправителя: иначе чужое письмо
// с подделанным From попало бы в переписку клиента)
function findThreadId(fromEmail, subjectNorm, messageIds, { bySubject = true } = {}) {
    if (messageIds.length) {
        const ids = messageIds.slice(-50);
        const hit = db
            .prepare(`SELECT thread_id FROM support_messages WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`)
            .get(...ids);
        if (hit) return hit.thread_id;
    }
    if (!bySubject) return undefined;
    return db
        .prepare("SELECT id FROM support_threads WHERE email = ? AND subject_norm = ? AND status != 'closed' ORDER BY last_message_at DESC LIMIT 1")
        .get(fromEmail, subjectNorm)?.id;
}

function storeInbound(emailId, meta, full, from, header, auth) {
    const verified = auth === 'pass';
    const subject = String(full?.subject ?? meta.subject ?? '').slice(0, 500);
    const subjectNorm = normalizeSubject(subject);
    const inReplyTo = header('in-reply-to');
    const references = header('references');
    const messageId = String(full?.message_id ?? meta.message_id ?? '') || null;

    let text = full?.text ?? null;
    let html = full?.html ?? null;
    if (!text && html) text = htmlToText(html);
    let truncated = 0;
    if (text && text.length > TEXT_MAX) (text = text.slice(0, TEXT_MAX)), (truncated = 1);
    if (html && html.length > HTML_MAX) (html = html.slice(0, HTML_MAX)), (truncated = 1);
    const attachments = (full?.attachments ?? meta.attachments ?? []).slice(0, MAX_ATTACHMENTS);
    const createdAt = sqlDate(full?.created_at ?? meta.created_at);

    return tx(() => {
        if (db.prepare('SELECT 1 FROM support_messages WHERE resend_id = ?').get(emailId)) return null;
        // К аккаунту письмо привязывается, только если отправитель подтверждён
        const userId = verified ? db.prepare('SELECT id FROM users WHERE email = ?').get(from.email)?.id ?? null : null;

        let threadId = findThreadId(from.email, subjectNorm, extractMessageIds(inReplyTo, references), { bySubject: verified });
        let isNew = false;
        let reopened = false;
        if (threadId) {
            const t = db.prepare('SELECT status FROM support_threads WHERE id = ?').get(threadId);
            reopened = t.status === 'closed';
            db.prepare(
                `UPDATE support_threads SET status = CASE WHEN status = 'new' THEN 'new' ELSE 'waiting' END, unread = 1,
                 user_id = COALESCE(user_id, ?), sender_verified = CASE WHEN ? THEN 1 ELSE sender_verified END,
                 last_message_at = ?, updated_at = datetime('now') WHERE id = ?`,
            ).run(userId, verified ? 1 : 0, createdAt, threadId);
        } else {
            isNew = true;
            threadId = Number(
                db
                    .prepare('INSERT INTO support_threads (email, user_id, subject, subject_norm, last_message_at, sender_verified) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(from.email, userId, subject, subjectNorm, createdAt, verified ? 1 : 0).lastInsertRowid,
            );
        }

        const msgId = Number(
            db
                .prepare(
                    `INSERT INTO support_messages (thread_id, direction, resend_id, message_id, in_reply_to, references_hdr, from_addr, from_name,
                        to_addrs, cc_addrs, subject, text, html, truncated, content_missing, created_at, sender_auth, sender_auth_details)
                     VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    threadId, emailId, messageId, inReplyTo || null, references || null, from.email, from.name,
                    addressList(full?.to ?? meta.to).join(', '), addressList(full?.cc ?? meta.cc).join(', ') || null,
                    subject, text, html, truncated, full ? 0 : 1, createdAt,
                    auth, full?.authentication ? JSON.stringify(full.authentication) : null,
                ).lastInsertRowid,
        );
        let attachmentsSaved = 0;
        const insertAtt = db.prepare(
            `INSERT INTO support_attachments (message_id, resend_attachment_id, filename, content_type, size, content_disposition, content_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const a of attachments) {
            if (!a?.id) continue;
            insertAtt.run(msgId, String(a.id), String(a.filename ?? 'file').slice(0, 255), a.content_type ?? null,
                Number.isFinite(a.size) ? a.size : null, a.content_disposition ?? null, a.content_id ?? null);
            attachmentsSaved += 1;
        }
        return { threadId, isNew, reopened, subject, text, attachments: attachmentsSaved };
    });
}

// ISO → формат datetime('now') SQLite, чтобы сортировка и отображение были единообразны
function sqlDate(value) {
    const d = new Date(value ?? Date.now());
    return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().replace('T', ' ').slice(0, 19);
}

// ---------- Фоновые задачи ----------

async function retryPendingInbox() {
    const rows = db
        .prepare("SELECT email_id FROM support_inbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY received_at LIMIT 20")
        .all(Date.now());
    for (const r of rows) await processInboxItem(r.email_id);
}

// Resend возвращает при отправке только id; настоящий Message-ID ответа дозапрашиваем,
// чтобы ответ клиента привязался к треду по In-Reply-To.
export async function fillOutgoingMessageId(messageRowId, resendId) {
    const email = await resend.getSentEmail(resendId);
    if (email?.message_id) db.prepare('UPDATE support_messages SET message_id = ? WHERE id = ?').run(email.message_id, messageRowId);
    return email?.message_id ?? null;
}

async function retryOutgoingMessageIds() {
    if (!resendEnabled()) return;
    const rows = db
        .prepare(
            `SELECT id, resend_id FROM support_messages WHERE direction = 'out' AND message_id IS NULL AND resend_id IS NOT NULL
             AND created_at > datetime('now', '-1 day') LIMIT 20`,
        )
        .all();
    for (const r of rows) {
        try {
            await fillOutgoingMessageId(r.id, r.resend_id);
        } catch (err) {
            console.warn(`[support] Message-ID ответа ${r.resend_id}: ${err.message}`);
        }
    }
}

// Записи очереди нужны только для защиты от повторной доставки (Resend повторяет до ~28 ч).
const cleanupInbox = () =>
    db.prepare("DELETE FROM support_inbox WHERE status IN ('done', 'ignored') AND received_at < datetime('now', '-30 days')").run();

export function startSupportJobs() {
    const safe = (fn) => () => Promise.resolve().then(fn).catch((err) => console.error('[support jobs]', err));
    setInterval(safe(retryPendingInbox), 60_000).unref();
    setInterval(safe(retryOutgoingMessageIds), 5 * 60_000).unref();
    setInterval(safe(cleanupInbox), 24 * 60 * 60_000).unref();
    setTimeout(safe(retryPendingInbox), 10_000).unref();
}
