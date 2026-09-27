import './helpers/env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrder, createUser, DAY_MS } from './helpers/factories.js';
import { db } from '../src/db.js';
import { analytics, parsePeriod } from '../src/admin/analytics.js';
import { saveSettings } from '../src/settings.js';

// «Сейчас» в тестах — 15 июня 2026, полдень по Москве
const NOW = Date.parse('2026-06-15T12:00:00+03:00');
// Время по Москве → формат базы (UTC)
const at = (msk) => new Date(Date.parse(`${msk}+03:00`)).toISOString().replace('T', ' ').slice(0, 19);
const JUNE = { from: '2026-06-01', to: '2026-06-14' };

const paidOrder = (user, msk, fields = {}) =>
    createOrder(user.id, { status: 'applied', created_at: at(msk), paid_at: at(msk), ...fields });

beforeEach(() => {
    db.exec('DELETE FROM expiry_reminders; DELETE FROM orders; DELETE FROM users');
    saveSettings({ renewGraceDays: 7 });
});

test('период: по умолчанию 30 суток по Москве, предыдущий — той же длины', () => {
    const p = parsePeriod({}, NOW);
    assert.equal(p.to, '2026-06-15');
    assert.equal(p.from, '2026-05-17');
    assert.equal(p.days, 30);
    assert.equal(p.cur[0], Date.parse('2026-05-17T00:00:00+03:00'));
    assert.equal(p.prev[1], p.cur[0]);
    assert.equal(p.cur[0] - p.prev[0], 30 * DAY_MS);
    assert.throws(() => parsePeriod({ from: '2026-06-10', to: '2026-06-01' }, NOW), /позже/);
    assert.throws(() => parsePeriod({ from: '2024-01-01', to: '2026-06-01' }, NOW), /не больше/);
    // Некорректные даты (в том числе несуществующий месяц) заменяются значениями по умолчанию
    assert.equal(parsePeriod({ from: '2026-02-30', to: 'вчера' }, NOW).to, '2026-06-15');
    assert.equal(parsePeriod({ from: '2025-13-01', to: '2026-00-10' }, NOW).from, '2026-05-17');
});

test('деньги: выручка, новые и повторные клиенты, средний чек, время до первой оплаты', () => {
    const a = createUser({ created_at: at('2026-05-01T10:00:00') });
    const b = createUser({ created_at: at('2026-06-02T10:00:00') });
    paidOrder(a, '2026-05-01T12:00:00', { amount: 199 });
    paidOrder(a, '2026-06-03T12:00:00', { amount: 199 });
    paidOrder(b, '2026-06-04T10:00:00', { amount: 549, planId: 'm3', days: 90 });
    // Не входят в выручку: не оплачен, возврат
    createOrder(b.id, { status: 'canceled', created_at: at('2026-06-04T09:00:00') });
    paidOrder(b, '2026-06-05T10:00:00', { amount: 199, status: 'refunded' });

    const { current: { money } } = analytics(JUNE, NOW);
    assert.equal(money.revenue, 748);
    assert.equal(money.payments, 2);
    assert.equal(money.payers, 2);
    assert.equal(money.avgCheck, 374);
    assert.equal(money.newCustomers, 1);
    assert.equal(money.newRevenue, 549);
    assert.equal(money.repeatRevenue, 199);
    assert.equal(money.timeToFirstPay, 2 * DAY_MS);
});

test('выручка в пересчёте на месяц: цена действующих заказов, разложенная по дням', () => {
    const a = createUser();
    // Действует на 15 июня: 549 ₽ за 90 дней → 183 ₽ в месяц; второй заказ продлевает после первого
    paidOrder(a, '2026-06-02T00:00:00', { amount: 549, days: 90 });
    paidOrder(a, '2026-06-03T00:00:00', { amount: 199, days: 30 });
    const { current: { money } } = analytics(JUNE, NOW);
    assert.equal(money.monthlyStart, 0);
    assert.equal(money.monthlyEnd, 183);
});

test('удержание: продлили вовремя, вернулись позже, ушли, ещё в льготном окне', () => {
    const renewed = createUser();
    paidOrder(renewed, '2026-04-02T12:00:00'); // до 2 мая
    paidOrder(renewed, '2026-05-06T12:00:00', { days: 90 }); // через 4 дня после окончания — вовремя

    const returned = createUser();
    paidOrder(returned, '2026-04-03T12:00:00'); // до 3 мая
    paidOrder(returned, '2026-05-20T12:00:00'); // через 17 дней — «вернулся»

    const churned = createUser();
    paidOrder(churned, '2026-04-04T12:00:00'); // до 4 мая, больше не платил

    const waiting = createUser();
    paidOrder(waiting, '2026-05-12T12:00:00'); // до 11 июня: льготные 7 дней ещё идут

    const r = analytics({ from: '2026-05-01', to: '2026-06-14' }, NOW).current.retention;
    // Вторые заказы renewed и returned заканчиваются после сегодняшнего дня и не считаются
    assert.equal(r.renewed, 1);
    assert.equal(r.returned, 1);
    assert.equal(r.churned, 1);
    assert.equal(r.waiting, 1);
    assert.equal(r.due, 3);
    assert.equal(r.renewalRate, 1 / 3);
});

test('удержание: льготное окно берётся из настроек', () => {
    const u = createUser();
    paidOrder(u, '2026-04-02T12:00:00'); // до 2 мая
    paidOrder(u, '2026-05-06T12:00:00');
    saveSettings({ renewGraceDays: 2 });
    const r = analytics({ from: '2026-05-01', to: '2026-05-10' }, NOW).current.retention;
    assert.equal(r.renewed, 0);
    assert.equal(r.returned, 1);
});

test('отток — доля клиентов с подпиской на начало периода, которые ушли', () => {
    const stays = createUser();
    paidOrder(stays, '2026-05-20T12:00:00', { days: 90 });
    const leaves = createUser();
    paidOrder(leaves, '2026-05-20T12:00:00', { days: 5 }); // до 25 мая
    const r = analytics({ from: '2026-05-21', to: '2026-06-14' }, NOW).current.retention;
    assert.equal(r.activeAtStart, 2);
    assert.equal(r.churnRate, 0.5);
});

test('воронка по клиентам, вошедшим за период, и брошенные оплаты', () => {
    const payer = createUser({ created_at: at('2026-06-02T10:00:00'), trial_used_at: at('2026-06-02T10:05:00') });
    createOrder(payer.id, { status: 'canceled', created_at: at('2026-06-03T10:00:00') });
    paidOrder(payer, '2026-06-03T11:00:00');
    const quitter = createUser({ created_at: at('2026-06-05T10:00:00') });
    createOrder(quitter.id, { status: 'canceled', created_at: at('2026-06-05T10:10:00') });
    createUser({ created_at: at('2026-06-06T10:00:00') });
    const waiting = createUser({ created_at: at('2026-06-14T10:00:00') });
    createOrder(waiting.id, { status: 'pending', created_at: at('2026-06-14T10:10:00') });
    createUser({ created_at: at('2026-05-01T10:00:00') }); // до периода

    const { funnel, abandoned } = analytics(JUNE, NOW).current;
    assert.deepEqual(funnel, { registered: 4, trial: 1, ordered: 3, paid: 1 });
    assert.equal(abandoned.created, 4);
    assert.equal(abandoned.canceled, 2);
    assert.equal(abandoned.pending, 1);
    assert.equal(abandoned.rate, 2 / 3);
    assert.equal(abandoned.users, 2);
    assert.equal(abandoned.recovered, 1);
});

test('аккаунт, созданный администратором, попадает в воронку с первого входа клиента', () => {
    // Выдан доступ в июне, клиент так и не входил — не в воронке и не в источниках
    createUser({ created_at: at('2026-06-02T10:00:00'), first_login_at: null });
    // Создан администратором в мае, клиент впервые вошёл в июне и оплатил через сутки
    const late = createUser({ created_at: at('2026-05-01T10:00:00'), first_login_at: at('2026-06-03T10:00:00') });
    paidOrder(late, '2026-06-04T10:00:00');

    const a = analytics(JUNE, NOW);
    assert.deepEqual(a.current.funnel, { registered: 1, trial: 0, ordered: 1, paid: 1 });
    assert.equal(a.current.money.timeToFirstPay, DAY_MS);
    assert.equal(a.sources.reduce((s, r) => s + r.clients, 0), 1);
});

test('возврат и chargeback — не оплата: ни в воронке, ни в конверсии пробного', () => {
    const refunded = createUser({ created_at: at('2026-06-02T10:00:00'), trial_used_at: at('2026-06-02T10:05:00') });
    paidOrder(refunded, '2026-06-03T10:00:00', { status: 'refunded' });
    const disputed = createUser({ created_at: at('2026-06-02T11:00:00') });
    paidOrder(disputed, '2026-06-03T11:00:00', { status: 'chargeback' });
    const { funnel, retention } = analytics(JUNE, NOW).current;
    assert.equal(funnel.registered, 2);
    assert.equal(funnel.paid, 0);
    assert.equal(retention.trialConverted, 0);
});

test('конверсия пробного периода — по начавшим пробный за период', () => {
    const conv = createUser({ trial_used_at: at('2026-06-02T10:00:00') });
    paidOrder(conv, '2026-06-06T10:00:00');
    createUser({ trial_used_at: at('2026-06-03T10:00:00') });
    const r = analytics(JUNE, NOW).current.retention;
    assert.equal(r.trials, 2);
    assert.equal(r.trialConverted, 1);
    assert.equal(r.trialRate, 0.5);
});

test('возвраты и chargeback — доля от оплаченного за период', () => {
    const u = createUser();
    paidOrder(u, '2026-06-02T10:00:00', { amount: 600 });
    paidOrder(u, '2026-06-03T10:00:00', { amount: 300, status: 'refunded' });
    paidOrder(u, '2026-06-04T10:00:00', { amount: 100, status: 'chargeback' });
    const { refunds } = analytics(JUNE, NOW).current;
    assert.equal(refunds.gross, 1000);
    assert.deepEqual(refunds.refunded, { count: 1, sum: 300, rate: 0.3 });
    assert.deepEqual(refunds.chargeback, { count: 1, sum: 100, rate: 0.1 });
});

test('тарифы и переходы между ними', () => {
    const u = createUser();
    paidOrder(u, '2026-05-01T10:00:00', { planId: 'm1', days: 30 });
    paidOrder(u, '2026-06-02T10:00:00', { planId: 'm3', days: 90, amount: 549 });
    const { plans } = analytics(JUNE, NOW);
    assert.deepEqual(plans.byPlan.map((p) => [p.planId, p.count, p.repeat]), [['m3', 1, 1]]);
    assert.deepEqual(plans.transitions.map((t) => [t.from, t.to, t.count]), [['1 месяц', '3 месяца', 1]]);
});

test('промокоды: выручка, скидка, новые клиенты', () => {
    const a = createUser();
    paidOrder(a, '2026-06-02T10:00:00', { amount: 149, promo_code: 'SALE', price_before: 199 });
    const b = createUser();
    paidOrder(b, '2026-05-02T10:00:00');
    paidOrder(b, '2026-06-03T10:00:00', { amount: 149, promo_code: 'SALE', price_before: 199 });
    paidOrder(b, '2026-06-04T10:00:00', { amount: 202 });
    const { promo } = analytics(JUNE, NOW);
    assert.deepEqual(promo.codes, [{ code: 'SALE', uses: 2, revenue: 298, discount: 100, newCustomers: 1 }]);
    assert.equal(promo.revenueShare, 0.596);
    assert.equal(promo.discount, 100);
});

test('напоминания: оплатил ли клиент после напоминания', () => {
    const addReminder = (user, expireMsk, daysBefore, sentMsk) =>
        db.prepare('INSERT INTO expiry_reminders (user_id, expire_at, days_before, sent_at) VALUES (?, ?, ?, ?)')
            .run(user.id, new Date(Date.parse(`${expireMsk}+03:00`)).toISOString(), daysBefore, at(sentMsk));
    const renewed = createUser();
    addReminder(renewed, '2026-06-05T12:00:00', 3, '2026-06-02T12:00:00');
    addReminder(renewed, '2026-06-05T12:00:00', 1, '2026-06-04T12:00:00');
    paidOrder(renewed, '2026-06-04T15:00:00');
    const silent = createUser();
    addReminder(silent, '2026-06-03T12:00:00', 1, '2026-06-02T12:00:00');
    const early = createUser(); // срок ещё не прошёл — решение не принято
    addReminder(early, '2026-06-16T12:00:00', 1, '2026-06-14T12:00:00');

    const r = analytics(JUNE, NOW).reminders;
    assert.equal(r.episodes, 2);
    assert.equal(r.renewed, 1);
    assert.equal(r.waiting, 1);
    assert.equal(r.rate, 0.5);
    const byDays = Object.fromEntries(r.byThreshold.map((t) => [t.daysBefore, t]));
    assert.deepEqual(byDays[3], { daysBefore: 3, sent: 1, paidWithinDay: 0 });
    assert.deepEqual(byDays[1], { daysBefore: 1, sent: 3, paidWithinDay: 1 });
});

test('когорты по месяцу первой оплаты: доля с подпиской в конце следующих месяцев', () => {
    const long = createUser();
    paidOrder(long, '2026-04-10T10:00:00', { days: 90 }); // до 9 июля
    const short = createUser();
    paidOrder(short, '2026-04-12T10:00:00', { days: 30, amount: 199 }); // до 12 мая
    const may = createUser();
    paidOrder(may, '2026-05-05T10:00:00');

    const { cohorts } = analytics(JUNE, NOW);
    assert.deepEqual(cohorts.map((c) => [c.month, c.size]), [['2026-05', 1], ['2026-04', 2]]);
    const april = cohorts[1];
    assert.equal(april.ltv, 199);
    // Конец мая: активен один из двух; июнь ещё идёт — доля на сегодня
    assert.deepEqual(april.retention, [{ month: 1, rate: 0.5, partial: false }, { month: 2, rate: 0.5, partial: true }]);
    assert.deepEqual(cohorts[0].retention, [{ month: 1, rate: 0, partial: true }]);
});
