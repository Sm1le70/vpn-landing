// Аналитика для админки: деньги, воронка регистраций, брошенные оплаты, удержание, когорты,
// промокоды, напоминания, возвраты. Сутки и месяцы — московские; в базе время в UTC.
//
// Сроки подписок восстанавливаются по оплаченным заказам так же, как их продлевает сервер:
// заказ добавляет свои дни к текущему сроку, а если срок уже прошёл — к моменту оплаты.
// Ручные продления и выдачи из админки, пробный период и возвращённые заказы в сроки не входят.
import { db } from '../db.js';
import { getPlan, getSettings } from '../settings.js';
import { AdminActionError, DAY_MS, mskDate } from './service.js';

// Заказы, которые приносят выручку и дни подписки (как в сводке)
const PAID = new Set(['applied', 'paid']);
const REFUNDED = new Set(['refunded', 'refund_pending']);
const MAX_RANGE_DAYS = 366;
const COHORT_MONTHS = 12;

// Время из базы: 'YYYY-MM-DD HH:MM:SS' (UTC) или ISO → мс
const toMs = (s) => (s ? Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`) : null);
const mskMidnight = (date) => Date.parse(`${date}T00:00:00+03:00`);
const inRange = (t, [a, b]) => t != null && t >= a && t < b;
const ratio = (a, b) => (b ? a / b : null);
const round2 = (n) => Math.round(n * 100) / 100;

function median(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Период из формы (московские даты включительно); по умолчанию — последние 30 суток
export function parsePeriod({ from, to } = {}, now = Date.now()) {
    const valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && mskDate(mskMidnight(v)) === v;
    const today = mskDate(now);
    const toDate = valid(to) ? to : today;
    const fromDate = valid(from) ? from : mskDate(mskMidnight(toDate) - 29 * DAY_MS);
    const start = mskMidnight(fromDate);
    const end = mskMidnight(toDate) + DAY_MS;
    if (start >= end) throw new AdminActionError('Начало периода позже конца');
    if (end - start > MAX_RANGE_DAYS * DAY_MS) throw new AdminActionError(`Период — не больше ${MAX_RANGE_DAYS} дней`);
    // Предыдущий период той же длины — для сравнения
    return { from: fromDate, to: toDate, cur: [start, end], prev: [2 * start - end, start], days: Math.round((end - start) / DAY_MS) };
}

// Все данные, нужные расчётам, — одним проходом по базе
function load() {
    const orders = db
        .prepare('SELECT id, user_id, plan_id, days, amount, status, created_at, paid_at, promo_code, price_before FROM orders')
        .all()
        .map((o) => ({ ...o, created: toMs(o.created_at), paid: toMs(o.paid_at) }));
    const users = new Map(
        db.prepare('SELECT id, created_at, trial_used_at FROM users').all()
            .map((u) => [u.id, { id: u.id, created: toMs(u.created_at), trial: toMs(u.trial_used_at), orders: [], paidOrders: [] }]),
    );
    for (const o of orders) users.get(o.user_id)?.orders.push(o);
    for (const u of users.values()) {
        u.orders.sort((a, b) => a.created - b.created);
        // Сроки подписки по оплаченным заказам
        let end = 0;
        u.paidOrders = u.orders.filter((o) => PAID.has(o.status) && o.paid != null).sort((a, b) => a.paid - b.paid);
        u.paidOrders.forEach((o, i) => {
            o.start = Math.max(o.paid, end);
            o.end = end = o.start + o.days * DAY_MS;
            o.prevOrder = u.paidOrders[i - 1] ?? null;
            o.nextOrder = u.paidOrders[i + 1] ?? null;
            o.isFirst = i === 0;
        });
        u.firstPaid = u.paidOrders[0]?.paid ?? null;
    }
    const reminders = db.prepare('SELECT user_id, expire_at, days_before, sent_at FROM expiry_reminders').all()
        .map((r) => ({ userId: r.user_id, expire: toMs(r.expire_at), expireKey: r.expire_at, daysBefore: r.days_before, sent: toMs(r.sent_at) }));
    return { orders, users, reminders };
}

const covered = (u, t) => u.paidOrders.some((o) => o.start <= t && t < o.end);
// Выручка в пересчёте на месяц (30 дней) в момент t: цена каждого действующего заказа, разложенная по его дням
const monthlyRevenueAt = (users, t) => {
    let sum = 0;
    for (const u of users.values()) for (const o of u.paidOrders) if (o.start <= t && t < o.end) sum += (o.amount / o.days) * 30;
    return round2(sum);
};

function money(data, range, now) {
    const paid = data.orders.filter((o) => PAID.has(o.status) && inRange(o.paid, range));
    const revenue = round2(paid.reduce((s, o) => s + o.amount, 0));
    const payers = new Set(paid.map((o) => o.user_id)).size;
    const firstOrders = paid.filter((o) => o.isFirst);
    const newRevenue = round2(firstOrders.reduce((s, o) => s + o.amount, 0));
    const waits = firstOrders.map((o) => o.paid - data.users.get(o.user_id).created).filter((ms) => ms >= 0);
    return {
        revenue,
        payments: paid.length,
        payers,
        avgCheck: paid.length ? round2(revenue / paid.length) : null,
        arppu: payers ? round2(revenue / payers) : null,
        newCustomers: firstOrders.length,
        newRevenue,
        repeatRevenue: round2(revenue - newRevenue),
        // Медиана времени от первого входа в кабинет до первой оплаты, мс
        timeToFirstPay: median(waits),
        monthlyStart: monthlyRevenueAt(data.users, range[0]),
        monthlyEnd: monthlyRevenueAt(data.users, Math.min(range[1], now)),
    };
}

// Воронка по клиентам, впервые вошедшим в кабинет за период (дальнейшие шаги — до сегодняшнего дня)
function funnel(data, range) {
    const cohort = [...data.users.values()].filter((u) => inRange(u.created, range));
    const ordered = cohort.filter((u) => u.orders.length);
    const paid = cohort.filter((u) => u.orders.some((o) => o.paid != null));
    return {
        registered: cohort.length,
        trial: cohort.filter((u) => u.trial != null).length,
        ordered: ordered.length,
        paid: paid.length,
    };
}

// Заказы, созданные за период, которые так и не оплатили
function abandoned(data, range) {
    const created = data.orders.filter((o) => inRange(o.created, range));
    const canceled = created.filter((o) => o.status === 'canceled');
    const users = new Set(canceled.map((o) => o.user_id));
    // Клиенты, которые после неоплаченного заказа всё-таки оплатили другой
    const recovered = [...users].filter((id) => {
        const firstCanceled = Math.min(...canceled.filter((o) => o.user_id === id).map((o) => o.created));
        return data.users.get(id)?.orders.some((o) => o.paid != null && o.created > firstCanceled);
    }).length;
    const pending = created.filter((o) => o.status === 'pending').length;
    return {
        created: created.length,
        paid: created.filter((o) => o.paid != null).length,
        canceled: canceled.length,
        pending,
        rate: ratio(canceled.length, created.length - pending),
        users: users.size,
        recovered,
    };
}

// Окончания оплаченных сроков за период: продлили вовремя (не позже graceDays после окончания),
// вернулись позже или ушли. Окончания, по которым льготное окно ещё идёт, — отдельно.
function retention(data, range, now, graceDays) {
    const grace = graceDays * DAY_MS;
    const res = { due: 0, renewed: 0, returned: 0, churned: 0, waiting: 0 };
    const churnedUsers = new Set();
    for (const u of data.users.values()) {
        for (const o of u.paidOrders) {
            if (!inRange(o.end, range) || o.end > now) continue;
            const next = o.nextOrder;
            if (next && next.paid <= o.end + grace) res.renewed++;
            else if (o.end + grace > now) res.waiting++;
            else if (next) res.returned++;
            else {
                res.churned++;
                churnedUsers.add(u.id);
            }
        }
    }
    res.due = res.renewed + res.returned + res.churned;
    res.renewalRate = ratio(res.renewed, res.due);
    // Отток: доля клиентов с оплаченной подпиской на начало периода, которые ушли
    const activeAtStart = [...data.users.values()].filter((u) => covered(u, range[0]));
    res.activeAtStart = activeAtStart.length;
    res.churnRate = ratio(activeAtStart.filter((u) => churnedUsers.has(u.id)).length, activeAtStart.length);

    const trials = [...data.users.values()].filter((u) => inRange(u.trial, range));
    const converted = trials.filter((u) => u.orders.some((o) => o.paid != null && o.paid >= u.trial));
    res.trials = trials.length;
    res.trialConverted = converted.length;
    res.trialRate = ratio(converted.length, trials.length);
    return res;
}

function refunds(data, range) {
    const paid = data.orders.filter((o) => inRange(o.paid, range));
    const sum = (list) => round2(list.reduce((s, o) => s + o.amount, 0));
    const gross = sum(paid);
    const refunded = paid.filter((o) => REFUNDED.has(o.status));
    const chargeback = paid.filter((o) => o.status === 'chargeback');
    return {
        gross,
        count: paid.length,
        refunded: { count: refunded.length, sum: sum(refunded), rate: ratio(sum(refunded), gross) },
        chargeback: { count: chargeback.length, sum: sum(chargeback), rate: ratio(sum(chargeback), gross) },
    };
}

const planTitle = (id) => getPlan(id, { includeHidden: true })?.title ?? id;

function plans(data, range) {
    const paid = data.orders.filter((o) => PAID.has(o.status) && inRange(o.paid, range));
    const byPlan = new Map();
    const transitions = new Map();
    for (const o of paid) {
        const p = byPlan.get(o.plan_id) ?? { planId: o.plan_id, planTitle: planTitle(o.plan_id), count: 0, sum: 0, repeat: 0 };
        p.count++;
        p.sum = round2(p.sum + o.amount);
        if (!o.isFirst) p.repeat++;
        byPlan.set(o.plan_id, p);
        if (o.prevOrder) {
            const key = `${o.prevOrder.plan_id}→${o.plan_id}`;
            const t = transitions.get(key) ?? { from: planTitle(o.prevOrder.plan_id), to: planTitle(o.plan_id), fromDays: o.prevOrder.days, toDays: o.days, count: 0 };
            t.count++;
            transitions.set(key, t);
        }
    }
    return {
        byPlan: [...byPlan.values()].sort((a, b) => b.sum - a.sum),
        transitions: [...transitions.values()].sort((a, b) => b.count - a.count),
    };
}

function promo(data, range) {
    const byCode = new Map();
    let revenue = 0;
    for (const o of data.orders) {
        if (!PAID.has(o.status) || !inRange(o.paid, range)) continue;
        revenue += o.amount;
        if (!o.promo_code) continue;
        const p = byCode.get(o.promo_code) ?? { code: o.promo_code, uses: 0, revenue: 0, discount: 0, newCustomers: 0 };
        p.uses++;
        p.revenue = round2(p.revenue + o.amount);
        p.discount = round2(p.discount + Math.max(0, (o.price_before ?? o.amount) - o.amount));
        if (o.isFirst) p.newCustomers++;
        byCode.set(o.promo_code, p);
    }
    const codes = [...byCode.values()].sort((a, b) => b.revenue - a.revenue);
    const promoRevenue = round2(codes.reduce((s, c) => s + c.revenue, 0));
    return { codes, revenueShare: ratio(promoRevenue, revenue), discount: round2(codes.reduce((s, c) => s + c.discount, 0)) };
}

// Напоминания, отправленные за период: оплатил ли клиент после напоминания —
// до окончания срока или в льготное окно после него
function reminders(data, range, now, graceDays) {
    const grace = graceDays * DAY_MS;
    const episodes = new Map();
    for (const r of data.reminders) {
        const key = `${r.userId}|${r.expireKey}`;
        const e = episodes.get(key) ?? { userId: r.userId, expire: r.expire, sends: [] };
        e.sends.push(r);
        episodes.set(key, e);
    }
    const byThreshold = new Map();
    let total = 0, renewed = 0, waiting = 0;
    for (const e of episodes.values()) {
        e.sends.sort((a, b) => a.sent - b.sent);
        if (!inRange(e.sends[0].sent, range)) continue;
        const payments = (data.users.get(e.userId)?.orders ?? []).filter((o) => o.paid != null).map((o) => o.paid);
        const paidAfter = (t) => payments.some((p) => p >= t && p <= e.expire + grace);
        const done = paidAfter(e.sends[0].sent);
        if (!done && e.expire + grace > now) waiting++;
        else {
            total++;
            if (done) renewed++;
        }
        e.sends.forEach((s, i) => {
            const t = byThreshold.get(s.daysBefore) ?? { daysBefore: s.daysBefore, sent: 0, paidWithinDay: 0 };
            t.sent++;
            // Оплата в течение суток после этого напоминания (и до следующего)
            const until = Math.min(s.sent + DAY_MS, e.sends[i + 1]?.sent ?? Infinity);
            if (payments.some((p) => p >= s.sent && p < until)) t.paidWithinDay++;
            byThreshold.set(s.daysBefore, t);
        });
    }
    return {
        episodes: total,
        renewed,
        waiting,
        rate: ratio(renewed, total),
        byThreshold: [...byThreshold.values()].sort((a, b) => b.daysBefore - a.daysBefore),
    };
}

// Когорты по месяцу первой оплаты: доля клиентов с оплаченной подпиской в конце каждого следующего месяца
function cohorts(data, now) {
    const monthKey = (t) => mskDate(t).slice(0, 7);
    const monthStart = (key, add = 0) => {
        const [y, m] = key.split('-').map(Number);
        const d = new Date(Date.UTC(y, m - 1 + add, 1));
        return mskMidnight(d.toISOString().slice(0, 10));
    };
    const current = monthKey(now);
    const first = monthKey(monthStart(current, -(COHORT_MONTHS - 1)));
    const groups = new Map();
    for (const u of data.users.values()) {
        if (u.firstPaid == null) continue;
        const key = monthKey(u.firstPaid);
        if (key < first) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(u);
    }
    return [...groups.entries()]
        .sort(([a], [b]) => (a < b ? 1 : -1))
        .map(([month, list]) => {
            const revenue = list.reduce((s, u) => s + u.paidOrders.reduce((x, o) => x + o.amount, 0), 0);
            const retention = [];
            for (let k = 1; k < COHORT_MONTHS; k++) {
                const at = monthStart(month, k + 1);
                // Текущий месяц ещё не закончился — доля на сегодня
                const t = Math.min(at, now);
                if (monthStart(month, k) > now) break;
                retention.push({ month: k, rate: list.filter((u) => covered(u, t - 1)).length / list.length, partial: at > now });
            }
            return { month, size: list.length, ltv: round2(revenue / list.length), retention };
        });
}

export function analytics(query = {}, now = Date.now()) {
    const period = parsePeriod(query, now);
    const { renewGraceDays } = getSettings();
    const data = load();
    const block = (range) => ({
        money: money(data, range, now),
        funnel: funnel(data, range),
        abandoned: abandoned(data, range),
        retention: retention(data, range, now, renewGraceDays),
        refunds: refunds(data, range),
    });
    return {
        period: { from: period.from, to: period.to, days: period.days },
        graceDays: renewGraceDays,
        current: block(period.cur),
        previous: block(period.prev),
        plans: plans(data, period.cur),
        promo: promo(data, period.cur),
        reminders: reminders(data, period.cur, now, renewGraceDays),
        cohorts: cohorts(data, now),
    };
}
