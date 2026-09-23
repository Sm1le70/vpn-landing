// Операции админки над пользователями и заказами. Каждое действие пишется в журнал.
import { config } from '../config.js';
import { db, tx } from '../db.js';
import { remnawave } from '../remnawave.js';
import { checkRefund, refundTransaction } from '../platega.js';
import { sendAccountNotice } from '../mailer.js';
import { getSettings, getPlan } from '../settings.js';
import {
    addDays,
    applyPaidOrder,
    createRemnaUser,
    fetchRemnaUser,
    findOrCreateUser,
    getUserRow,
    syncOrderWithPlatega,
    withUserLock,
} from '../subscriptions.js';

export class AdminActionError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export const SUPPORT_MAX_EXTEND_DAYS = 7;

const fmtDate = (d) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

// ---------- Журнал ----------

export function audit(admin, action, { targetType = null, targetId = null, targetLabel = null, reason = null, details = null } = {}) {
    db.prepare(
        `INSERT INTO audit_log (admin_id, admin_login, action, target_type, target_id, target_label, reason, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        admin?.id ?? null,
        admin?.login ?? 'system',
        action,
        targetType,
        targetId == null ? null : String(targetId),
        targetLabel,
        reason,
        details == null ? null : JSON.stringify(details),
    );
}

export const ACTION_TITLES = {
    'auth.login': 'Вход в админку',
    'auth.setup': 'Настройка доступа',
    'user.extend': 'Продление',
    'user.shorten': 'Сокращение срока',
    'user.grant': 'Выдача доступа без оплаты',
    'user.disable': 'Отключение',
    'user.enable': 'Включение',
    'user.reset_devices': 'Сброс устройств',
    'user.revoke_link': 'Перевыпуск ссылки',
    'user.resend_link': 'Повторная отправка ссылки',
    'user.reset_trial': 'Сброс пробного периода',
    'user.delete_subscription': 'Удаление подписки',
    'user.delete_account': 'Удаление аккаунта',
    'order.sync': 'Сверка заказа с Platega',
    'order.refund': 'Возврат средств',
    'plans.update': 'Изменение тарифов',
    'apps.update': 'Изменение приложений',
    'settings.update': 'Изменение настроек',
    'admin.invite': 'Приглашение администратора',
    'admin.reset_access': 'Сброс доступа администратора',
    'admin.role': 'Смена роли',
    'admin.disable': 'Отключение администратора',
    'admin.enable': 'Включение администратора',
};

// ---------- Общие проверки ----------

const requireReason = (reason) => {
    const r = String(reason ?? '').trim();
    if (r.length < 3) throw new AdminActionError('Укажите причину (не короче 3 символов)');
    return r.slice(0, 500);
};

const requireAdminRole = (admin) => {
    if (admin.role !== 'admin') throw new AdminActionError('Недостаточно прав', 403);
};

function loadUser(userId) {
    const user = getUserRow(Number(userId));
    if (!user) throw new AdminActionError('Пользователь не найден', 404);
    return user;
}

async function requireRemnaUser(user) {
    const rw = await fetchRemnaUser(user);
    if (!rw) throw new AdminActionError('У пользователя нет подписки в панели');
    return rw;
}

async function notifyUser(user, notify, payload) {
    if (!notify) return false;
    try {
        await sendAccountNotice(user.email, payload);
        return true;
    } catch (err) {
        console.error('[admin] письмо не отправлено:', err.message);
        return false;
    }
}

// ---------- Действия с подпиской ----------

// days > 0 — продление, days < 0 — сокращение. Если подписки нет, она создаётся.
async function changeDays(user, days) {
    let rw = await fetchRemnaUser(user);
    const before = rw ? { expireAt: rw.expireAt, status: rw.status } : null;
    if (!rw) {
        if (days < 0) throw new AdminActionError('У пользователя нет подписки — сокращать нечего');
        rw = await createRemnaUser(user, { expireAt: addDays(new Date(), days), deviceLimit: getSettings().paidDeviceLimit, note: 'admin' });
        db.prepare("UPDATE users SET plan_kind = 'paid' WHERE id = ? AND plan_kind = 'none'").run(user.id);
    } else {
        const now = new Date();
        const current = new Date(rw.expireAt);
        const base = days > 0 && current < now ? now : current;
        let next = addDays(base, days);
        // Панель не принимает дату в прошлом: при сокращении «в минус» подписка истекает через минуту.
        const minNext = new Date(now.getTime() + 60_000);
        if (next < minNext) next = minNext;
        const patch = { id: rw.id, expireAt: next.toISOString() };
        if (rw.status === 'EXPIRED' && days > 0) patch.status = 'ACTIVE';
        rw = await remnawave.updateUser(patch);
    }
    return { rw, before, after: { expireAt: rw.expireAt, status: rw.status } };
}

export function extendUser(admin, userId, { days, reason, notify }) {
    const d = Number(days);
    if (!Number.isInteger(d) || d === 0 || Math.abs(d) > 3650) throw new AdminActionError('Количество дней: целое число, не 0');
    if (admin.role === 'support' && (d < 0 || d > SUPPORT_MAX_EXTEND_DAYS)) {
        throw new AdminActionError(`Поддержка может продлевать только на 1–${SUPPORT_MAX_EXTEND_DAYS} дней`, 403);
    }
    const r = requireReason(reason);
    const user = loadUser(userId);
    return withUserLock(user.id, async () => {
        const { rw, before, after } = await changeDays(user, d);
        const notified = await notifyUser(user, notify, {
            title: d > 0 ? 'Подписка продлена' : 'Срок подписки изменён',
            text: d > 0 ? `Ваша подписка продлена на ${d} дн. и действует до ${fmtDate(rw.expireAt)}.` : `Срок действия подписки изменён: до ${fmtDate(rw.expireAt)}.`,
        });
        audit(admin, d > 0 ? 'user.extend' : 'user.shorten', {
            targetType: 'user', targetId: user.id, targetLabel: user.email, reason: r, details: { days: d, before, after, notified },
        });
        return { expireAt: rw.expireAt, status: rw.status };
    });
}

export async function grantAccess(admin, { email, days, planId, reason, notify }) {
    requireAdminRole(admin);
    const e = String(email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new AdminActionError('Некорректный email');
    // Можно выдать доступ по тарифу — тогда срок берётся из него
    let d = Number(days);
    if (planId) {
        const plan = getPlan(planId, { includeHidden: true });
        if (!plan) throw new AdminActionError('Тариф не найден');
        d = plan.days;
    }
    if (!Number.isInteger(d) || d < 1 || d > 3650) throw new AdminActionError('Количество дней: от 1 до 3650');
    const r = requireReason(reason);
    const user = findOrCreateUser(e);
    return withUserLock(user.id, async () => {
        const { rw, before, after } = await changeDays(getUserRow(user.id), d);
        const notified = await notifyUser(user, notify, {
            title: 'Вам предоставлен доступ',
            text: `Вам предоставлен доступ на ${d} дн. — до ${fmtDate(rw.expireAt)}. Войдите в личный кабинет по этому email, чтобы подключиться.`,
            subscriptionUrl: rw.subscriptionUrl,
        });
        audit(admin, 'user.grant', { targetType: 'user', targetId: user.id, targetLabel: user.email, reason: r, details: { days: d, planId: planId ?? null, before, after, notified } });
        return { userId: user.id };
    });
}

export function setEnabled(admin, userId, enabled, { reason, notify }) {
    requireAdminRole(admin);
    const r = requireReason(reason);
    const user = loadUser(userId);
    return withUserLock(user.id, async () => {
        const rw = await requireRemnaUser(user);
        const updated = enabled ? await remnawave.enableUser(rw.id) : await remnawave.disableUser(rw.id);
        db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(enabled ? 0 : 1, user.id);
        const notified = await notifyUser(user, notify, enabled
            ? { title: 'Доступ восстановлен', text: `Доступ к сервису восстановлен. Подписка действует до ${fmtDate(updated.expireAt)}.` }
            : { title: 'Доступ приостановлен', text: 'Доступ к сервису приостановлен. Если у вас есть вопросы, напишите в поддержку.' });
        audit(admin, enabled ? 'user.enable' : 'user.disable', {
            targetType: 'user', targetId: user.id, targetLabel: user.email, reason: r, details: { before: rw.status, after: updated.status, notified },
        });
        return { status: updated.status };
    });
}

export function resetDevices(admin, userId, { reason, notify }) {
    const r = requireReason(reason);
    const user = loadUser(userId);
    return withUserLock(user.id, async () => {
        const rw = await requireRemnaUser(user);
        const before = await remnawave.getUserDevices(rw.id);
        await remnawave.deleteAllDevices(rw.id);
        const notified = await notifyUser(user, notify, {
            title: 'Список устройств очищен',
            text: 'Все устройства отвязаны от подписки. Подключите нужные устройства заново.',
        });
        audit(admin, 'user.reset_devices', {
            targetType: 'user', targetId: user.id, targetLabel: user.email, reason: r,
            details: { removed: before.devices.map((d) => ({ hwid: d.hwid, platform: d.platform, model: d.deviceModel })), notified },
        });
        return { removed: before.total };
    });
}

export function revokeLink(admin, userId, { reason, notify }) {
    const r = requireReason(reason);
    const user = loadUser(userId);
    return withUserLock(user.id, async () => {
        const rw = await requireRemnaUser(user);
        const updated = await remnawave.revokeSubscription(rw.id);
        const notified = await notifyUser(user, notify, {
            title: 'Новая ссылка на подписку',
            text: 'Ссылка на подписку перевыпущена, старая больше не работает. Добавьте новую ссылку в приложение.',
            subscriptionUrl: updated.subscriptionUrl,
        });
        audit(admin, 'user.revoke_link', { targetType: 'user', targetId: user.id, targetLabel: user.email, reason: r, details: { notified } });
        return { subscriptionUrl: updated.subscriptionUrl };
    });
}

export async function resendLink(admin, userId, { reason }) {
    const user = loadUser(userId);
    const rw = await requireRemnaUser(user);
    const sent = await notifyUser(user, true, {
        title: 'Ваша ссылка на подписку',
        text: `Подписка действует до ${fmtDate(rw.expireAt)}. Добавьте ссылку в приложение.`,
        subscriptionUrl: rw.subscriptionUrl,
    });
    if (!sent) throw new AdminActionError('Не удалось отправить письмо — проверьте настройки Resend', 502);
    audit(admin, 'user.resend_link', { targetType: 'user', targetId: user.id, targetLabel: user.email, reason: String(reason ?? '').trim() || null });
    return { ok: true };
}

export function resetTrial(admin, userId, { reason }) {
    requireAdminRole(admin);
    const r = requireReason(reason);
    const user = loadUser(userId);
    return withUserLock(user.id, async () => {
        const details = {};
        if (user.trial_blocked) {
            // Снимаем отметку «устройство уже использовало пробный период»
            if (user.rw_user_id && !user.blocked) {
                const rw = await fetchRemnaUser(user);
                if (rw?.status === 'DISABLED') await remnawave.enableUser(rw.id);
            }
            db.prepare('UPDATE users SET trial_blocked = 0 WHERE id = ?').run(user.id);
            details.unblocked = true;
        }
        if (!user.rw_user_id) {
            db.prepare("UPDATE users SET trial_used_at = NULL, plan_kind = 'none' WHERE id = ?").run(user.id);
            details.trialAvailableAgain = true;
        }
        db.prepare('DELETE FROM trial_hwids WHERE user_id = ?').run(user.id);
        if (!details.unblocked && !details.trialAvailableAgain) {
            throw new AdminActionError('Нечего сбрасывать: пробный период не был отключён, а подписка уже существует');
        }
        audit(admin, 'user.reset_trial', { targetType: 'user', targetId: user.id, targetLabel: user.email, reason: r, details });
        return details;
    });
}

// Удаляет пользователя в панели Remnawave. Аккаунт на сайте и история платежей остаются:
// клиент сможет войти в кабинет и оформить подписку заново.
export function deleteSubscription(admin, userId, { reason, notify }) {
    requireAdminRole(admin);
    const r = requireReason(reason);
    const user = loadUser(userId);
    return withUserLock(user.id, async () => {
        const rw = await fetchRemnaUser(user);
        if (rw) await remnawave.deleteUser(rw.id);
        db.prepare(
            `UPDATE users SET rw_user_id = NULL, rw_username = NULL, expire_at = NULL, rw_status = NULL,
                              plan_kind = 'none', blocked = 0 WHERE id = ?`,
        ).run(user.id);
        db.prepare('DELETE FROM trial_hwids WHERE user_id = ?').run(user.id);
        const notified = await notifyUser(user, notify, {
            title: 'Подписка удалена',
            text: 'Ваша подписка удалена, ссылка больше не работает. Оформить новую можно в личном кабинете.',
        });
        audit(admin, 'user.delete_subscription', {
            targetType: 'user', targetId: user.id, targetLabel: user.email, reason: r,
            details: { removedPanelUser: rw ? { id: rw.id, username: rw.username, expireAt: rw.expireAt } : null, notified },
        });
        return { ok: true };
    });
}

// Маска email для журнала: an***@mail.ru
const maskEmail = (email) => {
    const [name, domain] = String(email).split('@');
    return `${name.slice(0, 2)}***@${domain ?? ''}`;
};

// Полное удаление аккаунта: подписка удаляется в панели, персональные данные обезличиваются.
// Записи о платежах остаются (без email) — они нужны для отчётности и разбора споров с банком.
export function deleteAccount(admin, userId, { reason, confirmEmail }) {
    requireAdminRole(admin);
    const r = requireReason(reason);
    const user = loadUser(userId);
    if (String(confirmEmail ?? '').trim().toLowerCase() !== user.email) {
        throw new AdminActionError('Для подтверждения введите email пользователя без ошибок');
    }
    return withUserLock(user.id, async () => {
        const rw = await fetchRemnaUser(user);
        if (rw) await remnawave.deleteUser(rw.id);
        const anonymized = `deleted-${user.id}@deleted.invalid`;
        tx(() => {
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
            db.prepare('DELETE FROM login_codes WHERE email = ?').run(user.email);
            db.prepare('DELETE FROM trial_hwids WHERE user_id = ?').run(user.id);
            db.prepare(
                `UPDATE users SET email = ?, rw_user_id = NULL, rw_username = NULL, expire_at = NULL, rw_status = NULL,
                                  plan_kind = 'none', trial_used_at = NULL, trial_blocked = 0, blocked = 1 WHERE id = ?`,
            ).run(anonymized, user.id);
            // Email в журнале тоже обезличиваем, иначе удаление данных не полное
            db.prepare("UPDATE audit_log SET target_label = ? WHERE target_type = 'user' AND target_id = ?").run(maskEmail(user.email), String(user.id));
        });
        audit(admin, 'user.delete_account', {
            targetType: 'user', targetId: user.id, targetLabel: maskEmail(user.email), reason: r,
            details: { removedPanelUser: rw ? { id: rw.id, username: rw.username } : null, ordersKept: db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(user.id).n },
        });
        return { ok: true };
    });
}

// ---------- Заказы ----------

function loadOrder(orderId) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(orderId));
    if (!order) throw new AdminActionError('Заказ не найден', 404);
    return order;
}

export async function syncOrder(admin, orderId) {
    requireAdminRole(admin);
    let order = loadOrder(orderId);
    const before = order.status;
    if (order.status === 'pending') order = await syncOrderWithPlatega(order);
    if (order.status === 'paid') {
        await applyPaidOrder(order.id);
        order = loadOrder(orderId);
    }
    audit(admin, 'order.sync', { targetType: 'order', targetId: order.id, details: { before, after: order.status, error: order.error } });
    return { status: order.status, error: order.error };
}

export async function refundPreview(admin, orderId) {
    requireAdminRole(admin);
    const order = loadOrder(orderId);
    if (!['applied', 'paid'].includes(order.status)) throw new AdminActionError('Возврат возможен только для оплаченного заказа');
    const check = await checkRefund(order.platega_tx_id);
    return {
        supported: Boolean(check.supported),
        totalDeductUsdt: check.totalDeductUsdt,
        penaltyUsdt: check.penaltyUsdt,
        blockReason: check.blockReason || null,
        amount: order.amount,
        days: order.days,
    };
}

export async function refundOrder(admin, orderId, { subscriptionAction, reason, notify }) {
    requireAdminRole(admin);
    if (!['remove_days', 'disable', 'keep'].includes(subscriptionAction)) throw new AdminActionError('Выберите, что сделать с подпиской');
    const r = requireReason(reason);
    const order = loadOrder(orderId);
    if (!['applied', 'paid'].includes(order.status)) throw new AdminActionError('Возврат возможен только для оплаченного заказа');
    const user = loadUser(order.user_id);

    const check = await checkRefund(order.platega_tx_id);
    if (!check.supported) throw new AdminActionError(`Platega: возврат невозможен${check.blockReason ? ` (${check.blockReason})` : ''}`);

    const result = await refundTransaction(order.platega_tx_id);
    const status = result.accepted ? 'refunded' : result.manualControlRequired ? 'refund_pending' : null;
    if (!status) throw new AdminActionError(`Platega отклонила возврат: ${result.message || 'без пояснений'}`);
    db.prepare("UPDATE orders SET status = ?, refunded_at = datetime('now'), refund_info = ? WHERE id = ?").run(
        status,
        JSON.stringify({ accepted: result.accepted, manual: result.manualControlRequired, message: result.message, subscriptionAction }),
        order.id,
    );

    let subscription = null;
    try {
        subscription = await withUserLock(user.id, async () => {
            if (subscriptionAction === 'remove_days' && user.rw_user_id) return (await changeDays(getUserRow(user.id), -order.days)).after;
            if (subscriptionAction === 'disable' && user.rw_user_id) {
                const rw = await remnawave.disableUser(user.rw_user_id);
                db.prepare('UPDATE users SET blocked = 1 WHERE id = ?').run(user.id);
                return { expireAt: rw.expireAt, status: rw.status };
            }
            return null;
        });
    } catch (err) {
        console.error(`[admin] возврат ${order.id}: не удалось изменить подписку:`, err.message);
        subscription = { error: err.message };
    }

    const notified = await notifyUser(user, notify, {
        title: 'Возврат средств',
        text: status === 'refunded'
            ? `Оформлен возврат ${order.amount} ₽ по заказу от ${fmtDate(order.created_at.replace(' ', 'T') + 'Z')}. Срок зачисления зависит от вашего банка.`
            : `Запрос на возврат ${order.amount} ₽ принят и находится в обработке.`,
    });
    audit(admin, 'order.refund', {
        targetType: 'order', targetId: order.id, targetLabel: user.email, reason: r,
        details: { amount: order.amount, status, platega: result, subscriptionAction, subscription, notified },
    });
    return { status, message: result.message, subscription };
}

// ---------- Просмотр ----------

export async function userDetails(userId) {
    const user = loadUser(userId);
    let rw = null;
    let devices = [];
    let rwError = null;
    try {
        rw = await fetchRemnaUser(user);
        if (rw) devices = (await remnawave.getUserDevices(rw.id)).devices;
    } catch (err) {
        rwError = err.message;
    }
    const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(user.id).map(withPlanTitle);
    const history = db
        .prepare(
            `SELECT * FROM audit_log
             WHERE (target_type = 'user' AND target_id = ?)
                OR (target_type = 'order' AND target_id IN (SELECT id FROM orders WHERE user_id = ?))
             ORDER BY id DESC LIMIT 100`,
        )
        .all(String(user.id), user.id)
        .map(formatAudit);
    return {
        user: publicUser(user),
        subscription: rw && {
            id: rw.id,
            username: rw.username,
            status: rw.status,
            expireAt: rw.expireAt,
            subscriptionUrl: rw.subscriptionUrl,
            deviceLimit: rw.hwidDeviceLimit,
            createdAt: rw.createdAt,
        },
        devices: devices.map((d) => ({ hwid: d.hwid, platform: d.platform, osVersion: d.osVersion, model: d.deviceModel, createdAt: d.createdAt })),
        rwError,
        orders,
        history,
        panelUrl: rw && config.remnawave.url ? `${config.remnawave.url}/users/${rw.id}` : null,
    };
}

function publicUser(u) {
    return {
        id: u.id,
        email: u.email,
        planKind: u.plan_kind,
        rwUserId: u.rw_user_id,
        expireAt: u.expire_at,
        rwStatus: u.rw_status,
        blocked: Boolean(u.blocked),
        trialUsedAt: u.trial_used_at,
        trialBlocked: Boolean(u.trial_blocked),
        createdAt: u.created_at,
    };
}

function withPlanTitle(o) {
    return {
        id: o.id,
        userId: o.user_id,
        email: o.email,
        planId: o.plan_id,
        planTitle: getPlan(o.plan_id, { includeHidden: true })?.title ?? o.plan_id,
        days: o.days,
        amount: o.amount,
        status: o.status,
        plategaTxId: o.platega_tx_id,
        error: o.error,
        createdAt: o.created_at,
        paidAt: o.paid_at,
        refundedAt: o.refunded_at,
        refundInfo: o.refund_info ? JSON.parse(o.refund_info) : null,
    };
}

export function formatAudit(row) {
    return {
        id: row.id,
        adminLogin: row.admin_login,
        action: row.action,
        actionTitle: ACTION_TITLES[row.action] ?? row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        targetLabel: row.target_label,
        reason: row.reason,
        details: row.details ? JSON.parse(row.details) : null,
        createdAt: row.created_at,
    };
}

// ---------- Списки ----------

const USER_FILTERS = {
    active: "u.expire_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.rw_status = 'ACTIVE' AND u.plan_kind != 'trial'",
    trial: "u.expire_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.rw_status = 'ACTIVE' AND u.plan_kind = 'trial'",
    expired: "u.rw_user_id IS NOT NULL AND (u.expire_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') OR u.rw_status = 'EXPIRED')",
    disabled: "u.rw_status = 'DISABLED' OR u.blocked = 1",
    none: 'u.rw_user_id IS NULL',
    expiring: "u.rw_status = 'ACTIVE' AND u.expire_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.expire_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 days')",
};

function userQuery({ q, filter }) {
    const where = [];
    const params = [];
    if (q) {
        where.push('u.email LIKE ?');
        params.push(`%${String(q).trim().toLowerCase()}%`);
    }
    if (filter && USER_FILTERS[filter]) where.push(`(${USER_FILTERS[filter]})`);
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listUsers({ q, filter, page = 1, pageSize = 50 }) {
    const { where, params } = userQuery({ q, filter });
    const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).get(...params).n;
    const rows = db
        .prepare(
            `SELECT u.*,
                (SELECT COALESCE(SUM(amount), 0) FROM orders o WHERE o.user_id = u.id AND o.status IN ('applied', 'paid')) AS paid_total
             FROM users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (Math.max(1, page) - 1) * pageSize);
    return { total, page, pageSize, items: rows.map((u) => ({ ...publicUser(u), paidTotal: u.paid_total })) };
}

function orderQuery({ q, status, plan, from, to }) {
    const where = [];
    const params = [];
    if (q) {
        where.push('(u.email LIKE ? OR o.id LIKE ? OR o.platega_tx_id LIKE ?)');
        const like = `%${String(q).trim().toLowerCase()}%`;
        params.push(like, like, like);
    }
    if (status) {
        where.push('o.status = ?');
        params.push(status);
    }
    if (plan) {
        where.push('o.plan_id = ?');
        params.push(plan);
    }
    if (from) {
        where.push('o.created_at >= ?');
        params.push(`${from} 00:00:00`);
    }
    if (to) {
        where.push('o.created_at <= ?');
        params.push(`${to} 23:59:59`);
    }
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listOrders({ page = 1, pageSize = 50, ...filters }) {
    const { where, params } = orderQuery(filters);
    const base = `FROM orders o JOIN users u ON u.id = o.user_id ${where}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params).n;
    const sum = db.prepare(`SELECT COALESCE(SUM(o.amount), 0) AS s ${base} ${where ? 'AND' : 'WHERE'} o.status IN ('applied', 'paid')`).get(...params).s;
    const rows = db.prepare(`SELECT o.*, u.email ${base} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (Math.max(1, page) - 1) * pageSize);
    return { total, paidSum: sum, page, pageSize, items: rows.map(withPlanTitle) };
}

export function listAudit({ admin, adminLogin, action, page = 1, pageSize = 50 }) {
    const where = [];
    const params = [];
    // Поддержка видит только свои действия
    if (admin.role !== 'admin') {
        where.push('admin_id = ?');
        params.push(admin.id);
    } else if (adminLogin) {
        where.push('admin_login = ?');
        params.push(adminLogin);
    }
    if (action) {
        where.push('action = ?');
        params.push(action);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${w}`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (Math.max(1, page) - 1) * pageSize);
    return { total, page, pageSize, items: rows.map(formatAudit) };
}

// ---------- CSV ----------

function toCsv(header, rows) {
    const cell = (v) => {
        const s = v == null ? '' : String(v);
        return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Разделитель «;» и BOM — чтобы Excel с русской локалью открыл файл без мастера импорта.
    return '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
}

const STATUS_TITLES = {
    pending: 'Ожидает оплаты', paid: 'Оплачен, выдаётся', applied: 'Оплачен', canceled: 'Не оплачен',
    chargeback: 'Chargeback', refunded: 'Возврат', refund_pending: 'Возврат в обработке',
};

export function usersCsv(filters) {
    const { where, params } = userQuery(filters);
    const rows = db
        .prepare(
            `SELECT u.*, (SELECT COALESCE(SUM(amount), 0) FROM orders o WHERE o.user_id = u.id AND o.status IN ('applied', 'paid')) AS paid_total
             FROM users u ${where} ORDER BY u.id`,
        )
        .all(...params);
    return toCsv(
        ['ID', 'Email', 'Тип', 'Статус', 'Действует до', 'Оплачено, ₽', 'Пробный период', 'Отключён админом', 'Регистрация'],
        rows.map((u) => [u.id, u.email, u.plan_kind, u.rw_status ?? '', u.expire_at ?? '', u.paid_total, u.trial_used_at ?? '', u.blocked ? 'да' : '', u.created_at]),
    );
}

export function ordersCsv(filters) {
    const { where, params } = orderQuery(filters);
    const rows = db.prepare(`SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id ${where} ORDER BY o.created_at`).all(...params);
    return toCsv(
        ['Заказ', 'Дата', 'Email', 'Тариф', 'Дней', 'Сумма, ₽', 'Статус', 'Оплачен', 'Возврат', 'Транзакция Platega'],
        rows.map((o) => [o.id, o.created_at, o.email, getPlan(o.plan_id, { includeHidden: true })?.title ?? o.plan_id, o.days, o.amount,
            STATUS_TITLES[o.status] ?? o.status, o.paid_at ?? '', o.refunded_at ?? '', o.platega_tx_id ?? '']),
    );
}

// ---------- Статистика ----------

export function stats() {
    const revenue = (days) =>
        db
            .prepare(
                `SELECT COALESCE(SUM(amount), 0) AS sum, COUNT(*) AS n FROM orders
                 WHERE status IN ('applied', 'paid') AND paid_at >= datetime('now', ?)`,
            )
            .get(days === 0 ? 'start of day' : `-${days} days`);
    const nowIso = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
    const active = db
        .prepare(
            `SELECT
                SUM(CASE WHEN plan_kind != 'trial' THEN 1 ELSE 0 END) AS paid,
                SUM(CASE WHEN plan_kind = 'trial' THEN 1 ELSE 0 END) AS trial
             FROM users WHERE rw_status = 'ACTIVE' AND expire_at > ${nowIso}`,
        )
        .get();
    const trials = db.prepare('SELECT COUNT(*) AS n FROM users WHERE trial_used_at IS NOT NULL').get().n;
    const converted = db
        .prepare(
            `SELECT COUNT(DISTINCT u.id) AS n FROM users u JOIN orders o ON o.user_id = u.id
             WHERE u.trial_used_at IS NOT NULL AND o.status IN ('applied', 'paid') AND o.paid_at >= u.trial_used_at`,
        )
        .get().n;

    const dailyRows = db
        .prepare(
            `SELECT date(paid_at) AS day, SUM(amount) AS sum, COUNT(*) AS n FROM orders
             WHERE status IN ('applied', 'paid') AND paid_at >= date('now', '-29 days')
             GROUP BY date(paid_at)`,
        )
        .all();
    const byDay = new Map(dailyRows.map((r) => [r.day, r]));
    const daily = [];
    for (let i = 29; i >= 0; i--) {
        const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
        daily.push({ day, sum: byDay.get(day)?.sum ?? 0, count: byDay.get(day)?.n ?? 0 });
    }

    const byPlan = db
        .prepare(
            `SELECT plan_id, COUNT(*) AS n, SUM(amount) AS sum FROM orders
             WHERE status IN ('applied', 'paid') AND paid_at >= datetime('now', '-30 days')
             GROUP BY plan_id ORDER BY sum DESC`,
        )
        .all()
        .map((r) => ({ planId: r.plan_id, planTitle: getPlan(r.plan_id, { includeHidden: true })?.title ?? r.plan_id, count: r.n, sum: r.sum }));

    const expiring = db
        .prepare(
            `SELECT * FROM users WHERE rw_status = 'ACTIVE' AND expire_at > ${nowIso}
             AND expire_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 days') ORDER BY expire_at LIMIT 50`,
        )
        .all()
        .map(publicUser);

    const stuck = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' OR (status = 'applied' AND error IS NOT NULL)").get().n;

    return {
        revenue: { today: revenue(0), week: revenue(7), month: revenue(30) },
        active: { paid: active.paid ?? 0, trial: active.trial ?? 0 },
        trials: { total: trials, converted, rate: trials ? converted / trials : 0 },
        daily,
        byPlan,
        expiring,
        stuckOrders: stuck,
        totalUsers: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    };
}
