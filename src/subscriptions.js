// Бизнес-логика: выдача и продление подписок, пробный период, проверка HWID.
import crypto from 'node:crypto';
import { config } from './config.js';
import { getSettings } from './settings.js';
import { db, tx } from './db.js';
import { remnawave, RemnawaveError, onUserResponse } from './remnawave.js';
import { getTransaction } from './platega.js';
import { sendAccountNotice, sendSubscriptionReady } from './mailer.js';
import { isDisposableEmail } from './disposable.js';
import { every } from './jobs.js';
import { adminUserUrl, alert } from './alerts.js';

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

// cached — для кабинета: данные панели не старше 30 с (см. remnawave.getUserCached)
export async function fetchRemnaUser(user, { cached = false } = {}) {
    if (!user.rw_user_id) return null;
    try {
        return await (cached ? remnawave.getUserCached(user.rw_user_id) : remnawave.getUser(user.rw_user_id));
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
        alert({
            key: `order-mismatch:${order.id}`,
            title: 'Оплата не принята',
            lines: [`Пользователь #${order.user_id}, заказ ${order.id}, ${order.amount} ₽`, `Причина: ${mismatch}`, 'Сверьте платёж в кабинете Platega.'],
            link: adminUserUrl(order.user_id),
        });
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

// Сверка по запросу клиента (страница ожидания оплаты опрашивает статус каждые 3 с):
// в Platega — не чаще раза в CLIENT_SYNC_MIN_MS на заказ, в остальное время — статус из базы.
// Callback Platega меняет статус сразу, так что клиент не ждёт дольше.
const CLIENT_SYNC_MIN_MS = 10_000;
const lastClientSync = new Map();

export async function syncOrderForClient(order) {
    const now = Date.now();
    if (order.status !== 'pending' || now - (lastClientSync.get(order.id) ?? 0) < CLIENT_SYNC_MIN_MS) return order;
    lastClientSync.set(order.id, now);
    for (const [id, at] of lastClientSync) if (now - at > 10 * 60_000) lastClientSync.delete(id);
    return syncOrderWithPlatega(order);
}

// ---------- Пробный период ----------

// Пробный период положен аккаунту: включён, ещё не использовался, подписки не было
const trialEligible = (user) => getSettings().trialEnabled && !user.trial_used_at && user.plan_kind === 'none' && !user.rw_user_id;

export const trialAvailable = (user) => trialEligible(user) && !isDisposableEmail(user.email);

// Пробный период был бы доступен, но почта одноразовая — кабинет объясняет, почему кнопки нет
export const trialDisposable = (user) => trialEligible(user) && isDisposableEmail(user.email);

export function startTrial(userId) {
    return withUserLock(userId, async () => {
        const user = getUserRow(userId);
        if (isDisposableEmail(user.email)) {
            throw new UserFacingError('Пробный период не предоставляется для временных почтовых адресов. Войдите с постоянной почтой или оформите подписку.');
        }
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

// Для кабинета: данные панели — из кэша (30 с), признаки пробного периода — из базы, всегда свежие
export async function getSubscriptionInfo(user) {
    const rwUser = await fetchRemnaUser(user, { cached: true });
    if (!rwUser) return null;
    let devices = null;
    try {
        devices = (await remnawave.getUserDevicesCached(rwUser.id)).total;
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
// Список панели запрашивается страницами; если панель не отдаёт список — по одному пользователю.
const LIST_PAGE_SIZE = 500;

export async function refreshCachedSubscriptions() {
    let panelUsers;
    try {
        panelUsers = await listAllRemnaUsers();
    } catch (err) {
        console.warn('[jobs] список пользователей панели не получен, обновляю по одному:', err.message);
        return refreshCachedSubscriptionsOneByOne();
    }
    const ours = db.prepare('SELECT id, rw_user_id FROM users WHERE rw_user_id IS NOT NULL').all();
    const update = db.prepare('UPDATE users SET expire_at = ?, rw_status = ? WHERE id = ?');
    const markDeleted = db.prepare("UPDATE users SET rw_status = 'DELETED' WHERE id = ?");
    tx(() => {
        for (const u of ours) {
            const rw = panelUsers.get(u.rw_user_id);
            // Список получен целиком — пользователя, которого в нём нет, в панели удалили
            if (!rw) markDeleted.run(u.id);
            else if (rw.expireAt && rw.status) update.run(new Date(rw.expireAt).toISOString(), rw.status, u.id);
        }
    });
}

// Все пользователи панели: Map id → пользователь. Бросает ошибку, если хоть одна страница не получена.
async function listAllRemnaUsers() {
    const all = new Map();
    for (let start = 0; ; start += LIST_PAGE_SIZE) {
        const page = await remnawave.listUsers(start, LIST_PAGE_SIZE);
        if (!Array.isArray(page?.users)) throw new Error('неожиданный ответ списка пользователей');
        for (const u of page.users) if (typeof u.id === 'number') all.set(u.id, u);
        if (page.users.length < LIST_PAGE_SIZE || start + LIST_PAGE_SIZE >= Number(page.total ?? 0)) return all;
    }
}

async function refreshCachedSubscriptionsOneByOne() {
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

// ---------- Действия клиента в кабинете ----------

// Устройства клиента (HWID) — для кабинета, из кэша панели
export async function clientDevices(user) {
    if (!user.rw_user_id) return [];
    const { devices } = await remnawave.getUserDevicesCached(user.rw_user_id);
    return devices.map((d) => ({ hwid: d.hwid, platform: d.platform, osVersion: d.osVersion, model: d.deviceModel, createdAt: d.createdAt }));
}

// Отвязка своего устройства. Отметка «устройство уже было на пробном периоде» (trial_hwids) остаётся.
export function removeClientDevice(user, hwid) {
    return withUserLock(user.id, async () => {
        const devices = await clientDevices(user);
        if (!devices.some((d) => d.hwid === hwid)) throw new UserFacingError('Устройство не найдено — обновите страницу');
        await remnawave.deleteDevice(user.rw_user_id, hwid);
        console.log(`[cabinet] ${user.email}: отвязано устройство ${hwid.slice(0, 8)}…`);
    });
}

// Перевыпуск ссылки подписки клиентом: старая ссылка перестаёт работать, новая приходит на почту
export function revokeClientLink(user) {
    return withUserLock(user.id, async () => {
        const rw = await fetchRemnaUser(user);
        if (!rw) throw new UserFacingError('Подписки пока нет — перевыпускать нечего');
        if (rw.status === 'DISABLED') throw new UserFacingError('Подписка отключена — перевыпуск недоступен. Напишите в поддержку.');
        const updated = await remnawave.revokeSubscription(rw.id);
        console.log(`[cabinet] ${user.email}: ссылка на подписку перевыпущена`);
        try {
            await sendAccountNotice(user.email, {
                title: 'Новая ссылка на подписку',
                text: 'Вы перевыпустили ссылку в личном кабинете: старая больше не работает. Добавьте новую ссылку в приложение на каждом устройстве.',
                subscriptionUrl: updated.subscriptionUrl,
            });
        } catch (err) {
            console.error('[mail] письмо с новой ссылкой не отправлено:', err.message);
        }
        return updated.subscriptionUrl;
    });
}

// ---------- Фоновые задачи ----------

// Неоплаченные заказы младше этого срока сверяются с Platega каждую минуту, старше — раз в 15 минут
const FAST_SYNC_HOURS = 2;
export const SLOW_SYNC_EVERY = 15;
// Сколько после окончания срока платёжной ссылки заказ ещё сверяется: Platega может подтвердить оплату с задержкой
const PAY_LINK_GRACE_MS = 60 * 60_000;

const sqlTime = (s) => new Date(`${s.replace(' ', 'T')}Z`);

// Ещё можно ждать оплату: платёжная ссылка жива (с запасом), а если её срок неизвестен — заказ младше ORDER_PAY_HOURS
export function awaitingPayment(order, now = Date.now()) {
    if (order.payment_expires_at) return new Date(order.payment_expires_at).getTime() + PAY_LINK_GRACE_MS > now;
    return now - sqlTime(order.created_at) < ORDER_PAY_HOURS * 60 * 60_000;
}

async function syncAll(orders) {
    for (const o of orders) {
        try {
            await syncOrderWithPlatega(o);
        } catch (err) {
            console.error(`[order ${o.id}] сверка с Platega:`, err.message);
        }
    }
}

// Оплачен, но доступ не выдан дольше STUCK_MINUTES — сотрудникам нужно разобраться (алерт раз в сутки на заказ)
const STUCK_MINUTES = 10;
function alertStuckOrders() {
    const stuck = db
        .prepare(`SELECT * FROM orders WHERE status = 'paid' AND paid_at < datetime('now', '-${STUCK_MINUTES} minutes')`)
        .all();
    for (const o of stuck) {
        alert({
            key: `order-stuck:${o.id}`,
            title: 'Оплаченный заказ не выдан',
            lines: [`Пользователь #${o.user_id}, заказ ${o.id}, ${o.amount} ₽, оплачен ${o.paid_at} UTC`, `Ошибка: ${o.error ?? 'нет'}`],
            link: adminUserUrl(o.user_id),
        });
    }
}

// Сверка заказов: выдача оплаченных, сверка неоплаченных с Platega, закрытие неоплаченных за сутки.
// slow — ещё и неоплаченные старше FAST_SYNC_HOURS, по которым оплата пока возможна (callback мог потеряться).
export async function reconcileOrders({ slow = false } = {}) {
    const paid = db.prepare("SELECT id FROM orders WHERE status = 'paid'").all();
    for (const o of paid) await applyPaidOrder(o.id);
    alertStuckOrders();

    await syncAll(
        db
            .prepare(
                `SELECT * FROM orders WHERE status = 'pending' AND platega_tx_id IS NOT NULL
                 AND created_at < datetime('now', '-3 minutes') AND created_at > datetime('now', '-${FAST_SYNC_HOURS} hours')
                 ORDER BY created_at DESC LIMIT 20`,
            )
            .all(),
    );

    if (slow) {
        await syncAll(
            db
                .prepare(
                    `SELECT * FROM orders WHERE status = 'pending' AND platega_tx_id IS NOT NULL
                     AND created_at <= datetime('now', '-${FAST_SYNC_HOURS} hours') AND created_at > datetime('now', '-${ORDER_PAY_HOURS} hours')
                     ORDER BY created_at DESC`,
                )
                .all()
                .filter((o) => awaitingPayment(o))
                .slice(0, 50),
        );
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
            const weekOld = Date.now() - sqlTime(o.created_at) > 7 * DAY_MS;
            if (o.platega_tx_id && !/→ 404/.test(err.message) && !weekOld) continue;
        }
        db.prepare("UPDATE orders SET status = 'canceled', error = COALESCE(error, 'не оплачен вовремя') WHERE id = ? AND status = 'pending'").run(o.id);
    }
}

export function startBackgroundJobs() {
    let tick = 0;
    every('orders', 60_000, () => reconcileOrders({ slow: tick++ % SLOW_SYNC_EVERY === 0 }), { firstDelayMs: 5_000 });
    every('trial-devices', 5 * 60_000, pollTrialDevices);
    every('subscriptions-cache', 30 * 60_000, refreshCachedSubscriptions, { firstDelayMs: 30_000 });
}
