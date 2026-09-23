// Оповещения об email-обращениях в теме «Обращения» группы поддержки Telegram.
// Первое оповещение об обращении — отдельное сообщение, остальные события приходят ответом на него.
// События ставятся в очередь (tg_outbox) и отправляются по порядку внутри обращения: приём почты
// и действия в админке не ждут Telegram. При удалении аккаунта оповещения удаляются из группы.
import { config } from './config.js';
import { db } from './db.js';
import { getSettings } from './settings.js';
import { tg, telegramEnabled, TelegramError } from './telegram.js';
import {
    emailTopicId,
    errText,
    esc,
    groupId,
    isNotModified,
    isTopicClosed,
    isTopicGone,
    onBotReady,
    setEmailTopicId,
    supportBotUsername,
} from './tgsupport.js';

const TOPIC_NAME = 'Обращения';
const EXCERPT_MAX = 500;
// Повторы отправки: 10 с, 30 с, 1 мин, 5 мин, 15 мин, 30 мин, 1 ч (~2 ч суммарно)
const RETRY_DELAYS_SEC = [10, 30, 60, 300, 900, 1800, 3600];
const PURGED_TEXT = (threadId) => `🗑 Обращение №${threadId} удалено вместе с аккаунтом клиента.`;

// ---------- Постановка событий в очередь ----------

// Бот и группа настроены, оповещения включены в админке (Настройки)
const notifyEnabled = () => telegramEnabled() && Boolean(groupId()) && getSettings().telegramEmailNotify;

function enqueue(threadId, kind, payload) {
    db.prepare('INSERT INTO tg_outbox (thread_id, kind, payload) VALUES (?, ?, ?)').run(threadId, kind, JSON.stringify(payload));
    kick();
}

function enqueueEvent(threadId, payload) {
    if (!notifyEnabled()) return;
    try {
        enqueue(threadId, 'event', payload);
    } catch (err) {
        // Оповещение не должно мешать приёму письма или действию в админке
        console.error(`[tg notify] обращение ${threadId}: не удалось поставить оповещение в очередь: ${err.message}`);
    }
}

// Начало текста письма без цитаты прошлой переписки
export function excerpt(text, max = EXCERPT_MAX) {
    const lines = [];
    for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
        const l = line.trim();
        if (l.startsWith('>')) break;
        if (/^(-{2,}\s*(original message|исходное сообщение|пересылаемое сообщение)|on .+ wrote:$|.+ (написал|написала|написал\(а\)|пишет):$)/i.test(l)) break;
        lines.push(l);
    }
    const s = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

const quote = (text) => {
    const s = excerpt(text);
    return s ? `\n\n<blockquote>${esc(s)}</blockquote>` : '';
};
const who = (email, name) => (name ? `${esc(name)} &lt;${esc(email)}&gt;` : esc(email));
const subjectLine = (subject) => `Тема: ${esc(subject || '(без темы)')}`;
const adminUrl = (threadId) => (config.admin.path ? `${config.siteUrl}${config.admin.path}/#/support/${threadId}` : null);

// Письмо клиента. kind: 'new' — новое обращение, 'client' — письмо в открытое, 'reopen' — письмо в закрытое.
export function notifyInbound({ threadId, kind, email, name, subject, text, attachments, contentMissing, statusTitle }) {
    const head = {
        new: `📩 <b>Новое обращение №${threadId}</b>`,
        client: `🔁 <b>№${threadId}: новое письмо клиента</b>`,
        reopen: `🔓 <b>№${threadId}: клиент написал в закрытое обращение</b> — оно открыто снова`,
    }[kind];
    const lines = [head, `От: ${who(email, name)}`, subjectLine(subject)];
    if (kind !== 'new' && statusTitle) lines.push(`Статус: ${esc(statusTitle)}`);
    let out = lines.join('\n') + quote(text);
    if (attachments) out += `\n📎 Вложений: ${attachments}`;
    if (contentMissing) {
        out += '\n\n⚠️ Текст письма получить не удалось, обращение создано по метаданным. Письмо можно посмотреть в панели Resend (Emails → Receiving).';
    }
    enqueueEvent(threadId, { text: out, silent: false });
}

// Ответ сотрудника из админки
export function notifyReply({ threadId, email, subject, adminLogin, text, statusTitle }) {
    const out = [`✉️ <b>№${threadId}: ответ поддержки</b> (${esc(adminLogin)})`, `Кому: ${esc(email)}`, subjectLine(subject)].join('\n')
        + quote(text)
        + `\nСтатус: ${esc(statusTitle)}`;
    enqueueEvent(threadId, { text: out, silent: true });
}

// Смена статуса сотрудником
export function notifyStatus({ threadId, email, subject, adminLogin, beforeTitle, afterTitle }) {
    const out = [`🏷 <b>№${threadId}: статус</b> ${esc(beforeTitle)} → ${esc(afterTitle)} (${esc(adminLogin)})`, `Клиент: ${esc(email)}`, subjectLine(subject)].join('\n');
    enqueueEvent(threadId, { text: out, silent: true });
}

// Удаление аккаунта: неотправленные оповещения отменяются, отправленные удаляются из группы.
// Вызывается внутри транзакции удаления аккаунта (только запросы к БД). Возвращает число сообщений к удалению.
export function purgeThreads(threadIds) {
    let messages = 0;
    for (const id of threadIds.map(Number)) {
        db.prepare("DELETE FROM tg_outbox WHERE thread_id = ? AND kind = 'event'").run(id);
        const n = db.prepare('SELECT COUNT(*) AS n FROM tg_notify_messages WHERE thread_id = ?').get(id).n;
        if (!n) continue;
        messages += n;
        db.prepare("INSERT INTO tg_outbox (thread_id, kind, payload) VALUES (?, 'purge', '{}')").run(id);
    }
    if (messages) setTimeout(kick, 0);
    return messages;
}

// ---------- Отправка ----------

async function ensureTopic() {
    const existing = emailTopicId();
    if (existing) return existing;
    const topic = await tg('createForumTopic', { chat_id: groupId(), name: TOPIC_NAME });
    setEmailTopicId(topic.message_thread_id);
    // Старые первые сообщения остались в удалённой теме — цепочки в новой теме начинаются заново
    db.prepare('UPDATE support_threads SET tg_msg_id = NULL WHERE tg_msg_id IS NOT NULL').run();
    console.log(`[tg notify] создана тема «${TOPIC_NAME}» (#${topic.message_thread_id})`);
    return topic.message_thread_id;
}

function messageParams(threadId, payload, topicId, rootMsgId) {
    const params = {
        chat_id: groupId(),
        message_thread_id: topicId,
        text: payload.text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        disable_notification: Boolean(payload.silent),
    };
    if (rootMsgId) params.reply_parameters = { message_id: rootMsgId, allow_sending_without_reply: true };
    const url = adminUrl(threadId);
    // Telegram принимает в кнопках только публичные адреса — для http (демо, локальный запуск) ссылка идёт в тексте
    if (url && config.isHttps) params.reply_markup = { inline_keyboard: [[{ text: 'Открыть в админке', url }]] };
    else if (url) params.text += `\n\n<a href="${esc(url)}">Открыть в админке</a>`;
    return params;
}

async function sendEvent(row) {
    const payload = JSON.parse(row.payload);
    const thread = db.prepare('SELECT id, tg_msg_id FROM support_threads WHERE id = ?').get(row.thread_id);
    if (!thread) return; // обращение удалено вместе с аккаунтом — не отправляем

    let topicId = await ensureTopic();
    let sent;
    try {
        sent = await tg('sendMessage', messageParams(thread.id, payload, topicId, thread.tg_msg_id));
    } catch (err) {
        if (isTopicGone(err)) {
            // Тему «Обращения» удалили — создаём новую
            setEmailTopicId(null);
            topicId = await ensureTopic();
        } else if (isTopicClosed(err)) {
            await tg('reopenForumTopic', { chat_id: groupId(), message_thread_id: topicId }).catch((e) => {
                if (!isNotModified(e)) throw e;
            });
        } else {
            throw err;
        }
        const root = db.prepare('SELECT tg_msg_id FROM support_threads WHERE id = ?').get(thread.id)?.tg_msg_id;
        sent = await tg('sendMessage', messageParams(thread.id, payload, topicId, root));
    }

    db.prepare('INSERT INTO tg_notify_messages (thread_id, chat_id, message_id) VALUES (?, ?, ?)').run(thread.id, groupId(), sent.message_id);
    // Первое сообщение обращения в теме — на него будут отвечать следующие события
    db.prepare('UPDATE support_threads SET tg_msg_id = ? WHERE id = ? AND tg_msg_id IS NULL').run(sent.message_id, thread.id);
}

// Удаление оповещений обращения. Если удалить нельзя (нет права «Удаление сообщений»),
// сообщение редактируется: из него убираются email и текст письма.
async function purgeThread(row) {
    const messages = db.prepare('SELECT rowid, chat_id, message_id FROM tg_notify_messages WHERE thread_id = ?').all(row.thread_id);
    const byChat = new Map();
    for (const m of messages) byChat.set(m.chat_id, [...(byChat.get(m.chat_id) ?? []), m]);
    for (const [chatId, list] of byChat) {
        for (let i = 0; i < list.length; i += 100) {
            const chunk = list.slice(i, i + 100);
            let bulkOk = false;
            try {
                bulkOk = await tg('deleteMessages', { chat_id: chatId, message_ids: chunk.map((m) => m.message_id) });
            } catch (err) {
                if (!(err instanceof TelegramError) || err.code === 429 || err.code === 0 || err.code >= 500) throw err;
                console.warn(`[tg notify] обращение ${row.thread_id}: удаление оповещений: ${errText(err)} — очищаю по одному`);
            }
            if (!bulkOk) for (const m of chunk) await deleteOrScrub(chatId, m.message_id, row.thread_id);
            const del = db.prepare('DELETE FROM tg_notify_messages WHERE rowid = ?');
            for (const m of chunk) del.run(m.rowid);
        }
    }
}

async function deleteOrScrub(chatId, messageId, threadId) {
    try {
        await tg('deleteMessage', { chat_id: chatId, message_id: messageId });
        return;
    } catch (err) {
        if (!(err instanceof TelegramError) || err.code === 429 || err.code === 0 || err.code >= 500) throw err;
    }
    try {
        // Без reply_markup — кнопка со ссылкой тоже убирается
        await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: PURGED_TEXT(threadId) });
    } catch (err) {
        if (!(err instanceof TelegramError) || err.code === 429 || err.code === 0 || err.code >= 500) throw err;
        // Сообщения уже нет или оно уже очищено
        if (!isNotModified(err)) console.warn(`[tg notify] сообщение ${messageId}: ${errText(err)}`);
    }
}

// ---------- Очередь ----------

let running = false;
let again = false;
let pausedUntil = 0;

function kick() {
    if (running) {
        again = true;
        return;
    }
    running = true;
    runQueue()
        .catch((err) => console.error('[tg notify] очередь:', err))
        .finally(() => {
            running = false;
            if (again) {
                again = false;
                kick();
            }
        });
}

async function runQueue() {
    // Ждём, пока бот запустится (getMe) и будет указана группа
    if (!supportBotUsername() || Date.now() < pausedUntil) return;
    const rows = db.prepare("SELECT * FROM tg_outbox WHERE status = 'pending' ORDER BY id LIMIT 100").all();
    // Если событие ждёт повтора, следующие события того же обращения тоже ждут — чтобы не нарушить порядок
    const waiting = new Set();
    for (const r of rows) {
        if (waiting.has(r.thread_id)) continue;
        if (r.next_attempt_at > Date.now()) {
            waiting.add(r.thread_id);
            continue;
        }
        // Строку могли удалить (удаление аккаунта), пока обрабатывались предыдущие
        if (!db.prepare("SELECT 1 FROM tg_outbox WHERE id = ? AND status = 'pending'").get(r.id)) continue;
        try {
            if (r.kind === 'purge') await purgeThread(r);
            else await sendEvent(r);
            db.prepare("UPDATE tg_outbox SET status = 'done', last_error = NULL WHERE id = ?").run(r.id);
        } catch (err) {
            if (err instanceof TelegramError && err.code === 429) {
                // Лимит Telegram: ждём сколько сказано, попытку не засчитываем
                pausedUntil = Date.now() + ((err.retryAfter ?? 5) + 1) * 1000;
                db.prepare('UPDATE tg_outbox SET next_attempt_at = ?, last_error = ? WHERE id = ?').run(pausedUntil, errText(err).slice(0, 500), r.id);
                return;
            }
            const attempts = r.attempts + 1;
            const delay = RETRY_DELAYS_SEC[attempts - 1];
            if (delay === undefined) {
                db.prepare("UPDATE tg_outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempts, errText(err).slice(0, 500), r.id);
                console.error(`[tg notify] обращение ${r.thread_id}: ${r.kind === 'purge' ? 'удаление оповещений' : 'оповещение'} не выполнено после ${attempts} попыток: ${errText(err)}`);
            } else {
                db.prepare('UPDATE tg_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?').run(
                    attempts, Date.now() + delay * 1000, errText(err).slice(0, 500), r.id,
                );
                console.warn(`[tg notify] обращение ${r.thread_id}: ${errText(err)} — повтор через ${delay} с`);
                waiting.add(r.thread_id);
            }
        }
    }
}

function cleanup() {
    // В выполненных событиях — email и фрагменты писем: долго не храним
    db.prepare("DELETE FROM tg_outbox WHERE status IN ('done', 'failed') AND kind = 'event' AND created_at < datetime('now', '-7 days')").run();
    db.prepare("DELETE FROM tg_outbox WHERE status = 'done' AND kind = 'purge' AND created_at < datetime('now', '-7 days')").run();
}

export function startEmailNotify() {
    if (!telegramEnabled()) return;
    onBotReady(kick);
    setInterval(kick, 5_000).unref();
    setInterval(() => {
        try {
            cleanup();
        } catch (err) {
            console.error('[tg notify] очистка:', err.message);
        }
    }, 24 * 60 * 60_000).unref();
}
