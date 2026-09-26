import './helpers/env.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addRemnaUser, addTransaction, failNext, fakes, resetFakes } from './helpers/fakes.js';
import { ADMIN, SUPPORT, createOrder, createUser, daysBetween, getOrder, uniqueEmail } from './helpers/factories.js';
import { db } from '../src/db.js';
import { extendUser, grantAccess, refundOrder } from '../src/admin/service.js';
import { getUserRow, handleHwidDeviceAdded } from '../src/subscriptions.js';

beforeEach(resetFakes);

const lastAudit = () => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get();

// Клиент с подпиской в панели
function subscriber({ days = 10, status = 'ACTIVE', planKind = 'paid', hwidDeviceLimit = 3 } = {}) {
    const rw = addRemnaUser({ expireAt: new Date(Date.now() + days * 86_400_000).toISOString(), status, hwidDeviceLimit });
    const user = createUser({ rw_user_id: rw.id, plan_kind: planKind });
    return { user, rw };
}

describe('extendUser', () => {
    test('админ продлевает активную подписку от текущего срока, пишет журнал', async () => {
        const { user, rw } = subscriber({ days: 10 });
        const before = rw.expireAt;
        await extendUser(ADMIN, user.id, { days: 5, reason: 'компенсация' });

        assert.ok(Math.abs(daysBetween(before, rw.expireAt) - 5) < 0.001);
        const a = lastAudit();
        assert.equal(a.action, 'user.extend');
        assert.equal(a.reason, 'компенсация');
        assert.equal(a.target_id, String(user.id));
    });

    test('истёкшая подписка продлевается от сегодня и включается', async () => {
        const { user, rw } = subscriber({ days: -3, status: 'EXPIRED' });
        await extendUser(ADMIN, user.id, { days: 7, reason: 'компенсация' });
        assert.ok(Math.abs(daysBetween(new Date(), rw.expireAt) - 7) < 0.01);
        assert.equal(rw.status, 'ACTIVE');
    });

    test('сокращение срока; «в минус» — подписка истекает через минуту', async () => {
        const { user, rw } = subscriber({ days: 10 });
        const before = rw.expireAt;
        await extendUser(ADMIN, user.id, { days: -3, reason: 'ошибка' });
        assert.ok(Math.abs(daysBetween(before, rw.expireAt) + 3) < 0.001);
        assert.equal(lastAudit().action, 'user.shorten');

        await extendUser(ADMIN, user.id, { days: -100, reason: 'ошибка' });
        const left = new Date(rw.expireAt) - Date.now();
        assert.ok(left > 0 && left <= 60_000);
    });

    test('без подписки: админ создаёт, поддержка — нет', async () => {
        const user = createUser();
        await assert.rejects(extendUser(SUPPORT, user.id, { days: 3, reason: 'проверка' }), /Выдать доступ может только администратор/);
        assert.equal(fakes.remnawave.users.size, 0);

        await extendUser(ADMIN, user.id, { days: 3, reason: 'проверка' });
        const u = getUserRow(user.id);
        assert.equal(u.plan_kind, 'paid');
        assert.ok(Math.abs(daysBetween(new Date(), fakes.remnawave.users.get(u.rw_user_id).expireAt) - 3) < 0.01);
    });

    test('поддержка: только продление на 1–7 дней', async () => {
        const { user } = subscriber();
        await assert.rejects(async () => extendUser(SUPPORT, user.id, { days: 8, reason: 'проверка' }), /1–7/);
        await assert.rejects(async () => extendUser(SUPPORT, user.id, { days: -1, reason: 'проверка' }), /1–7/);
        await extendUser(SUPPORT, user.id, { days: 7, reason: 'проверка' });
    });

    test('проверка ввода: причина обязательна, дни — целое ненулевое', async () => {
        const { user } = subscriber();
        await assert.rejects(async () => extendUser(ADMIN, user.id, { days: 5, reason: '' }), /причину/);
        await assert.rejects(async () => extendUser(ADMIN, user.id, { days: 0, reason: 'проверка' }), /не 0/);
        await assert.rejects(async () => extendUser(ADMIN, user.id, { days: 1.5, reason: 'проверка' }), /не 0/);
        await assert.rejects(async () => extendUser(ADMIN, 999_999, { days: 5, reason: 'проверка' }), /не найден/);
        assert.equal(fakes.remnawave.requests.filter((r) => r.method === 'PATCH').length, 0);
    });

    test('уведомление клиенту — только с галочкой', async () => {
        const { user } = subscriber();
        await extendUser(ADMIN, user.id, { days: 5, reason: 'проверка' });
        assert.equal(fakes.resend.sent.length, 0);
        await extendUser(ADMIN, user.id, { days: 5, reason: 'проверка', notify: true });
        assert.equal(fakes.resend.sent.length, 1);
        assert.deepEqual(fakes.resend.sent[0].to, [user.email]);
    });
});

describe('grantAccess', () => {
    test('новый email: создаётся аккаунт и подписка по тарифу', async () => {
        const email = uniqueEmail('grant');
        const { userId } = await grantAccess(ADMIN, { email: email.toUpperCase(), planId: 'm3', reason: 'партнёр' });
        const u = getUserRow(userId);
        assert.equal(u.email, email);
        assert.equal(u.plan_kind, 'paid');
        assert.ok(Math.abs(daysBetween(new Date(), fakes.remnawave.users.get(u.rw_user_id).expireAt) - 90) < 0.01);
        assert.equal(lastAudit().action, 'user.grant');
    });

    test('существующая подписка: дни добавляются', async () => {
        const { user, rw } = subscriber({ days: 10 });
        const before = rw.expireAt;
        await grantAccess(ADMIN, { email: user.email, days: 14, reason: 'партнёр' });
        assert.ok(Math.abs(daysBetween(before, rw.expireAt) - 14) < 0.001);
    });

    test('только для роли «Администратор»', async () => {
        await assert.rejects(grantAccess(SUPPORT, { email: uniqueEmail(), days: 3, reason: 'проверка' }), /Недостаточно прав/);
    });
});

describe('refundOrder', () => {
    function paidOrder({ status = 'applied', days = 30 } = {}) {
        const { user, rw } = subscriber({ days: 40 });
        const txId = addTransaction({ status: 'CONFIRMED', amount: 199 });
        const order = createOrder(user.id, { status, days, txId });
        return { user, rw, order };
    }

    test('возврат с «снять дни»: заказ refunded, срок уменьшен на дни заказа', async () => {
        const { rw, order } = paidOrder({ days: 30 });
        const before = rw.expireAt;
        const res = await refundOrder(ADMIN, order.id, { subscriptionAction: 'remove_days', reason: 'просьба клиента' });

        assert.equal(res.status, 'refunded');
        const o = getOrder(order.id);
        assert.equal(o.status, 'refunded');
        assert.ok(o.refunded_at);
        assert.ok(Math.abs(daysBetween(before, rw.expireAt) + 30) < 0.001);
        assert.equal(lastAudit().action, 'order.refund');
    });

    test('«отключить»: подписка отключена, клиент заблокирован', async () => {
        const { user, rw, order } = paidOrder();
        await refundOrder(ADMIN, order.id, { subscriptionAction: 'disable', reason: 'мошенничество' });
        assert.equal(rw.status, 'DISABLED');
        assert.equal(getUserRow(user.id).blocked, 1);
    });

    test('заказ «Оплачен, выдаётся»: дни не снимаются — они не начислялись', async () => {
        const { rw, order } = paidOrder({ status: 'paid' });
        const before = rw.expireAt;
        const res = await refundOrder(ADMIN, order.id, { subscriptionAction: 'remove_days', reason: 'просьба клиента' });
        assert.equal(res.status, 'refunded');
        assert.deepEqual(res.subscription, { skipped: 'дни по заказу не начислялись' });
        assert.equal(rw.expireAt, before);
    });

    test('повторный возврат того же заказа отклоняется', async () => {
        const { order } = paidOrder();
        await refundOrder(ADMIN, order.id, { subscriptionAction: 'keep', reason: 'просьба клиента' });
        await assert.rejects(refundOrder(ADMIN, order.id, { subscriptionAction: 'keep', reason: 'просьба клиента' }), /только для оплаченного/);
        assert.equal(fakes.platega.requests.filter((r) => r.path.endsWith('/cancel')).length, 1);
    });

    test('Platega требует ручной обработки — «Возврат в обработке»', async () => {
        const { order } = paidOrder();
        fakes.platega.refund = { supported: true, accepted: false, manualControlRequired: true };
        const res = await refundOrder(ADMIN, order.id, { subscriptionAction: 'keep', reason: 'просьба клиента' });
        assert.equal(res.status, 'refund_pending');
        assert.equal(getOrder(order.id).status, 'refund_pending');
    });

    test('Platega отклонила возврат — статус заказа возвращается', async () => {
        const { order } = paidOrder();
        fakes.platega.refund = { supported: true, accepted: false, manualControlRequired: false };
        await assert.rejects(refundOrder(ADMIN, order.id, { subscriptionAction: 'keep', reason: 'просьба клиента' }), /отклонила/);
        assert.equal(getOrder(order.id).status, 'applied');
    });

    test('возврат не поддерживается — Platega /cancel не вызывается', async () => {
        const { order } = paidOrder();
        fakes.platega.refund = { supported: false };
        await assert.rejects(refundOrder(ADMIN, order.id, { subscriptionAction: 'keep', reason: 'просьба клиента' }), /невозможен/);
        assert.equal(getOrder(order.id).status, 'applied');
        assert.equal(fakes.platega.requests.filter((r) => r.path.endsWith('/cancel')).length, 0);
    });

    test('ответ Platega на /cancel не получен — заказ остаётся «Возврат в обработке», повтор невозможен', async () => {
        const { order } = paidOrder();
        failNext('POST /transaction/', 'lost-response');
        await assert.rejects(refundOrder(ADMIN, order.id, { subscriptionAction: 'keep', reason: 'просьба клиента' }), /Ответ Platega не получен/);
        assert.equal(getOrder(order.id).status, 'refund_pending');
        await assert.rejects(refundOrder(ADMIN, order.id, { subscriptionAction: 'keep', reason: 'просьба клиента' }), /только для оплаченного/);
    });

    test('поддержка не может делать возвраты', async () => {
        const { order } = paidOrder();
        await assert.rejects(refundOrder(SUPPORT, order.id, { subscriptionAction: 'keep', reason: 'просьба клиента' }), /Недостаточно прав/);
    });
});

describe('продление пробного клиента (задача 1.1)', () => {
    const trialSubscriber = (fields = {}) => {
        const rw = addRemnaUser({ expireAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), hwidDeviceLimit: 1, ...fields });
        const user = createUser({ rw_user_id: rw.id, plan_kind: 'trial', trial_used_at: '2026-09-25 10:00:00' });
        return { user, rw };
    };

    test('админ продлевает пробного — клиент становится платным, лимит устройств платный', async () => {
        const { user, rw } = trialSubscriber();
        await extendUser(ADMIN, user.id, { days: 30, reason: 'проверка' });
        assert.equal(getUserRow(user.id).plan_kind, 'paid');
        assert.equal(rw.hwidDeviceLimit, 3);
        const { before, after } = JSON.parse(lastAudit().details);
        assert.equal(before.planKind, 'trial');
        assert.equal(after.planKind, 'paid');
    });

    test('выдача доступа пробному — то же самое', async () => {
        const { user, rw } = trialSubscriber();
        await grantAccess(ADMIN, { email: user.email, days: 30, reason: 'проверка' });
        assert.equal(getUserRow(user.id).plan_kind, 'paid');
        assert.equal(rw.hwidDeviceLimit, 3);
    });

    test('поддержка продлевает пробного на 1–7 дней — тоже переводит в платные', async () => {
        const { user, rw } = trialSubscriber();
        await extendUser(SUPPORT, user.id, { days: 3, reason: 'проверка' });
        assert.equal(getUserRow(user.id).plan_kind, 'paid');
        assert.equal(rw.hwidDeviceLimit, 3);
    });

    test('пробный, отключённый проверкой устройств, после продления включается', async () => {
        const { user, rw } = trialSubscriber({ status: 'DISABLED' });
        db.prepare('UPDATE users SET trial_blocked = 1 WHERE id = ?').run(user.id);
        await extendUser(ADMIN, user.id, { days: 30, reason: 'проверка' });
        assert.equal(rw.status, 'ACTIVE');
        assert.equal(getUserRow(user.id).trial_blocked, 0);
    });

    test('после перевода в платные проверка устройств пробного периода подписку не отключает', async () => {
        const { user, rw } = trialSubscriber();
        db.prepare("INSERT INTO trial_hwids (hwid, user_id) VALUES ('shared-hwid', ?)").run(createUser().id);
        await extendUser(ADMIN, user.id, { days: 30, reason: 'проверка' });
        await handleHwidDeviceAdded(rw.id, 'shared-hwid');
        assert.equal(rw.status, 'ACTIVE');
    });

    test('сокращение срока пробного — остаётся пробным', async () => {
        const { user, rw } = trialSubscriber();
        await extendUser(ADMIN, user.id, { days: -1, reason: 'проверка' });
        assert.equal(getUserRow(user.id).plan_kind, 'trial');
        assert.equal(rw.hwidDeviceLimit, 1);
    });

    test('продление платного клиента лимит устройств не трогает', async () => {
        const { user, rw } = subscriber({ hwidDeviceLimit: 5 });
        await extendUser(ADMIN, user.id, { days: 30, reason: 'проверка' });
        assert.equal(rw.hwidDeviceLimit, 5);
    });

    test('отключённый администратором клиент после продления остаётся отключённым', async () => {
        const { user, rw } = trialSubscriber({ status: 'DISABLED' });
        db.prepare('UPDATE users SET trial_blocked = 1, blocked = 1 WHERE id = ?').run(user.id);
        await extendUser(ADMIN, user.id, { days: 30, reason: 'проверка' });
        assert.equal(rw.status, 'DISABLED');
    });
});
