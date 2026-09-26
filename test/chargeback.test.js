import './helpers/env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { addRemnaUser, addTransaction, failNext, fakes, resetFakes } from './helpers/fakes.js';
import { createOrder, createUser, daysBetween, getOrder } from './helpers/factories.js';
import { db } from '../src/db.js';
import { applyChargeback } from '../src/admin/service.js';
import { applyPaidOrder } from '../src/subscriptions.js';

beforeEach(() => {
    resetFakes();
    db.exec('DELETE FROM alerts');
});

const alertsFor = (orderId) => db.prepare('SELECT * FROM alerts WHERE dedup_key = ?').all(`chargeback:${orderId}`);
const auditFor = (orderId) => db.prepare("SELECT * FROM audit_log WHERE action = 'order.chargeback' AND target_id = ?").all(orderId);

function subscriberOrder({ status = 'applied', days = 30, txStatus = 'CHARGEBACKED' } = {}) {
    const rw = addRemnaUser({ expireAt: new Date(Date.now() + 40 * 86_400_000).toISOString() });
    const user = createUser({ rw_user_id: rw.id, plan_kind: 'paid' });
    const txId = addTransaction({ status: txStatus, amount: 199 });
    return { rw, user, order: createOrder(user.id, { status, days, txId }) };
}

test('выданный заказ: дни снимаются, статус chargeback, журнал и алерт', async () => {
    const { rw, user, order } = subscriberOrder({ days: 30 });
    const before = rw.expireAt;
    await applyChargeback(order);

    assert.equal(getOrder(order.id).status, 'chargeback');
    assert.ok(Math.abs(daysBetween(before, rw.expireAt) + 30) < 0.001);
    assert.equal(rw.status, 'ACTIVE', 'подписка не отключается — решает админ');

    const [a] = auditFor(order.id);
    assert.equal(a.admin_login, 'system');
    assert.equal(JSON.parse(a.details).before, 'applied');
    const [al] = alertsFor(order.id);
    assert.match(al.text, /Chargeback/);
    assert.match(al.text, new RegExp(`Пользователь #${user.id}`));
    assert.match(al.text, /снято 30 дн/);
    assert.equal(al.link, `http://localhost:3000/admin-test/#/users/${user.id}`);
});

test('повторный callback ничего не меняет', async () => {
    const { rw, order } = subscriberOrder({ days: 30 });
    await applyChargeback(order);
    const after = rw.expireAt;
    await applyChargeback(getOrder(order.id));
    assert.equal(rw.expireAt, after);
    assert.equal(auditFor(order.id).length, 1);
    assert.equal(alertsFor(order.id).length, 1);
});

test('оплачен, но ещё не выдан: дни не снимаются, выдача больше не произойдёт', async () => {
    const { rw, order } = subscriberOrder({ status: 'paid' });
    const before = rw.expireAt;
    await applyChargeback(order);
    assert.equal(getOrder(order.id).status, 'chargeback');
    assert.equal(rw.expireAt, before);
    assert.match(alertsFor(order.id)[0].text, /дни не начислялись/);

    await applyPaidOrder(order.id);
    assert.equal(rw.expireAt, before);
});

test('наш возврат: заказ refunded, дни не трогаются, без алерта', async () => {
    for (const status of ['refund_pending', 'refunded']) {
        const { rw, order } = subscriberOrder({ status });
        const before = rw.expireAt;
        await applyChargeback(order);
        assert.equal(getOrder(order.id).status, 'refunded');
        assert.equal(rw.expireAt, before);
        assert.equal(alertsFor(order.id).length, 0);
    }
});

test('Platega не подтверждает chargeback — ничего не меняется', async () => {
    const { rw, order } = subscriberOrder({ txStatus: 'CONFIRMED' });
    const before = rw.expireAt;
    await applyChargeback(order);
    assert.equal(getOrder(order.id).status, 'applied');
    assert.equal(rw.expireAt, before);
});

test('панель не ответила при снятии дней — chargeback записан, в алерте просьба снять вручную', async () => {
    const { rw, order } = subscriberOrder();
    const before = rw.expireAt;
    failNext('PATCH /api/users', 'error', 500);
    await applyChargeback(order);
    assert.equal(getOrder(order.id).status, 'chargeback');
    assert.equal(rw.expireAt, before);
    assert.match(alertsFor(order.id)[0].text, /снимите 30 дн\. вручную/);
    assert.ok(JSON.parse(auditFor(order.id)[0].details).subscription.error);
});

test('подписки в панели нет — chargeback записан, снимать нечего', async () => {
    const user = createUser();
    const order = createOrder(user.id, { status: 'applied', txId: addTransaction({ status: 'CHARGEBACKED' }) });
    await applyChargeback(order);
    assert.equal(getOrder(order.id).status, 'chargeback');
    assert.equal(fakes.remnawave.requests.filter((r) => r.method === 'PATCH').length, 0);
});
