import './helpers/env.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addRemnaUser, addTransaction, failNext, fakes, resetFakes } from './helpers/fakes.js';
import { createOrder, createUser, daysBetween, getOrder } from './helpers/factories.js';
import { applyPaidOrder, getUserRow, markOrderPaid, syncOrderWithPlatega } from '../src/subscriptions.js';

beforeEach(resetFakes);

describe('markOrderPaid', () => {
    test('pending → paid', () => {
        const order = createOrder(createUser().id);
        assert.equal(markOrderPaid(order, { paymentDetails: { amount: 199 } }), true);
        assert.equal(getOrder(order.id).status, 'paid');
        assert.ok(getOrder(order.id).paid_at);
    });

    test('отменённый заказ тоже принимается (оплата пришла после автозакрытия)', () => {
        const order = createOrder(createUser().id, { status: 'canceled' });
        assert.equal(markOrderPaid(order, { paymentDetails: { amount: 199 } }), true);
        assert.equal(getOrder(order.id).status, 'paid');
    });

    test('повторная отметка ничего не меняет', () => {
        const order = createOrder(createUser().id, { status: 'applied' });
        assert.equal(markOrderPaid(order, { paymentDetails: { amount: 199 } }), false);
        assert.equal(getOrder(order.id).status, 'applied');
    });

    test('сумма меньше суммы заказа — заказ не оплачен, ошибка записана', () => {
        const order = createOrder(createUser().id, { amount: 549 });
        assert.equal(markOrderPaid(order, { paymentDetails: { amount: 199 } }), false);
        assert.equal(getOrder(order.id).status, 'pending');
        assert.equal(getOrder(order.id).error, 'amount mismatch');
    });

    test('копеечное расхождение допускается', () => {
        const order = createOrder(createUser().id, { amount: 199 });
        assert.equal(markOrderPaid(order, { paymentDetails: { amount: 198.995 } }), true);
    });

    // Текущее поведение: без суммы в ответе Platega заказ принимается. Задача 1.3 сделает сумму обязательной.
    test('без суммы в транзакции заказ принимается (до задачи 1.3)', () => {
        const order = createOrder(createUser().id);
        assert.equal(markOrderPaid(order, {}), true);
    });
});

describe('applyPaidOrder', () => {
    test('новый клиент: создаётся пользователь в панели на срок заказа, приходит письмо', async () => {
        const user = createUser();
        const order = createOrder(user.id, { status: 'paid', days: 30 });
        await applyPaidOrder(order.id);

        const u = getUserRow(user.id);
        assert.equal(getOrder(order.id).status, 'applied');
        assert.equal(u.plan_kind, 'paid');
        const rw = fakes.remnawave.users.get(u.rw_user_id);
        assert.ok(rw, 'пользователь создан в панели');
        assert.ok(Math.abs(daysBetween(new Date(), rw.expireAt) - 30) < 0.01);
        assert.equal(rw.hwidDeviceLimit, 3);
        assert.equal(u.expire_at, new Date(rw.expireAt).toISOString(), 'кэш срока обновлён');
        assert.equal(fakes.resend.sent.length, 1);
        assert.deepEqual(fakes.resend.sent[0].to, [user.email]);
        assert.match(fakes.resend.sent[0].text, new RegExp(rw.subscriptionUrl));
    });

    test('активная подписка продлевается от текущей даты окончания', async () => {
        const expireAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
        const rw = addRemnaUser({ expireAt });
        const user = createUser({ rw_user_id: rw.id, plan_kind: 'paid' });
        const order = createOrder(user.id, { status: 'paid', days: 30 });
        await applyPaidOrder(order.id);

        assert.equal(getOrder(order.id).status, 'applied');
        assert.ok(Math.abs(daysBetween(expireAt, rw.expireAt) - 30) < 0.001);
        assert.equal(rw.status, 'ACTIVE');
    });

    test('истёкшая подписка продлевается от сегодня и включается', async () => {
        const rw = addRemnaUser({ expireAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), status: 'EXPIRED' });
        const user = createUser({ rw_user_id: rw.id, plan_kind: 'paid' });
        const order = createOrder(user.id, { status: 'paid', days: 30 });
        await applyPaidOrder(order.id);

        assert.ok(Math.abs(daysBetween(new Date(), rw.expireAt) - 30) < 0.01);
        assert.equal(rw.status, 'ACTIVE');
    });

    test('пользователь удалён в панели — создаётся новый', async () => {
        const user = createUser({ rw_user_id: 999, plan_kind: 'paid' });
        const order = createOrder(user.id, { status: 'paid', days: 30 });
        await applyPaidOrder(order.id);

        assert.equal(getOrder(order.id).status, 'applied');
        assert.notEqual(getUserRow(user.id).rw_user_id, 999);
    });

    test('пробный клиент после оплаты становится платным: срок добавляется к пробному, лимит устройств платный', async () => {
        const trialEnd = new Date(Date.now() + 2 * 86_400_000).toISOString();
        const rw = addRemnaUser({ expireAt: trialEnd, hwidDeviceLimit: 1 });
        const user = createUser({ rw_user_id: rw.id, plan_kind: 'trial', trial_used_at: '2026-09-20 10:00:00' });
        const order = createOrder(user.id, { status: 'paid', days: 30 });
        await applyPaidOrder(order.id);

        assert.equal(getUserRow(user.id).plan_kind, 'paid');
        assert.equal(rw.hwidDeviceLimit, 3);
        assert.ok(Math.abs(daysBetween(trialEnd, rw.expireAt) - 30) < 0.001);
    });

    test('ответ панели потерян (таймаут): повтор не продлевает второй раз', async () => {
        const expireAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
        const rw = addRemnaUser({ expireAt });
        const user = createUser({ rw_user_id: rw.id, plan_kind: 'paid' });
        const order = createOrder(user.id, { status: 'paid', days: 30 });

        failNext('PATCH /api/users', 'lost-response');
        await applyPaidOrder(order.id);
        assert.equal(getOrder(order.id).status, 'paid', 'после таймаута заказ ждёт повтора');
        assert.ok(getOrder(order.id).error);
        assert.ok(Math.abs(daysBetween(expireAt, rw.expireAt) - 30) < 0.001, 'панель уже продлила');

        await applyPaidOrder(order.id);
        assert.equal(getOrder(order.id).status, 'applied');
        assert.equal(getOrder(order.id).error, null);
        assert.ok(Math.abs(daysBetween(expireAt, rw.expireAt) - 30) < 0.001, 'второй раз не продлено');
    });

    test('ошибка панели: заказ остаётся «оплачен», ошибка записана, повтор выдаёт доступ', async () => {
        const user = createUser();
        const order = createOrder(user.id, { status: 'paid', days: 30 });

        failNext('POST /api/users', 'error', 500);
        await applyPaidOrder(order.id);
        assert.equal(getOrder(order.id).status, 'paid');
        assert.match(getOrder(order.id).error, /500/);
        assert.equal(fakes.resend.sent.length, 0);

        await applyPaidOrder(order.id);
        assert.equal(getOrder(order.id).status, 'applied');
        assert.equal(fakes.remnawave.users.size, 1);
    });

    test('заказ не в статусе paid не выдаётся', async () => {
        const user = createUser();
        for (const status of ['pending', 'applied', 'canceled', 'refunded']) {
            const order = createOrder(user.id, { status });
            await applyPaidOrder(order.id);
            assert.equal(getOrder(order.id).status, status);
        }
        assert.equal(fakes.remnawave.requests.length, 0);
    });

    test('параллельные вызовы по одному заказу продлевают один раз', async () => {
        const expireAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
        const rw = addRemnaUser({ expireAt });
        const user = createUser({ rw_user_id: rw.id, plan_kind: 'paid' });
        const order = createOrder(user.id, { status: 'paid', days: 30 });
        await Promise.all([applyPaidOrder(order.id), applyPaidOrder(order.id), applyPaidOrder(order.id)]);

        assert.ok(Math.abs(daysBetween(expireAt, rw.expireAt) - 30) < 0.001);
        assert.equal(fakes.resend.sent.length, 1);
    });

    test('два разных заказа клиента продлевают дважды', async () => {
        const expireAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
        const rw = addRemnaUser({ expireAt });
        const user = createUser({ rw_user_id: rw.id, plan_kind: 'paid' });
        const a = createOrder(user.id, { status: 'paid', days: 30 });
        const b = createOrder(user.id, { status: 'paid', days: 90 });
        await Promise.all([applyPaidOrder(a.id), applyPaidOrder(b.id)]);

        assert.ok(Math.abs(daysBetween(expireAt, rw.expireAt) - 120) < 0.001);
    });
});

describe('syncOrderWithPlatega', () => {
    test('CONFIRMED — заказ оплачен и выдан', async () => {
        const user = createUser();
        const txId = addTransaction({ status: 'CONFIRMED', amount: 199 });
        const order = createOrder(user.id, { txId });
        const synced = await syncOrderWithPlatega(order);
        assert.equal(synced.status, 'applied');
        assert.ok(getUserRow(user.id).rw_user_id);
    });

    test('CANCELED — заказ отменён', async () => {
        const txId = addTransaction({ status: 'CANCELED' });
        const order = createOrder(createUser().id, { txId });
        assert.equal((await syncOrderWithPlatega(order)).status, 'canceled');
    });

    test('PENDING — без изменений', async () => {
        const txId = addTransaction({ status: 'PENDING' });
        const order = createOrder(createUser().id, { txId });
        assert.equal((await syncOrderWithPlatega(order)).status, 'pending');
    });

    test('заказ без транзакции или не pending в Platega не запрашивается', async () => {
        const user = createUser();
        await syncOrderWithPlatega(createOrder(user.id));
        await syncOrderWithPlatega(createOrder(user.id, { txId: addTransaction({ status: 'CONFIRMED' }), status: 'applied' }));
        assert.equal(fakes.platega.requests.length, 0);
    });

    test('Platega недоступна — ошибка пробрасывается, заказ не меняется', async () => {
        const txId = addTransaction({ status: 'CONFIRMED' });
        const order = createOrder(createUser().id, { txId });
        failNext('GET /transaction/', 'error', 503);
        await assert.rejects(syncOrderWithPlatega(order), /503/);
        assert.equal(getOrder(order.id).status, 'pending');
    });
});

describe('лимит устройств при оплате (задача 1.2)', () => {
    const renew = async (currentLimit) => {
        const rw = addRemnaUser({ hwidDeviceLimit: currentLimit });
        const user = createUser({ rw_user_id: rw.id, plan_kind: 'paid' });
        await applyPaidOrder(createOrder(user.id, { status: 'paid' }).id);
        return rw.hwidDeviceLimit;
    };

    test('индивидуальный лимит больше стандартного сохраняется', async () => {
        assert.equal(await renew(5), 5);
    });

    test('лимит меньше стандартного поднимается до стандартного', async () => {
        assert.equal(await renew(1), 3);
    });

    test('«без лимита» (0) сохраняется', async () => {
        assert.equal(await renew(0), 0);
    });
});
