// Служебные алерты для сотрудников: зависшие заказы, отклонённые оплаты, недоступность панели или Platega.
// Отправляются в тему «Алерты» группы поддержки Telegram (тема создаётся ботом), всегда пишутся в лог.
// Повтор одного и того же алерта (dedup_key) подавляется на repeatAfterMs.
import { config } from './config.js';
import { db } from './db.js';
import { getSettings } from './settings.js';
import { tg, telegramEnabled, TelegramError } from './telegram.js';
import { errText, esc, groupId, isNotModified, isTopicClosed, isTopicGone, onBotReady, supportBotUsername } from './tgsupport.js';

const TOPIC_NAME = 'Алерты';
const TOPIC_KEY = 'tgAlertTopic';
// Повторы отправки: 10 с, 30 с, 1 мин, 5 мин, 15 мин, 30 мин, 1 ч (~2 ч суммарно)
const RETRY_DELAYS_SEC = [10, 30, 60, 300, 900, 1800, 3600];
const DAY_MS = 24 * 60 * 60_000;

// Бот запущен, группа указана, алерты включены в админке (Настройки)
const telegramReady = () => telegramEnabled() && Boolean(groupId()) && getSettings().telegramAlerts;

export const adminUserUrl = (userId) => (config.admin.path ? `${config.siteUrl}${config.admin.path}/#/users/${userId}` : null);

// title и lines — обычный текст (экранируется здесь). link — адрес страницы админки.
// Возвращает false, если такой алерт уже был в пределах repeatAfterMs.
export function alert({ key = null, title, lines = [], link = null, repeatAfterMs = DAY_MS }) {
    const now = Date.now();
    if (key && db.prepare('SELECT 1 FROM alerts WHERE dedup_key = ? AND created_at > ?').get(key, now - repeatAfterMs)) return false;
    console.error(`[alert] ${title}${lines.length ? `: ${lines.join('; ')}` : ''}`);
    const text = [`🚨 <b>${esc(title)}</b>`, ...lines.map(esc)].join('\n');
    try {
        db.prepare('INSERT INTO alerts (dedup_key, text, link, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
            key, text, link, telegramReady() ? 'pending' : 'skipped', now,
        );
    } catch (err) {
        // Алерт не должен ломать операцию, которая его вызвала
        console.error('[alert] не удалось поставить в очередь:', err.message);
        return false;
    }
    kick();
    return true;
}

// ---------- Тема «Алерты» ----------

function topicId() {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(TOPIC_KEY);
    const v = row ? JSON.parse(row.value) : null;
    return v && String(v.chatId) === groupId() ? v.topicId : null;
}

function setTopicId(id) {
    if (!id) return db.prepare('DELETE FROM settings WHERE key = ?').run(TOPIC_KEY);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        TOPIC_KEY,
        JSON.stringify({ chatId: groupId(), topicId: id }),
    );
}

export const alertTopicId = topicId;

async function ensureTopic() {
    const existing = topicId();
    if (existing) return existing;
    const topic = await tg('createForumTopic', { chat_id: groupId(), name: TOPIC_NAME });
    setTopicId(topic.message_thread_id);
    console.log(`[alert] создана тема «${TOPIC_NAME}» (#${topic.message_thread_id})`);
    return topic.message_thread_id;
}

function messageParams(row, topic) {
    const params = {
        chat_id: groupId(),
        message_thread_id: topic,
        text: row.text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
    };
    // Telegram принимает в кнопках только публичные адреса — для http (демо, локальный запуск) ссылка идёт в тексте
    if (row.link && config.isHttps) params.reply_markup = { inline_keyboard: [[{ text: 'Открыть в админке', url: row.link }]] };
    else if (row.link) params.text += `\n\n<a href="${esc(row.link)}">Открыть в админке</a>`;
    return params;
}

async function send(row) {
    let topic = await ensureTopic();
    try {
        await tg('sendMessage', messageParams(row, topic));
    } catch (err) {
        if (isTopicGone(err)) {
            setTopicId(null);
            topic = await ensureTopic();
        } else if (isTopicClosed(err)) {
            await tg('reopenForumTopic', { chat_id: groupId(), message_thread_id: topic }).catch((e) => {
                if (!isNotModified(e)) throw e;
            });
        } else {
            throw err;
        }
        await tg('sendMessage', messageParams(row, topic));
    }
}

// ---------- Очередь ----------

let running = null;
let again = false;
let pausedUntil = 0;

function kick() {
    if (running) {
        again = true;
        return running;
    }
    running = runQueue()
        .catch((err) => console.error('[alert] очередь:', err))
        .finally(() => {
            running = null;
            if (again) {
                again = false;
                kick();
            }
        });
    return running;
}

// Отправляет накопившиеся алерты; для тестов — дождаться отправки
export async function processAlerts() {
    await kick();
    while (running) await running;
}

async function runQueue() {
    // Ждём, пока бот запустится (getMe) и будет указана группа
    if (!supportBotUsername() || Date.now() < pausedUntil) return;
    const rows = db.prepare("SELECT * FROM alerts WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT 50").all(Date.now());
    for (const r of rows) {
        try {
            await send(r);
            db.prepare("UPDATE alerts SET status = 'done', last_error = NULL WHERE id = ?").run(r.id);
        } catch (err) {
            if (err instanceof TelegramError && err.code === 429) {
                pausedUntil = Date.now() + ((err.retryAfter ?? 5) + 1) * 1000;
                return;
            }
            const attempts = r.attempts + 1;
            const delay = RETRY_DELAYS_SEC[attempts - 1];
            if (delay === undefined) {
                db.prepare("UPDATE alerts SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempts, errText(err).slice(0, 500), r.id);
                console.error(`[alert] ${r.id} не отправлен после ${attempts} попыток: ${errText(err)}`);
            } else {
                db.prepare('UPDATE alerts SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?').run(
                    attempts, Date.now() + delay * 1000, errText(err).slice(0, 500), r.id,
                );
                console.warn(`[alert] ${r.id}: ${errText(err)} — повтор через ${delay} с`);
            }
        }
    }
}

export function startAlerts() {
    const cleanup = () => db.prepare('DELETE FROM alerts WHERE status != ? AND created_at < ?').run('pending', Date.now() - 30 * DAY_MS);
    setInterval(() => {
        try {
            cleanup();
        } catch (err) {
            console.error('[alert] очистка:', err.message);
        }
    }, DAY_MS).unref();
    if (!telegramEnabled()) return;
    onBotReady(kick);
    setInterval(kick, 10_000).unref();
}
