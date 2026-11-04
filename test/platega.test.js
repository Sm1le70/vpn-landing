import './helpers/env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakes, resetFakes } from './helpers/fakes.js';
import { createPayment } from '../src/platega.js';

beforeEach(resetFakes);

const payment = { orderId: 'order-1', amount: 199, description: 'Подписка', userId: 42, email: 'buyer@example.com' };

test('Platega получает настоящий email в metadata.user_email при каждой оплате клиента', async () => {
    const first = await createPayment(payment);
    const second = await createPayment({ ...payment, orderId: 'order-2' });

    assert.notEqual(first.transactionId, second.transactionId);
    assert.equal(fakes.platega.requests.length, 2);
    for (const [index, request] of fakes.platega.requests.entries()) {
        assert.equal(request.method, 'POST');
        assert.equal(request.path, '/v2/transaction/process');
        assert.equal(request.body.metadata.user_email, payment.email);
        assert.equal(request.body.payload, `order-${index + 1}`);
        assert.deepEqual(request.body.paymentDetails, { amount: 199, currency: 'RUB' });
    }
});

test('Platega не получает запрос с пустым или некорректным email', async () => {
    for (const email of [undefined, null, '', 'buyer', 'buyer@', 'buyer@example.com ', 'buyer @example.com', `${'a'.repeat(243)}@example.com`]) {
        await assert.rejects(createPayment({ ...payment, email }), /необходим корректный email/);
    }
    assert.equal(fakes.platega.requests.length, 0);
});
