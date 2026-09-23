// Поддержка в Telegram: на каждого клиента бота — своя тема в закрытой группе.
// Сообщения клиента копируются в его тему, сообщения сотрудников из темы — клиенту.
// Обновления от Telegram сначала ставятся в очередь (tg_updates), затем обрабатываются по порядку.
import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { getSettings } from './settings.js';
import { tg, telegramEnabled, telegramWebhookSecret, TelegramError } from './telegram.js';

// Повторы обработки обновления: 10 с, 30 с, 1 мин, 5 мин, 15 мин, 30 мин, 1 ч (~2 ч суммарно)
const RETRY_DELAYS_SEC = [10, 30, 60, 300, 900, 1800, 3600];
const LINK_TTL_MS = 30 * 60_000;
// Не больше 20 сообщений клиента в минуту: в группу бот может писать ~20 сообщений в минуту
const CLIENT_LIMIT = 20;
const CLIENT_WINDOW_MS = 60_000;
const INTERNAL_PREFIX = '//';
const COMMANDS_HINT =
    'Команды в теме: /info — карточка клиента, /ban и /unban — перестать или снова начать пересылать сообщения клиента. ' +
    `Сообщения, начинающиеся с ${INTERNAL_PREFIX}, клиенту не отправляются.`;
// Служебные сообщения группы — их не копируем
const SERVICE_FIELDS = [
    'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo', 'delete_chat_photo', 'pinned_message',
    'forum_topic_created', 'forum_topic_edited', 'general_forum_topic_hidden', 'general_forum_topic_unhidden',
    'message_auto_delete_timer_changed', 'video_chat_scheduled', 'video_chat_started', 'video_chat_ended',
    'video_chat_participants_invited', 'boost_added', 'chat_background_set', 'write_access_allowed',
];
const RW_STATUS = { EXPIRED: 'истекла', DISABLED: 'отключена', LIMITED: 'лимит исчерпан' };

let bot = null; // { id, username } из getMe
const readyListeners = new Set();
export const onBotReady = (fn) => readyListeners.add(fn);
// Юзернейм бота, когда он запущен и группа поддержки указана
export const supportBotUsername = () => (bot && groupId() ? bot.username : null);

const groupId = () => config.telegram.supportChatId;
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ');

// ---------- Ошибки Telegram ----------

const errText = (err) => String(err?.message ?? '');
const isTopicGone = (err) => err instanceof TelegramError && /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(errText(err));
const isTopicClosed = (err) => err instanceof TelegramError && /TOPIC_CLOSED/i.test(errText(err));
const isNotModified = (err) => err instanceof TelegramError && /not modified|TOPIC_NOT_MODIFIED/i.test(errText(err));
const isUncopyable = (err) => err instanceof TelegramError && /can't be copied|message to copy not found|MESSAGE_ID_INVALID/i.test(errText(err));
// Ошибка, которая не пройдёт при повторе: клиент остановил бота, сообщение нельзя отправить и т.п.
const isPermanent = (err) => err instanceof TelegramError && (err.code === 400 || err.code === 403);

// ---------- Привязка аккаунта ----------

// Ссылка для кнопки в кабинете; null, если бот не настроен
export function createLinkUrl(userId) {
    const username = supportBotUsername();
    if (!username) return null;
    const token = crypto.randomBytes(18).toString('base64url');
    db.prepare('DELETE FROM tg_link_tokens WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO tg_link_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + LINK_TTL_MS);
    return `https://t.me/${username}?start=${token}`;
}

function consumeLinkToken(token) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const row = db.prepare('DELETE FROM tg_link_tokens WHERE token_hash = ? RETURNING user_id, expires_at').get(sha256(token));
    return row && row.expires_at >= Date.now() ? row.user_id : null;
}

// Для карточки пользователя в админке
export const userTelegram = (userId) =>
    db
        .prepare('SELECT tg_user_id, first_name, last_name, username, topic_id FROM tg_clients WHERE user_id = ? ORDER BY last_message_at DESC')
        .all(userId)
        .map((c) => ({ tgUserId: c.tg_user_id, name: fullName(c), username: c.username, hasTopic: Boolean(c.topic_id) }));

// После удаления аккаунта на сайте: привязка уже снята в БД, убираем email из названия темы
export async function onAccountUnlinked(tgUserIds) {
    if (!supportBotUsername()) return;
    for (const id of tgUserIds) {
        const client = getClient(id);
        if (!client?.topic_id) continue;
        try {
            await renameTopic(client);
            await postToTopic(client, 'Аккаунт на сайте удалён, привязка к нему снята.');
        } catch (err) {
            console.warn(`[telegram] тема клиента ${id}: ${err.message}`);
        }
    }
}

// ---------- Клиенты и темы ----------

const getClient = (tgUserId) => db.prepare('SELECT * FROM tg_clients WHERE tg_user_id = ?').get(tgUserId);

function upsertClient(from) {
    db.prepare(
        `INSERT INTO tg_clients (tg_user_id, first_name, last_name, username) VALUES (?, ?, ?, ?)
         ON CONFLICT(tg_user_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username`,
    ).run(from.id, from.first_name ?? null, from.last_name ?? null, from.username ?? null);
    return getClient(from.id);
}

const linkedUser = (client) =>
    client.user_id ? db.prepare('SELECT id, email, plan_kind, expire_at, rw_status, blocked FROM users WHERE id = ?').get(client.user_id) : null;

function topicName(client) {
    const user = linkedUser(client);
    let name = fullName(client) || `id ${client.tg_user_id}`;
    if (client.username) name += ` @${client.username}`;
    if (user) name += ` · ${user.email}`;
    return name.slice(0, 128);
}

function cardText(client) {
    const user = linkedUser(client);
    const lines = [`👤 <b>${esc(fullName(client) || 'Без имени')}</b>${client.username ? ` @${esc(client.username)}` : ''}`, `Telegram ID: <code>${client.tg_user_id}</code>`];
    if (user) {
        lines.push(`Аккаунт: ${esc(user.email)}`);
        if (user.expire_at) {
            const kind = user.plan_kind === 'trial' ? 'пробный период' : 'подписка';
            const until = new Date(user.expire_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
            const expired = new Date(user.expire_at) <= new Date();
            const status = RW_STATUS[user.rw_status] ?? (expired ? 'истекла' : null);
            lines.push(`Подписка: ${kind} до ${until}${status ? ` (${status})` : ''}`);
        } else {
            lines.push('Подписка: нет');
        }
        if (user.blocked) lines.push('⚠️ Пользователь отключён администратором');
        if (config.admin.path) lines.push(`<a href="${esc(`${config.siteUrl}${config.admin.path}/#/users/${user.id}`)}">Карточка в админке</a>`);
    } else {
        lines.push('Аккаунт на сайте не привязан. Клиент может привязать его кнопкой «Написать в Telegram» в личном кабинете.');
    }
    if (client.banned) lines.push('⛔ Сообщения клиента не пересылаются (/unban — вернуть)');
    lines.push('', esc(COMMANDS_HINT));
    return lines.join('\n');
}

const postToTopic = (client, text, extra = {}) =>
    tg('sendMessage', {
        chat_id: groupId(),
        message_thread_id: client.topic_id,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...extra,
    });

const postCard = (client) => postToTopic(client, cardText(client));

async function renameTopic(client) {
    try {
        await tg('editForumTopic', { chat_id: groupId(), message_thread_id: client.topic_id, name: topicName(client) });
    } catch (err) {
        if (!isNotModified(err)) throw err;
    }
}

async function createTopic(client) {
    const topic = await tg('createForumTopic', { chat_id: groupId(), name: topicName(client) });
    db.prepare('UPDATE tg_clients SET topic_id = ?, topic_closed = 0 WHERE tg_user_id = ?').run(topic.message_thread_id, client.tg_user_id);
    const updated = getClient(client.tg_user_id);
    await postCard(updated).catch((err) => console.warn(`[telegram] карточка клиента ${client.tg_user_id}: ${err.message}`));
    return updated;
}

async function reopenTopic(client) {
    try {
        await tg('reopenForumTopic', { chat_id: groupId(), message_thread_id: client.topic_id });
    } catch (err) {
        if (!isNotModified(err)) throw err;
    }
    db.prepare('UPDATE tg_clients SET topic_closed = 0 WHERE tg_user_id = ?').run(client.tg_user_id);
}

// Тема клиента, готовая к записи. opened — тема создана или открыта заново (началось новое обращение).
async function ensureTopic(client) {
    if (!client.topic_id) return { client: await createTopic(client), opened: true };
    if (!client.topic_closed) return { client, opened: false };
    try {
        await reopenTopic(client);
        return { client: getClient(client.tg_user_id), opened: true };
    } catch (err) {
        if (!isTopicGone(err)) throw err;
        return { client: await createTopic(client), opened: true };
    }
}

// ---------- Личка клиента ----------

const clientHits = new Map();
// true — сообщение можно пересылать; 'notify' — лимит только что превышен, клиента стоит предупредить
function clientRate(tgUserId) {
    const now = Date.now();
    const entry = clientHits.get(tgUserId) ?? { hits: [], notified: 0 };
    entry.hits = entry.hits.filter((t) => now - t < CLIENT_WINDOW_MS);
    entry.hits.push(now);
    clientHits.set(tgUserId, entry);
    if (entry.hits.length <= CLIENT_LIMIT) return true;
    if (now - entry.notified < CLIENT_WINDOW_MS) return false;
    entry.notified = now;
    return 'notify';
}

// Отправка клиенту: постоянные ошибки (клиент остановил бота) не повторяем
async function sendToClient(chatId, text) {
    try {
        await tg('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
    } catch (err) {
        if (!isPermanent(err)) throw err;
        console.warn(`[telegram] сообщение клиенту ${chatId} не отправлено: ${err.message}`);
    }
}

async function handlePrivate(msg) {
    const from = msg.from;
    if (!from || from.is_bot) return;
    const client = upsertClient(from);

    const start = String(msg.text ?? '').match(/^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/);
    if (start) return onStart(client, start[1]);
    if (client.banned) return;

    const rate = clientRate(from.id);
    if (rate !== true) {
        if (rate === 'notify') await sendToClient(from.id, 'Слишком много сообщений подряд. Подождите минуту и отправьте остальное.');
        return;
    }
    await forwardToTopic(client, msg);
}

async function onStart(client, payload) {
    const brand = getSettings().brandName;
    if (payload) {
        const userId = consumeLinkToken(payload);
        const user = userId ? db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId) : null;
        if (user) {
            db.prepare('UPDATE tg_clients SET user_id = ? WHERE tg_user_id = ?').run(user.id, client.tg_user_id);
            const linked = getClient(client.tg_user_id);
            await sendToClient(client.tg_user_id, `Здравствуйте! Это поддержка ${brand}. Аккаунт ${user.email} привязан — напишите ваш вопрос, ответим здесь же.`);
            if (linked.topic_id) {
                try {
                    await renameTopic(linked);
                    await postToTopic(linked, `Клиент привязал аккаунт ${esc(user.email)}.`);
                    await postCard(linked);
                } catch (err) {
                    console.warn(`[telegram] тема клиента ${client.tg_user_id}: ${err.message}`);
                }
            }
            return;
        }
        if (!client.user_id) {
            await sendToClient(
                client.tg_user_id,
                `Здравствуйте! Это поддержка ${brand}. Ссылка из личного кабинета устарела — откройте её заново или просто напишите вопрос здесь, указав email, на который оформлена подписка.`,
            );
            return;
        }
    }
    const hint = client.user_id ? '' : ' Если вопрос о подписке — укажите email, на который она оформлена.';
    await sendToClient(client.tg_user_id, `Здравствуйте! Это поддержка ${brand}. Напишите вопрос одним или несколькими сообщениями, можно со скриншотами — ответим здесь же.${hint}`);
}

async function copyToTopic(client, msg) {
    const reply = msg.reply_to_message
        ? db.prepare('SELECT group_msg_id FROM tg_messages WHERE tg_user_id = ? AND user_msg_id = ?').get(client.tg_user_id, msg.reply_to_message.message_id)
        : null;
    return tg('copyMessage', {
        chat_id: groupId(),
        from_chat_id: msg.chat.id,
        message_id: msg.message_id,
        message_thread_id: client.topic_id,
        ...(reply ? { reply_parameters: { message_id: reply.group_msg_id, allow_sending_without_reply: true } } : {}),
    });
}

async function forwardToTopic(initial, msg) {
    let { client, opened } = await ensureTopic(initial);
    let copied = null;
    try {
        copied = await copyToTopic(client, msg);
    } catch (err) {
        if (isTopicGone(err)) {
            // Тему удалили вручную — заводим новую
            db.prepare('UPDATE tg_clients SET topic_id = NULL WHERE tg_user_id = ?').run(client.tg_user_id);
            client = await createTopic(getClient(client.tg_user_id));
            opened = true;
            copied = await copyToTopic(client, msg);
        } else if (isTopicClosed(err)) {
            await reopenTopic(client);
            opened = true;
            copied = await copyToTopic(client, msg);
        } else if (isUncopyable(err)) {
            await postToTopic(client, 'Клиент отправил сообщение, которое бот не может скопировать (например, опрос). Попросите прислать его текстом или скриншотом.');
        } else {
            throw err;
        }
    }

    // Сообщение уже в группе: дальше ошибки только логируем, чтобы повтор не создал копию
    try {
        if (copied) {
            db.prepare('INSERT INTO tg_messages (tg_user_id, user_msg_id, group_msg_id) VALUES (?, ?, ?)').run(client.tg_user_id, msg.message_id, copied.message_id);
        }
        db.prepare("UPDATE tg_clients SET last_message_at = datetime('now') WHERE tg_user_id = ?").run(client.tg_user_id);
        if (opened && config.telegram.autoReply) await sendToClient(client.tg_user_id, config.telegram.autoReply);
    } catch (err) {
        console.warn(`[telegram] после пересылки от ${client.tg_user_id}: ${err.message}`);
    }
}

// ---------- Группа поддержки ----------

async function handleGroup(msg) {
    const threadId = msg.is_topic_message ? msg.message_thread_id : null;
    if (!threadId) return; // раздел «General» и сообщения вне тем
    const client = db.prepare('SELECT * FROM tg_clients WHERE topic_id = ?').get(threadId);

    if (msg.forum_topic_closed || msg.forum_topic_reopened) {
        if (client) db.prepare('UPDATE tg_clients SET topic_closed = ? WHERE tg_user_id = ?').run(msg.forum_topic_closed ? 1 : 0, client.tg_user_id);
        return;
    }
    if (SERVICE_FIELDS.some((f) => f in msg)) return;
    // Сотрудник: обычный участник или администратор, пишущий от имени группы
    const fromStaff = msg.sender_chat ? String(msg.sender_chat.id) === groupId() : Boolean(msg.from && !msg.from.is_bot);
    if (!fromStaff) return;

    const text = msg.text ?? msg.caption ?? '';
    if (text.startsWith(INTERNAL_PREFIX)) return;
    const cmd = String(msg.text ?? '').match(/^\/(\w+)(?:@(\w+))?/);
    if (cmd && cmd[2] && cmd[2].toLowerCase() !== bot.username.toLowerCase()) return; // команда другому боту
    if (!client) {
        if (cmd) await tg('sendMessage', { chat_id: groupId(), message_thread_id: threadId, text: 'Эта тема не связана с клиентом бота.' });
        return;
    }
    if (cmd) return handleCommand(client, cmd[1].toLowerCase());

    const reply =
        msg.reply_to_message && !msg.reply_to_message.forum_topic_created
            ? db.prepare('SELECT user_msg_id FROM tg_messages WHERE tg_user_id = ? AND group_msg_id = ?').get(client.tg_user_id, msg.reply_to_message.message_id)
            : null;
    let copied;
    try {
        copied = await tg('copyMessage', {
            chat_id: client.tg_user_id,
            from_chat_id: groupId(),
            message_id: msg.message_id,
            ...(reply ? { reply_parameters: { message_id: reply.user_msg_id, allow_sending_without_reply: true } } : {}),
        });
    } catch (err) {
        if (!isPermanent(err)) throw err;
        const reason = err.code === 403 ? 'клиент остановил бота или удалил аккаунт Telegram' : err.message;
        await tg('sendMessage', {
            chat_id: groupId(),
            message_thread_id: threadId,
            text: `⚠️ Не доставлено: ${reason}`,
            reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
        });
        return;
    }
    db.prepare('INSERT INTO tg_messages (tg_user_id, user_msg_id, group_msg_id) VALUES (?, ?, ?)').run(client.tg_user_id, copied.message_id, msg.message_id);
    // Отметка «доставлено»; если реакции в группе выключены — не страшно
    await tg('setMessageReaction', { chat_id: groupId(), message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '👌' }] }).catch(() => {});
}

async function handleCommand(client, name) {
    if (name === 'info') return postCard(client);
    if (name === 'ban' || name === 'unban') {
        db.prepare('UPDATE tg_clients SET banned = ? WHERE tg_user_id = ?').run(name === 'ban' ? 1 : 0, client.tg_user_id);
        return postToTopic(
            client,
            name === 'ban' ? 'Сообщения клиента больше не пересылаются в группу. /unban — вернуть.' : 'Сообщения клиента снова пересылаются в группу.',
        );
    }
    return postToTopic(client, `Неизвестная команда. ${esc(COMMANDS_HINT)}`);
}

// Сообщение из чужой группы или из группы, пока TELEGRAM_SUPPORT_CHAT_ID не задан
const warnedChats = new Set();
async function handleOtherChat(msg) {
    if (msg.chat.type === 'channel') return;
    if (!groupId()) {
        if (/^\/chat_id(@\w+)?\s*$/.test(String(msg.text ?? ''))) {
            const forumNote = msg.chat.is_forum
                ? ''
                : '\n\nВ группе не включены темы — включите их в настройках группы. После этого ID группы изменится: напишите /chat_id ещё раз и укажите новый ID.';
            await tg('sendMessage', {
                chat_id: msg.chat.id,
                text: `ID группы: <code>${msg.chat.id}</code>\nУкажите его в TELEGRAM_SUPPORT_CHAT_ID и перезапустите сайт.${forumNote}`,
                parse_mode: 'HTML',
            });
        }
        return;
    }
    // Посторонняя группа: сообщения игнорируем. Из группы не выходим — это может быть группа поддержки,
    // у которой сменился ID (при включении тем Telegram превращает группу в супергруппу с новым ID).
    const chatId = String(msg.chat.id);
    if (String(msg.migrate_from_chat_id ?? '') === groupId()) {
        console.error(`[telegram] группа поддержки получила новый ID ${chatId} — укажите его в TELEGRAM_SUPPORT_CHAT_ID и перезапустите сайт`);
    } else if (!warnedChats.has(chatId)) {
        warnedChats.add(chatId);
        console.warn(`[telegram] сообщение из чата ${chatId} («${msg.chat.title ?? ''}»), а группа поддержки — ${groupId()}; сообщения из этого чата игнорируются`);
    }
}

// Группа поддержки ещё не указана: сообщения клиентов некуда переслать — предлагаем написать на почту (один раз)
const notConfiguredNotified = new Set();
async function handlePrivateNotConfigured(msg) {
    if (!msg.from || msg.from.is_bot || notConfiguredNotified.has(msg.chat.id)) return;
    console.warn(`[telegram] сообщение от ${msg.chat.id} не переслано: TELEGRAM_SUPPORT_CHAT_ID не задан`);
    await sendToClient(msg.chat.id, `Поддержка в Telegram пока не подключена. Напишите нам на ${getSettings().supportEmail} — ответим по почте.`);
    notConfiguredNotified.add(msg.chat.id);
}

async function handleUpdate(update) {
    const msg = update.message;
    if (!msg?.chat) return;
    if (msg.chat.type === 'private') return groupId() ? handlePrivate(msg) : handlePrivateNotConfigured(msg);
    if (groupId() && String(msg.chat.id) === groupId()) {
        if (msg.migrate_to_chat_id) {
            console.error(`[telegram] группа поддержки получила новый ID ${msg.migrate_to_chat_id} — укажите его в TELEGRAM_SUPPORT_CHAT_ID и перезапустите сайт`);
            return;
        }
        return handleGroup(msg);
    }
    return handleOtherChat(msg);
}

// ---------- Очередь обновлений ----------

export function enqueueUpdate(update) {
    const id = Number(update?.update_id);
    if (!Number.isSafeInteger(id)) return;
    const msg = update.message;
    const key = !msg?.chat ? 'other' : msg.chat.type === 'private' ? `u:${msg.chat.id}` : `g:${msg.chat.id}:${msg.message_thread_id ?? 0}`;
    db.prepare('INSERT OR IGNORE INTO tg_updates (update_id, chat_key, payload) VALUES (?, ?, ?)').run(id, key, JSON.stringify(update));
    kick();
}

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
        .catch((err) => console.error('[telegram] очередь:', err))
        .finally(() => {
            running = false;
            if (again) {
                again = false;
                kick();
            }
        });
}

async function runQueue() {
    if (!bot || Date.now() < pausedUntil) return;
    const rows = db
        .prepare("SELECT update_id, chat_key, payload, attempts, next_attempt_at FROM tg_updates WHERE status = 'pending' ORDER BY update_id LIMIT 200")
        .all();
    // Если обновление ждёт повтора, следующие из того же чата тоже ждут — чтобы не нарушить порядок сообщений
    const waiting = new Set();
    for (const r of rows) {
        if (waiting.has(r.chat_key)) continue;
        if (r.next_attempt_at > Date.now()) {
            waiting.add(r.chat_key);
            continue;
        }
        try {
            await handleUpdate(JSON.parse(r.payload));
            db.prepare("UPDATE tg_updates SET status = 'done', last_error = NULL WHERE update_id = ?").run(r.update_id);
        } catch (err) {
            if (err instanceof TelegramError && err.code === 429) {
                // Лимит Telegram: ждём сколько сказано, попытку не засчитываем
                const waitMs = ((err.retryAfter ?? 5) + 1) * 1000;
                pausedUntil = Date.now() + waitMs;
                db.prepare('UPDATE tg_updates SET next_attempt_at = ?, last_error = ? WHERE update_id = ?').run(pausedUntil, errText(err).slice(0, 500), r.update_id);
                return;
            }
            const attempts = r.attempts + 1;
            const delay = RETRY_DELAYS_SEC[attempts - 1];
            if (delay === undefined) {
                db.prepare("UPDATE tg_updates SET status = 'failed', attempts = ?, last_error = ? WHERE update_id = ?").run(attempts, errText(err).slice(0, 500), r.update_id);
                console.error(`[telegram] обновление ${r.update_id} не обработано после ${attempts} попыток: ${errText(err)}`);
            } else {
                db.prepare('UPDATE tg_updates SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE update_id = ?').run(
                    attempts, Date.now() + delay * 1000, errText(err).slice(0, 500), r.update_id,
                );
                console.warn(`[telegram] обновление ${r.update_id}: ${errText(err)} — повтор через ${delay} с`);
                waiting.add(r.chat_key);
            }
        }
    }
}

function cleanup() {
    db.prepare("DELETE FROM tg_updates WHERE status IN ('done', 'failed') AND received_at < datetime('now', '-7 days')").run();
    db.prepare("DELETE FROM tg_messages WHERE created_at < datetime('now', '-180 days')").run();
    db.prepare('DELETE FROM tg_link_tokens WHERE expires_at < ?').run(Date.now());
}

// ---------- Запуск ----------

async function setupWebhook() {
    if (!config.isHttps && config.telegram.apiUrl === 'https://api.telegram.org') {
        console.warn('[telegram] вебхук не зарегистрирован: Telegram принимает только https-адрес (SITE_URL)');
        return;
    }
    await tg('setWebhook', {
        url: `${config.siteUrl}/webhooks/telegram`,
        secret_token: telegramWebhookSecret(),
        allowed_updates: ['message'],
        max_connections: 10,
    });
    console.log(`[telegram] вебхук: ${config.siteUrl}/webhooks/telegram`);
}

async function checkGroup() {
    if (!groupId()) {
        console.warn('[telegram] TELEGRAM_SUPPORT_CHAT_ID не задан: добавьте бота в группу с темами администратором и напишите там /chat_id');
        return;
    }
    const chat = await tg('getChat', { chat_id: groupId() });
    if (!chat.is_forum) console.warn('[telegram] в группе поддержки не включены темы — бот не сможет создавать темы для клиентов');
    const member = await tg('getChatMember', { chat_id: groupId(), user_id: bot.id });
    if (member.status !== 'creator' && !(member.status === 'administrator' && member.can_manage_topics)) {
        console.warn('[telegram] бот должен быть администратором группы поддержки с правом «Управление темами»');
    }
}

async function init() {
    for (;;) {
        try {
            bot = await tg('getMe');
            break;
        } catch (err) {
            console.error(`[telegram] getMe: ${err.message} — повтор через минуту`);
            await new Promise((r) => setTimeout(r, 60_000).unref());
        }
    }
    console.log(`[telegram] бот @${bot.username}${groupId() ? `, группа ${groupId()}` : ''}`);
    readyListeners.forEach((fn) => fn());
    await setupWebhook().catch((err) => console.error(`[telegram] setWebhook: ${err.message}`));
    await checkGroup().catch((err) => console.warn(`[telegram] проверка группы: ${err.message}`));
    kick();
}

export function startTelegramSupport() {
    if (!telegramEnabled()) return;
    init();
    setInterval(kick, 5_000).unref();
    setInterval(() => {
        try {
            cleanup();
        } catch (err) {
            console.error('[telegram] очистка:', err.message);
        }
    }, 24 * 60 * 60_000).unref();
}
