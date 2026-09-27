// Промокоды: скидка в процентах или рублях на оплату тарифа.
// Использование засчитывается оплаченным заказом (а не созданным): лимит и «один раз на клиента»
// считаются по заказам с этим кодом в статусах после оплаты. При проверке кода учитываются и неоплаченные
// заказы, которые ещё можно оплатить: иначе два заказа с кодом дали бы две скидки, а лимит можно было бы превысить.
import { db } from './db.js';
import { findForbidden } from './wording.js';
import { ValidationError } from './settings.js';
import { UserFacingError } from './subscriptions.js';

// Цена после скидки не ниже этой суммы (₽)
export const MIN_PRICE = 1;
const CODE_RE = /^[A-Z0-9_-]{3,32}$/;
const USED_STATUSES = "('paid', 'applied', 'refund_pending', 'refunded', 'chargeback')";

export const normalizeCode = (code) => String(code ?? '').trim().toUpperCase();

export function discountedPrice(price, promo) {
    const raw = promo.kind === 'percent' ? price * (1 - promo.value / 100) : price - promo.value;
    return Math.max(MIN_PRICE, Math.round(raw * 100) / 100);
}

// Неоплаченный заказ, который ещё можно оплатить: платёж ещё создаётся (ссылки нет) или платёжная ссылка действует
const AWAITING_PAYMENT = "status = 'pending' AND (payment_url IS NULL OR payment_expires_at IS NULL OR payment_expires_at > ?)";

// Для лимита использований учитываются и заказы, ожидающие оплаты: иначе при лимите 1 несколько клиентов
// успели бы создать заказы с кодом, пока ни один не оплачен, и оплатить все
const usesCount = (code, now) =>
    db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE promo_code = ? AND (status IN ${USED_STATUSES} OR (${AWAITING_PAYMENT}))`).get(code, new Date(now).toISOString()).n;

// Проверка промокода для клиента и тарифа. Возвращает { code, price, priceBefore } или бросает UserFacingError.
export function applyPromo(code, plan, userId, now = Date.now()) {
    const c = normalizeCode(code);
    const promo = CODE_RE.test(c) ? db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(c) : null;
    if (!promo || !promo.active) throw new UserFacingError('Промокод не найден');
    if (promo.valid_from && now < Date.parse(promo.valid_from)) throw new UserFacingError('Промокод ещё не действует');
    if (promo.valid_until && now > Date.parse(promo.valid_until)) throw new UserFacingError('Срок действия промокода истёк');
    const planIds = JSON.parse(promo.plan_ids || '[]');
    if (planIds.length && !planIds.includes(plan.id)) throw new UserFacingError('Промокод не действует для этого тарифа');
    if (promo.max_uses != null && usesCount(c, now) >= promo.max_uses) throw new UserFacingError('Промокод больше не действует: все использования исчерпаны');
    const usedByClient = db.prepare(`SELECT 1 FROM orders WHERE promo_code = ? AND user_id = ? AND status IN ${USED_STATUSES}`).get(c, userId);
    if (usedByClient) throw new UserFacingError('Вы уже воспользовались этим промокодом');
    // Заказ клиента с этим кодом ждёт оплаты
    const pendingByClient = db.prepare(`SELECT 1 FROM orders WHERE promo_code = ? AND user_id = ? AND ${AWAITING_PAYMENT}`).get(c, userId, new Date(now).toISOString());
    if (pendingByClient) {
        throw new UserFacingError('Промокод уже применён к неоплаченному заказу — оплатите его кнопкой «Оплатить» в истории платежей');
    }
    return { code: c, price: discountedPrice(plan.price, promo), priceBefore: plan.price };
}

// ---------- Админка ----------

const publicPromo = (p) => ({
    id: p.id,
    code: p.code,
    kind: p.kind,
    value: p.value,
    maxUses: p.max_uses,
    planIds: JSON.parse(p.plan_ids || '[]'),
    validFrom: p.valid_from,
    validUntil: p.valid_until,
    active: Boolean(p.active),
    note: p.note,
    createdAt: p.created_at,
    uses: p.uses ?? 0,
    revenue: p.revenue ?? 0,
});

export function listPromos() {
    return db
        .prepare(
            `SELECT p.*,
                (SELECT COUNT(*) FROM orders o WHERE o.promo_code = p.code AND o.status IN ${USED_STATUSES}) AS uses,
                (SELECT COALESCE(SUM(amount), 0) FROM orders o WHERE o.promo_code = p.code AND o.status IN ('paid', 'applied')) AS revenue
             FROM promo_codes p ORDER BY p.id DESC`,
        )
        .all()
        .map(publicPromo);
}

export const getPromo = (id) => {
    const p = db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(Number(id));
    return p ? publicPromo(p) : null;
};

// Дата из формы (YYYY-MM-DD) — начало или конец суток по Москве, ISO; пусто — null
function mskDate(value, label, endOfDay) {
    const v = String(value ?? '').trim();
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ValidationError(`${label}: дата в формате ГГГГ-ММ-ДД`);
    const ms = Date.parse(`${v}T${endOfDay ? '23:59:59' : '00:00:00'}+03:00`);
    if (Number.isNaN(ms)) throw new ValidationError(`${label}: некорректная дата`);
    return new Date(ms).toISOString();
}

function cleanPromo(data, existing) {
    const kind = data.kind;
    if (!['percent', 'fixed'].includes(kind)) throw new ValidationError('Тип скидки: процент или рубли');
    const value = Number(data.value);
    if (kind === 'percent' && !(Number.isInteger(value) && value >= 1 && value <= 100)) throw new ValidationError('Скидка в процентах — целое число от 1 до 100');
    if (kind === 'fixed' && !(value >= 1 && value <= 1_000_000)) throw new ValidationError('Скидка в рублях — от 1 ₽');
    const maxUses = data.maxUses === '' || data.maxUses == null ? null : Number(data.maxUses);
    if (maxUses !== null && !(Number.isInteger(maxUses) && maxUses >= 1)) throw new ValidationError('Лимит использований — целое число от 1 или пусто (без лимита)');
    const planIds = Array.isArray(data.planIds) ? [...new Set(data.planIds.map(String))] : [];
    for (const id of planIds) {
        if (!db.prepare('SELECT 1 FROM plans WHERE id = ?').get(id)) throw new ValidationError(`Тариф ${id} не найден`);
    }
    const validFrom = mskDate(data.validFrom, 'Действует с', false);
    const validUntil = mskDate(data.validUntil, 'Действует по', true);
    if (validFrom && validUntil && validFrom > validUntil) throw new ValidationError('Дата начала позже даты окончания');
    const note = String(data.note ?? '').trim();
    if (note.length > 200) throw new ValidationError('Заметка — до 200 символов');
    const clean = { kind, value: kind === 'fixed' ? Math.round(value * 100) / 100 : value, maxUses, planIds, validFrom, validUntil, active: data.active !== false, note: note || null };
    if (!existing) {
        const code = normalizeCode(data.code);
        if (!CODE_RE.test(code)) throw new ValidationError('Код: 3–32 символа, латинские буквы, цифры, _ и -');
        const hit = findForbidden(code);
        if (hit) throw new ValidationError(`Код: формулировка «${hit}» недопустима для проверки банком`);
        if (db.prepare('SELECT 1 FROM promo_codes WHERE code = ?').get(code)) throw new ValidationError('Такой промокод уже есть');
        clean.code = code;
    }
    return clean;
}

export function createPromo(data, adminId) {
    const p = cleanPromo(data, null);
    const id = Number(
        db
            .prepare(
                `INSERT INTO promo_codes (code, kind, value, max_uses, plan_ids, valid_from, valid_until, active, note, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(p.code, p.kind, p.value, p.maxUses, JSON.stringify(p.planIds), p.validFrom, p.validUntil, p.active ? 1 : 0, p.note, adminId ?? null).lastInsertRowid,
    );
    return getPromo(id);
}

// Код не меняется: по нему засчитаны использования в заказах
export function updatePromo(id, data) {
    const before = getPromo(id);
    if (!before) throw new ValidationError('Промокод не найден');
    const p = cleanPromo(data, before);
    db.prepare(
        `UPDATE promo_codes SET kind = ?, value = ?, max_uses = ?, plan_ids = ?, valid_from = ?, valid_until = ?, active = ?, note = ? WHERE id = ?`,
    ).run(p.kind, p.value, p.maxUses, JSON.stringify(p.planIds), p.validFrom, p.validUntil, p.active ? 1 : 0, p.note, before.id);
    return { before, after: getPromo(before.id) };
}
