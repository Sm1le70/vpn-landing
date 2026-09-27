// Напоминания об окончании подписки и пробного периода: письмо и сообщение в Telegram (если аккаунт привязан).
// Пороги — в настройках (reminderDays, например «3, 1»). Каждое напоминание — один раз на дату окончания;
// если окно пропущено (например, до конца уже меньше суток), отправляется только ближайшее. Ночью не пишем.
import { db } from './db.js';
import { getSettings } from './settings.js';
import { sendExpiryReminder } from './mailer.js';
import { fetchRemnaUser, getUserRow } from './subscriptions.js';
import { messageLinkedClients } from './tgsupport.js';
import { every } from './jobs.js';

const DAY_MS = 24 * 60 * 60_000;
// Тихие часы по Москве (UTC+3): напоминания отправляются с 9:00 до 21:00
const SEND_FROM_HOUR = 9;
const SEND_TO_HOUR = 21;

export const reminderThresholds = () =>
    [...new Set(String(getSettings().reminderDays).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);

const mskHour = (now) => new Date(now + 3 * 60 * 60_000).getUTCHours();

// Ближайший порог, в который попадает оставшийся срок: осталось 2,5 дня при порогах [1, 3] → 3; 0,5 дня → 1
export function dueThreshold(msLeft, thresholds) {
    if (msLeft <= 0) return null;
    return thresholds.find((d) => msLeft <= d * DAY_MS) ?? null;
}

export async function sendExpiryReminders(now = Date.now()) {
    if (!getSettings().remindersEnabled) return 0;
    const hour = mskHour(now);
    if (hour < SEND_FROM_HOUR || hour >= SEND_TO_HOUR) return 0;
    const thresholds = reminderThresholds();
    if (!thresholds.length) return 0;

    // Кандидаты — по кэшу срока в базе; перед отправкой срок перепроверяется в панели
    const horizon = new Date(now + thresholds.at(-1) * DAY_MS).toISOString();
    const candidates = db
        .prepare(
            `SELECT id FROM users WHERE rw_user_id IS NOT NULL AND blocked = 0 AND trial_blocked = 0
             AND rw_status = 'ACTIVE' AND expire_at > ? AND expire_at <= ?`,
        )
        .all(new Date(now).toISOString(), horizon);

    let sent = 0;
    for (const { id } of candidates) {
        try {
            if (await remindUser(getUserRow(id), thresholds, now)) sent += 1;
        } catch (err) {
            console.error(`[reminders] пользователь ${id}:`, err.message);
        }
    }
    return sent;
}

// Пороги не короче самого пробного периода не нужны: при пробном периоде на 3 дня и порогах «3, 1»
// напоминание «через 3 дня» пришло бы сразу после активации
function trialThresholds(user, expireAt, thresholds) {
    const startedAt = user.trial_used_at ? Date.parse(`${user.trial_used_at.replace(' ', 'T')}Z`) : NaN;
    if (Number.isNaN(startedAt)) return thresholds;
    const trialDays = Math.round((new Date(expireAt) - startedAt) / DAY_MS);
    return thresholds.filter((d) => d < trialDays);
}

async function remindUser(user, thresholds, now) {
    const rw = await fetchRemnaUser(user);
    if (!rw || rw.status !== 'ACTIVE') return false;
    const expireAt = new Date(rw.expireAt).toISOString();
    const isTrial = user.plan_kind === 'trial';
    const daysBefore = dueThreshold(new Date(expireAt) - now, isTrial ? trialThresholds(user, expireAt, thresholds) : thresholds);
    if (!daysBefore) return false; // продлили в панели — напоминать рано
    const done = db.prepare('SELECT 1 FROM expiry_reminders WHERE user_id = ? AND expire_at = ? AND days_before <= ?').get(user.id, expireAt, daysBefore);
    if (done) return false;

    await sendExpiryReminder(user.email, { expireAt, isTrial, daysBefore });
    db.prepare('INSERT OR IGNORE INTO expiry_reminders (user_id, expire_at, days_before) VALUES (?, ?, ?)').run(user.id, expireAt, daysBefore);

    const until = new Date(expireAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
    await messageLinkedClients(
        user.id,
        `${isTrial ? 'Пробный период' : 'Подписка'} ${getSettings().brandName} действует до ${until}. ` +
            `${isTrial ? 'Выбрать тариф' : 'Продлить'} можно в личном кабинете — ссылка на подписку останется прежней.`,
    );
    console.log(`[reminders] ${user.email}: напоминание за ${daysBefore} дн. (до ${expireAt})`);
    return true;
}

export function cleanupReminders() {
    db.prepare("DELETE FROM expiry_reminders WHERE expire_at < ?").run(new Date(Date.now() - 30 * DAY_MS).toISOString());
}

export function startReminders() {
    every('expiry-reminders', 60 * 60_000, () => sendExpiryReminders(), { firstDelayMs: 60_000 });
    every('reminders-cleanup', 24 * 60 * 60_000, cleanupReminders);
}
