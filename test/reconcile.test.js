import './helpers/env.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addTransaction, fakes, resetFakes } from './helpers/fakes.js';
import { createOrder, createUser, getOrder } from './helpers/factories.js';
import { db } from '../src/db.js';
import { awaitingPayment, reconcileOrders } from '../src/subscriptions.js';

// Отдельный файл — отдельная база: заказы других тестов не попадают в выборки сверки
beforeEach(() => {
    resetFakes();
    db.exec('DELETE FROM orders');
});

const HOUR = 60 * 60_000;
// Время в формате datetime('now') SQLite, hours часов назад
const sqlAgo = (hours) => new Date(Date.now() - hours * HOUR).toISOString().replace('T', ' ').slice(0, 19);
const isoFromNow = (hours) => new Date(Date.now() + hours * HOUR).toISOString();

// Неоплаченный заказ возрастом ageHours; status — статус транзакции в Platega
function pendingOrder(ageHours, { status = 'CONFIRMED', expiresInHours } = {}) {
    const txId = addTransaction({ status, amount: 199 });
    const fields = { txId, created_at: sqlAgo(ageHours) };
    if (expiresInHours !== undefined) fields.payment_expires_at = isoFromNow(expiresInHours);
    return createOrder(createUser().id, fields);
}

const plategaChecks = (order) => fakes.platega.requests.filter((r) => r.path === `/transaction/${order.platega_tx_id}`).length;

describe('reconcileOrders', () => {
    test('заказ младше 2 ч сверяется каждый раз', async () => {
        const order = pendingOrder(0.5);
        await reconcileOrders();
        assert.equal(getOrder(order.id).status, 'applied');
    });

    test('заказ младше 3 минут не сверяется — ждём callback', async () => {
        const order = pendingOrder(0.01);
        await reconcileOrders({ slow: true });
        assert.equal(getOrder(order.id).status, 'pending');
        assert.equal(plategaChecks(order), 0);
    });

    test('заказ 5 ч, срок ссылки неизвестен: только медленная сверка', async () => {
        const order = pendingOrder(5);
        await reconcileOrders();
        assert.equal(getOrder(order.id).status, 'pending');
        assert.equal(plategaChecks(order), 0);

        await reconcileOrders({ slow: true });
        assert.equal(getOrder(order.id).status, 'applied');
    });

    test('заказ 5 ч, ссылка истекла 30 мин назад (в пределах запаса) — сверяется', async () => {
        const order = pendingOrder(5, { expiresInHours: -0.5 });
        await reconcileOrders({ slow: true });
        assert.equal(getOrder(order.id).status, 'applied');
    });

    test('заказ 5 ч, ссылка истекла 4 ч назад — не сверяется', async () => {
        const order = pendingOrder(5, { expiresInHours: -4 });
        await reconcileOrders({ slow: true });
        assert.equal(getOrder(order.id).status, 'pending');
        assert.equal(plategaChecks(order), 0);
    });

    test('заказ старше суток: оплачен — выдаётся, не оплачен — закрывается', async () => {
        const paid = pendingOrder(25);
        const unpaid = pendingOrder(25, { status: 'PENDING' });
        await reconcileOrders();
        assert.equal(getOrder(paid.id).status, 'applied');
        assert.equal(getOrder(unpaid.id).status, 'canceled');
        assert.equal(getOrder(unpaid.id).error, 'не оплачен вовремя');
    });

    test('заказ «оплачен, выдаётся» выдаётся повторно', async () => {
        const order = createOrder(createUser().id, { status: 'paid' });
        await reconcileOrders();
        assert.equal(getOrder(order.id).status, 'applied');
    });
});

describe('awaitingPayment', () => {
    const now = Date.now();
    test('по сроку ссылки с запасом в час', () => {
        assert.equal(awaitingPayment({ payment_expires_at: new Date(now + HOUR).toISOString() }, now), true);
        assert.equal(awaitingPayment({ payment_expires_at: new Date(now - 0.9 * HOUR).toISOString() }, now), true);
        assert.equal(awaitingPayment({ payment_expires_at: new Date(now - 1.1 * HOUR).toISOString() }, now), false);
    });

    test('срок неизвестен — пока заказ младше суток', () => {
        assert.equal(awaitingPayment({ created_at: sqlAgo(23) }, now), true);
        assert.equal(awaitingPayment({ created_at: sqlAgo(25) }, now), false);
    });
});
