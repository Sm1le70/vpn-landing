// Раздел «Обращения» в админке: список, карточка треда, ответ клиенту, смена статуса, вложения.
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { db } from '../db.js';
import { resend, resendEnabled } from '../resend.js';
import { sendSupportReply, supportFrom } from '../mailer.js';
import { STATUS_TITLES, THREAD_STATUSES, extractMessageIds, fillOutgoingMessageId, parseAddress, replySubject } from '../support.js';
import { notifyReply, notifyStatus } from '../tgnotify.js';
import { AdminActionError, audit } from './service.js';
const REPLY_MAX = 20_000;
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

function loadThread(id) {
    const t = db.prepare('SELECT * FROM support_threads WHERE id = ?').get(Number(id));
    if (!t) throw new AdminActionError('Обращение не найдено', 404);
    return t;
}

const publicThread = (t) => ({
    id: t.id,
    email: t.email,
    userId: t.user_id,
    subject: t.subject,
    status: t.status,
    statusTitle: STATUS_TITLES[t.status] ?? t.status,
    unread: Boolean(t.unread),
    lastMessageAt: t.last_message_at,
    createdAt: t.created_at,
    messagesCount: t.messages_count,
});

// ---------- Список ----------

export function listThreads({ status, q, page = 1, pageSize = 50 }) {
    const where = [];
    const params = [];
    if (status === 'unread') where.push('t.unread = 1');
    else if (status === 'open') where.push("t.status != 'closed'");
    else if (THREAD_STATUSES.includes(status)) {
        where.push('t.status = ?');
        params.push(status);
    }
    if (q) {
        where.push('(t.email LIKE ? OR t.subject LIKE ?)');
        const like = `%${String(q).trim()}%`;
        params.push(like.toLowerCase(), like);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM support_threads t ${w}`).get(...params).n;
    const rows = db
        .prepare(
            `SELECT t.*, (SELECT COUNT(*) FROM support_messages m WHERE m.thread_id = t.id) AS messages_count
             FROM support_threads t ${w} ORDER BY t.unread DESC, t.last_message_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (Math.max(1, page) - 1) * pageSize);
    return { total, page, pageSize, items: rows.map(publicThread), counts: counts() };
}

export function counts() {
    const out = { new: 0, waiting: 0, answered: 0, closed: 0, unread: 0, open: 0 };
    for (const r of db.prepare('SELECT status, COUNT(*) AS n, SUM(unread) AS u FROM support_threads GROUP BY status').all()) {
        out[r.status] = r.n;
        out.unread += r.u ?? 0;
        if (r.status !== 'closed') out.open += r.n;
    }
    return out;
}

export const unreadCount = () => db.prepare('SELECT COUNT(*) AS n FROM support_threads WHERE unread = 1').get().n;

export function userThreads(userId) {
    return db
        .prepare(
            `SELECT t.*, (SELECT COUNT(*) FROM support_messages m WHERE m.thread_id = t.id) AS messages_count
             FROM support_threads t WHERE t.user_id = ? OR t.email = (SELECT email FROM users WHERE id = ?)
             ORDER BY t.last_message_at DESC LIMIT 50`,
        )
        .all(userId, userId)
        .map(publicThread);
}

// ---------- Карточка ----------

export function threadDetails(id) {
    const t = loadThread(id);
    if (t.unread) db.prepare('UPDATE support_threads SET unread = 0 WHERE id = ?').run(t.id);
    const attachments = db
        .prepare(
            `SELECT a.* FROM support_attachments a JOIN support_messages m ON m.id = a.message_id
             WHERE m.thread_id = ? ORDER BY a.id`,
        )
        .all(t.id);
    const messages = db
        .prepare('SELECT * FROM support_messages WHERE thread_id = ? ORDER BY created_at, id')
        .all(t.id)
        .map((m) => ({
            id: m.id,
            direction: m.direction,
            fromAddr: m.from_addr,
            fromName: m.from_name,
            to: m.to_addrs,
            cc: m.cc_addrs,
            subject: m.subject,
            // HTML в ответ не отдаём — только признак; показывается в изолированном iframe
            text: m.text,
            hasHtml: Boolean(m.html),
            truncated: Boolean(m.truncated),
            contentMissing: Boolean(m.content_missing),
            adminLogin: m.admin_login,
            createdAt: m.created_at,
            attachments: attachments
                .filter((a) => a.message_id === m.id)
                .map((a) => ({ id: a.id, filename: a.filename, contentType: a.content_type, size: a.size, inline: a.content_disposition === 'inline' })),
        }));
    const user = t.user_id ? db.prepare('SELECT id, email FROM users WHERE id = ?').get(t.user_id) : db.prepare('SELECT id, email FROM users WHERE email = ?').get(t.email);
    return { thread: { ...publicThread(t), unread: false }, messages, user: user ?? null, statusTitles: STATUS_TITLES };
}

// HTML письма для iframe. Изоляцию обеспечивают заголовки, выставляемые в маршруте.
export function messageHtml(id) {
    const m = db.prepare('SELECT html FROM support_messages WHERE id = ?').get(Number(id));
    if (!m?.html) throw new AdminActionError('HTML-версии нет', 404);
    return m.html;
}

// Скачивание вложения: свежая ссылка из API Resend (действует 1 час) и потоковая передача админу.
export async function streamAttachment(id, res) {
    const a = db
        .prepare('SELECT a.*, m.resend_id FROM support_attachments a JOIN support_messages m ON m.id = a.message_id WHERE a.id = ?')
        .get(Number(id));
    if (!a) throw new AdminActionError('Вложение не найдено', 404);
    if (!resendEnabled()) throw new AdminActionError('RESEND_API_KEY не задан — вложение не получить', 503);
    if (a.size && a.size > ATTACHMENT_MAX_BYTES) throw new AdminActionError('Вложение больше 25 МБ — скачайте его в панели Resend');
    const info = await resend.getReceivedAttachment(a.resend_id, a.resend_attachment_id);
    const url = String(info.download_url ?? '');
    // Ссылка ведёт на CDN Resend (https); в демо — на имитацию Resend
    if (!url.startsWith('https://') && !url.startsWith(`${config.mail.resendApiUrl}/`)) {
        throw new AdminActionError('Resend не вернул ссылку на файл', 502);
    }
    const file = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!file.ok || !file.body) throw new AdminActionError(`Не удалось скачать файл: ${file.status}`, 502);
    const length = Number(file.headers.get('content-length'));
    if (length > ATTACHMENT_MAX_BYTES) throw new AdminActionError('Вложение больше 25 МБ — скачайте его в панели Resend');

    const name = String(a.filename || 'file').replace(/[\r\n"\\]/g, '_');
    const ascii = name.replace(/[^\x20-\x7e]/g, '_');
    res.set({
        // Всегда как файл: содержимое от внешнего отправителя не должно открываться в контексте админки
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    if (length) res.set('Content-Length', String(length));
    await pipeline(Readable.fromWeb(file.body), res);
}

// ---------- Действия ----------

export async function reply(admin, threadId, { text, close }) {
    const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!body) throw new AdminActionError('Введите текст ответа');
    if (body.length > REPLY_MAX) throw new AdminActionError(`Ответ не длиннее ${REPLY_MAX} символов`);
    const t = loadThread(threadId);

    const messages = db.prepare('SELECT * FROM support_messages WHERE thread_id = ? ORDER BY created_at, id').all(t.id);
    const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
    // Цепочка для почтовых клиентов: все известные Message-ID треда (последние 20)
    const ids = extractMessageIds(...messages.map((m) => m.message_id)).slice(-20);
    const inReplyTo = lastIn?.message_id ?? ids.at(-1);
    const headers = {};
    if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
    if (ids.length) headers.References = ids.join(' ');

    const quoted = lastIn ?? messages.at(-1);
    // Дата в цитате — по Москве: сервер в Docker работает в UTC
    const quote = quoted?.text
        ? {
            header: `${new Date(`${quoted.created_at.replace(' ', 'T')}Z`).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' })} МСК, ${quoted.from_addr}:`,
            text: quoted.text.slice(0, 20_000),
        }
        : null;
    const subject = replySubject(t.subject || `Обращение №${t.id}`);

    let sent;
    try {
        sent = await sendSupportReply(t.email, { subject, body, quote, headers });
    } catch (err) {
        console.error(`[support] ответ в обращение ${t.id} не отправлен:`, err.message);
        throw new AdminActionError(`Письмо не отправлено: ${err.message}`, 502);
    }
    const quoteText = quote ? `\n\n${quote.header}\n${quote.text.split('\n').map((l) => `> ${l}`).join('\n')}` : '';
    const status = close ? 'closed' : 'answered';
    const msgRowId = Number(
        db
            .prepare(
                `INSERT INTO support_messages (thread_id, direction, resend_id, in_reply_to, references_hdr, from_addr, to_addrs, subject, text, admin_id, admin_login)
                 VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(t.id, sent.id, headers['In-Reply-To'] ?? null, headers.References ?? null, parseAddress(supportFrom()).email, t.email, subject,
                `${body}${quoteText}`, admin.id, admin.login).lastInsertRowid,
    );
    db.prepare("UPDATE support_threads SET status = ?, unread = 0, last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(status, t.id);

    // Настоящий Message-ID ответа: по нему привяжется следующее письмо клиента. Не получили сейчас — дозаберёт фоновая задача.
    if (sent.id) await fillOutgoingMessageId(msgRowId, sent.id).catch((err) => console.warn(`[support] Message-ID ответа: ${err.message}`));

    notifyReply({ threadId: t.id, email: t.email, subject: t.subject, adminLogin: admin.login, text: body, statusTitle: STATUS_TITLES[status] });
    audit(admin, 'support.reply', {
        targetType: 'support_thread', targetId: t.id, targetLabel: t.email,
        details: { resendId: sent.id, subject, statusBefore: t.status, statusAfter: status, length: body.length },
    });
    return { ok: true, status, sent: Boolean(sent.id) };
}

export function setStatus(admin, threadId, { status }) {
    if (!THREAD_STATUSES.includes(status)) throw new AdminActionError('Неизвестный статус');
    const t = loadThread(threadId);
    if (t.status === status) return { status };
    db.prepare("UPDATE support_threads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, t.id);
    notifyStatus({
        threadId: t.id, email: t.email, subject: t.subject, adminLogin: admin.login,
        beforeTitle: STATUS_TITLES[t.status] ?? t.status, afterTitle: STATUS_TITLES[status],
    });
    audit(admin, 'support.status', {
        targetType: 'support_thread', targetId: t.id, targetLabel: t.email, details: { before: t.status, after: status },
    });
    return { status };
}

// Демо: просим имитацию Resend «получить» письмо — она сама пришлёт подписанный вебхук.
export async function demoInbound({ from, subject, text, replyToLast }) {
    if (!config.admin.demoNo2fa) throw new AdminActionError('Доступно только в демо-режиме', 404);
    let inReplyTo = null;
    if (replyToLast) {
        const last = db.prepare("SELECT message_id, subject FROM support_messages WHERE direction = 'out' AND message_id IS NOT NULL ORDER BY id DESC LIMIT 1").get();
        if (!last) throw new AdminActionError('Ещё нет ответов поддержки, на которые можно ответить');
        inReplyTo = last.message_id;
        subject = subject || last.subject;
    }
    const res = await fetch(`${config.mail.resendApiUrl}/demo/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, subject, text, inReplyTo }),
    });
    if (!res.ok) throw new AdminActionError(`Демо-Resend: ${res.status} ${await res.text()}`, 502);
    return { ok: true };
}
