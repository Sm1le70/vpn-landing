// Бизнес-логика: выдача и продление подписок, пробный период, проверка HWID.
import crypto from 'node:crypto';
import { config } from './config.js';
import { getSettings } from './settings.js';
import { db } from './db.js';
import { remnawave, RemnawaveError, onUserResponse } from './remnawave.js';
import { getTransaction } from './platega.js';
import { sendSubscriptionReady } from './mailer.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

// Сколько часов неоплаченный заказ можно оплатить из кабинета; после этого фоновая задача его закрывает.
export const ORDER_PAY_HOURS = 24;

// Все операции над одним пользователем выполняются последовательно,
// чтобы вебхук, фоновая проверка и запрос из кабинета не продлили подписку дважды.
const userLocks = new Map();
export function withUserLock(userId, fn) {
    const prev = userLocks.get(userId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    userLocks.set(userId, tail);
    tail.then(() => userLocks.get(userId) === tail && userLocks.delete(userId));
    return next;
}

export class UserFacingError extends Error {}

// Кэш срока и статуса подписки в нашей БД (для списков и статистики админки).
onUserResponse((rwUser) => {
    db.prepare('UPDATE users SET expire_at = ?, rw_status = ? WHERE rw_user_id = ?').run(
        new Date(rwUser.expireAt).toISOString(),
        rwUser.status,
        rwUser.id,
    );
});

export const getUserRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const getOrderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

export function findOrCreateUser(email) {
    db.prepare('INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING').run(email);
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function baseUserFields() {
    const fields = {
        trafficLimitBytes: 0,
        trafficLimitStrategy: 'NO_RESET',
        activeInternalSquads: config.remnawave.squads,
    };
    if (config.remnawave.userTag) fields.tag = config.remnawave.userTag;
    return fields;
}

// Лимит устройств платной подписки с учётом текущего: индивидуальный лимит, выданный администратором,
// не уменьшается, «без лимита» (0) сохраняется. Лимит меньше стандартного (например, пробный) поднимается.
export function paidDeviceLimitFor(currentLimit) {
    const standard = getSettings().paidDeviceLimit;
    if (standard === 0 || currentLimit === 0) return 0;
    return Math.max(Number(currentLimit) || 0, standard);
}

export async function createRemnaUser(user, { expireAt, deviceLimit, note }) {
    const rwUser = await remnawave.createUser({
        ...baseUserFields(),
        username: `web${user.id}_${crypto.randomBytes(3).toString('hex')}`,
        email: user.email,
        expireAt: expireAt.toISOString(),
        hwidDeviceLimit: deviceLimit,
        description: `site: ${user.email} (${note})`,
    });
    db.prepare('UPDATE users SET rw_user_id = ?, rw_username = ?, expire_at = ?, rw_status = ? WHERE id = ?').run(
        rwUser.id,
        rwUser.username,
        new Date(rwUser.expireAt).toISOString(),
        rwUser.status,
        user.id,
    );
    return rwUser;
}

export async function fetchRemnaUser(user) {
    if (!user.rw_user_id) return null;
    try {
        return await remnawave.getUser(user.rw_user_id);
    } catch (err) {
        if (err instanceof RemnawaveError && err.status === 404) {
            db.prepare("UPDATE users SET rw_status = 'DELETED' WHERE id = ?").run(user.id);
            return null;
        }
        throw err;
    }
}

async function notify(email, rwUser, isTrial) {
    try {
        await sendSubscriptionReady(email, { subscriptionUrl: rwUser.subscriptionUrl, expireAt: rwUser.expireAt, isTrial });
    } catch (err) {
        console.error('[mail] не удалось отправить письмо о подписке:', err.message);
    }
}

// ---------- Заказы ----------

// Почему подтверждённая транзакция Platega не подходит к заказу; null — подходит.
// Транзакция должна быть этого заказа: её ID сохранён в заказе, а если ещё не сохранён
// (callback пришёл раньше ответа на создание платежа) — payload равен номеру заказа.
function transactionMismatch(order, transaction) {
    const own = order.platega_tx_id ? transaction?.id === order.platega_tx_id : transaction?.payload === order.id;
    if (!own) return `транзакция ${transaction?.id ?? '?'} не относится к заказу`;
    const amount = transaction.paymentDetails?.amount;
    if (amount == null || !Number.isFinite(Number(amount))) return 'в транзакции нет суммы оплаты';
    const currency = transaction.paymentDetails.currency;
    if (currency && currency !== 'RUB') return `валюта ${currency} вместо RUB`;
    if (Number(amount) + 0.01 < order.amount) return `сумма оплаты ${Number(amount)} меньше суммы заказа ${order.amount}`;
    return null;
}

// Отмечает заказ оплаченным после проверки транзакции в Platega. Возвращает true, если статус изменён.
export function markOrderPaid(order, transaction) {
    const mismatch = transactionMismatch(order, transaction);
    if (mismatch) {
        console.error(`[order ${order.id}] оплата не принята: ${mismatch}`);
        db.prepare('UPDATE orders SET error = ? WHERE id = ?').run(`оплата не принята: ${mismatch}`, order.id);
        return false;
    }
    const res = db
        .prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status IN ('pending', 'canceled')")
        .run(order.id);
    return res.changes > 0;
}

export function applyPaidOrder(orderId) {
    const initial = getOrderRow(orderId);
    if (!initial) return Promise.resolve();
    return withUserLock(initial.user_id, async () => {
        const order = getOrderRow(orderId);
        if (order?.status !== 'paid') return;
        const user = getUserRow(order.user_id);
        try {
            let rwUser = await fetchRemnaUser(user);
            if (!rwUser) {
                rwUser = await createRemnaUser(user, {
                    expireAt: addDays(new Date(), order.days),
                    deviceLimit: getSettings().paidDeviceLimit,
                    note: 'paid',
                });
            } else {
                const current = new Date(rwUser.expireAt);
                const target = order.target_expire_at ? new Date(order.target_expire_at) : null;
                // Прошлая попытка уже продлила подписку, но ответ панели не дошёл (таймаут) — второй раз не продлеваем
                const alreadyApplied = target && Math.abs(current - target) < 60_000;
                if (!alreadyApplied) {
                    // Срок считаем сами: от текущей даты окончания, а если она прошла — от сегодня.
                    const base = current > new Date() ? current : new Date();
                    const expireAt = addDays(base, order.days).toISOString();
                    // Запоминаем ожидаемый срок до запроса: по нему повтор узнает, что продление уже прошло
                    db.prepare('UPDATE orders SET target_expire_at = ? WHERE id = ?').run(expireAt, order.id);
                    rwUser = await remnawave.updateUser({
                        id: rwUser.id,
                        status: 'ACTIVE',
                        expireAt,
                        hwidDeviceLimit: paidDeviceLimitFor(rwUser.hwidDeviceLimit),
                    });
                }
            }
            db.prepare("UPDATE users SET plan_kind = 'paid' WHERE id = ?").run(user.id);
            db.prepare("UPDATE orders SET status = 'applied', applied_at = datetime('now'), error = NULL WHERE id = ? AND status = 'paid'").run(order.id);
            console.log(`[order ${order.id}] подписка ${rwUser.username} продлена до ${rwUser.expireAt}`);
            await notify(user.email, rwUser, false);
        } catch (err) {
            console.error(`[order ${order.id}] ошибка выдачи подписки:`, err.message);
            db.prepare('UPDATE orders SET error = ? WHERE id = ?').run(String(err.message).slice(0, 500), order.id);
        }
    });
}

// Сверка с Platega для заказов, по которым мог не дойти callback.
export async function syncOrderWithPlatega(order) {
    if (!order.platega_tx_id || order.status !== 'pending') return order;
    const transaction = await getTransaction(order.platega_tx_id);
    if (transaction.status === 'CONFIRMED') {
        if (markOrderPaid(order, transaction)) await applyPaidOrder(order.id);
    } else if (transaction.status === 'CANCELED') {
        db.prepare("UPDATE orders SET status = 'canceled' WHERE id = ? AND status = 'pending'").run(order.id);
    }
    return getOrderRow(order.id);
}

// ---------- Пробный период ----------

export function trialAvailable(user) {
    return getSettings().trialEnabled && !user.trial_used_at && user.plan_kind === 'none' && !user.rw_user_id;
}

export function startTrial(userId) {
    return withUserLock(userId, async () => {
        const user = getUserRow(userId);
        if (!trialAvailable(user)) throw new UserFacingError('Пробный период для этого аккаунта уже недоступен');
        const rwUser = await createRemnaUser(user, {
            expireAt: addDays(new Date(), getSettings().trialDays),
            deviceLimit: getSettings().trialDeviceLimit,
            note: 'trial',
        });
        db.prepare("UPDATE users SET plan_kind = 'trial', trial_used_at = datetime('now') WHERE id = ?").run(user.id);
        await notify(user.email, rwUser, true);
        return rwUser;
    });
}

// Одно устройство — один пробный период. Если HWID уже был на другой пробной подписке, пробная подписка отключается.
async function checkTrialDevice(user, hwid) {
    if (user.plan_kind !== 'trial' || user.trial_blocked || !hwid) return;
    const seen = db.prepare('SELECT user_id FROM trial_hwids WHERE hwid = ?').get(hwid);
    if (!seen) {
        db.prepare('INSERT OR IGNORE INTO trial_hwids (hwid, user_id) VALUES (?, ?)').run(hwid, user.id);
        return;
    }
    if (seen.user_id === user.id) return;
    await remnawave.disableUser(user.rw_user_id);
    db.prepare('UPDATE users SET trial_blocked = 1 WHERE id = ?').run(user.id);
    console.log(`[trial] ${user.email}: устройство уже использовало пробный период (user ${seen.user_id}), подписка отключена`);
}

export async function handleHwidDeviceAdded(rwUserId, hwid) {
    const user = db.prepare('SELECT * FROM users WHERE rw_user_id = ?').get(rwUserId);
    if (!user) return;
    await withUserLock(user.id, async () => checkTrialDevice(getUserRow(user.id), hwid));
}

// Резервная проверка на случай, если вебхуки Remnawave не настроены.
async function pollTrialDevices() {
    if (!getSettings().trialEnabled) return;
    const users = db
        .prepare(
            `SELECT * FROM users WHERE plan_kind = 'trial' AND trial_blocked = 0 AND rw_user_id IS NOT NULL
             AND trial_used_at > datetime('now', ?)`,
        )
        .all(`-${getSettings().trialDays + 1} days`);
    for (const user of users) {
        try {
            const { devices } = await remnawave.getUserDevices(user.rw_user_id);
            for (const d of devices) await handleHwidDeviceAdded(user.rw_user_id, d.hwid);
        } catch (err) {
            console.error(`[trial] проверка устройств ${user.email}:`, err.message);
        }
    }
}

// ---------- Кабинет ----------

export async function getSubscriptionInfo(user) {
    const rwUser = await fetchRemnaUser(user);
    if (!rwUser) return null;
    let devices = null;
    try {
        devices = (await remnawave.getUserDevices(rwUser.id)).total;
    } catch {
        // счётчик устройств не критичен
    }
    return {
        status: rwUser.status,
        expireAt: rwUser.expireAt,
        subscriptionUrl: rwUser.subscriptionUrl,
        deviceLimit: rwUser.hwidDeviceLimit,
        devices,
        isTrial: user.plan_kind === 'trial',
        trialBlocked: Boolean(user.trial_blocked),
    };
}

// Обновление кэша срока/статуса (изменения, сделанные напрямую в панели Remnawave).
async function refreshCachedSubscriptions() {
    const users = db.prepare('SELECT id, rw_user_id FROM users WHERE rw_user_id IS NOT NULL').all();
    for (const u of users) {
        try {
            await remnawave.getUser(u.rw_user_id);
        } catch (err) {
            if (err instanceof RemnawaveError && err.status === 404) {
                db.prepare("UPDATE users SET rw_status = 'DELETED' WHERE id = ?").run(u.id);
            } else {
                console.error('[jobs] обновление кэша подписок:', err.message);
                return;
            }
        }
    }
}

// ---------- Фоновые задачи ----------

export function startBackgroundJobs() {
    const retryPaid = async () => {
        const paid = db.prepare("SELECT id FROM orders WHERE status = 'paid'").all();
        for (const o of paid) await applyPaidOrder(o.id);

        const pending = db
            .prepare(
                `SELECT * FROM orders WHERE status = 'pending' AND platega_tx_id IS NOT NULL
                 AND created_at < datetime('now', '-3 minutes') AND created_at > datetime('now', '-2 hours')
                 ORDER BY created_at DESC LIMIT 20`,
            )
            .all();
        for (const o of pending) {
            try {
                await syncOrderWithPlatega(o);
            } catch (err) {
                console.error(`[order ${o.id}] сверка с Platega:`, err.message);
            }
        }

        // Заказы, не оплаченные за сутки, закрываем. Если оплата всё же придёт позже,
        // callback примет и отменённый заказ (см. markOrderPaid).
        const stale = db
            .prepare(
                `SELECT * FROM orders WHERE status = 'pending'
                 AND created_at <= datetime('now', '-${ORDER_PAY_HOURS} hours') ORDER BY created_at LIMIT 20`,
            )
            .all();
        for (const o of stale) {
            try {
                if ((await syncOrderWithPlatega(o)).status !== 'pending') continue;
            } catch (err) {
                console.error(`[order ${o.id}] сверка с Platega:`, err.message);
                // Сверка не прошла: если транзакции нет в Platega (404) или заказу больше недели — закрываем,
                // иначе повторим позже (недельный предел не даёт таким заказам бесконечно занимать очередь)
                const weekOld = Date.now() - new Date(o.created_at.replace(' ', 'T') + 'Z') > 7 * DAY_MS;
                if (o.platega_tx_id && !/→ 404/.test(err.message) && !weekOld) continue;
            }
            db.prepare("UPDATE orders SET status = 'canceled', error = COALESCE(error, 'не оплачен вовремя') WHERE id = ? AND status = 'pending'").run(o.id);
        }
    };
    const safe = (fn) => () => fn().catch((err) => console.error('[jobs]', err));
    setInterval(safe(retryPaid), 60_000).unref();
    setInterval(safe(pollTrialDevices), 5 * 60_000).unref();
    setInterval(safe(refreshCachedSubscriptions), 30 * 60_000).unref();
    setTimeout(safe(refreshCachedSubscriptions), 30_000).unref();
    setTimeout(safe(retryPaid), 5_000).unref();
}
