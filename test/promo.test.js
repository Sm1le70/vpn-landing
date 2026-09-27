import './helpers/env.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetFakes } from './helpers/fakes.js';
import { createOrder, createUser } from './helpers/factories.js';
import { db } from '../src/db.js';
import { applyPromo, createPromo, discountedPrice, listPromos, updatePromo } from '../src/promo.js';
import { getPlan } from '../src/settings.js';

beforeEach(() => {
    resetFakes();
    db.exec('DELETE FROM promo_codes; DELETE FROM orders');
});

const m1 = () => getPlan('m1'); // 199 ₽
const m3 = () => getPlan('m3'); // 549 ₽
const promo = (fields = {}) => createPromo({ code: `CODE${Math.random().toString(36).slice(2, 8)}`, kind: 'percent', value: 20, ...fields }, 1);
const DAY = 86_400_000;

describe('цена со скидкой', () => {
    test('процент и рубли, округление до копеек, не ниже 1 ₽', () => {
        assert.equal(discountedPrice(199, { kind: 'percent', value: 20 }), 159.2);
        assert.equal(discountedPrice(199, { kind: 'percent', value: 33 }), 133.33);
        assert.equal(discountedPrice(549, { kind: 'fixed', value: 100 }), 449);
        assert.equal(discountedPrice(199, { kind: 'percent', value: 100 }), 1);
        assert.equal(discountedPrice(199, { kind: 'fixed', value: 500 }), 1);
    });
});

describe('applyPromo', () => {
    test('код без учёта регистра и пробелов', () => {
        const p = promo({ code: 'SPRING20' });
        const r = applyPromo('  spring20 ', m1(), createUser().id);
        assert.deepEqual(r, { code: 'SPRING20', price: 159.2, priceBefore: 199 });
        assert.ok(p);
    });

    test('неизвестный, выключенный, не начавшийся, истёкший', () => {
        const user = createUser().id;
        assert.throws(() => applyPromo('NOPE', m1(), user), /не найден/);
        const off = promo({ active: false });
        assert.throws(() => applyPromo(off.code, m1(), user), /не найден/);
        const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
        const later = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
        const early = new Date(Date.now() - 5 * DAY).toISOString().slice(0, 10);
        assert.throws(() => applyPromo(promo({ validFrom: later }).code, m1(), user), /ещё не действует/);
        assert.throws(() => applyPromo(promo({ validUntil: early }).code, m1(), user), /истёк/);
        assert.ok(applyPromo(promo({ validFrom: today, validUntil: today }).code, m1(), user), 'действует весь день по Москве');
    });

    test('только для выбранных тарифов', () => {
        const p = promo({ planIds: ['m3'] });
        const user = createUser().id;
        assert.throws(() => applyPromo(p.code, m1(), user), /для этого тарифа/);
        assert.equal(applyPromo(p.code, m3(), user).price, 439.2);
    });

    test('лимит использований: оплаченные заказы и заказы, которые ещё можно оплатить', () => {
        const now = Date.now();
        const p = promo({ maxUses: 2 });
        const [a, b, c] = [createUser(), createUser(), createUser()];
        // Ссылка на оплату истекла — не считается
        createOrder(a.id, { status: 'pending', promo_code: p.code, payment_url: 'https://pay.test/1', payment_expires_at: new Date(now - 1000).toISOString() });
        createOrder(b.id, { status: 'applied', promo_code: p.code });
        assert.ok(applyPromo(p.code, m1(), c.id, now));
        createOrder(a.id, { status: 'refunded', promo_code: p.code }); // возврат — использование было
        assert.throws(() => applyPromo(p.code, m1(), c.id, now), /исчерпаны/);
    });

    test('лимит использований: неоплаченные заказы не дают превысить лимит', () => {
        const now = Date.now();
        const p = promo({ maxUses: 1 });
        // Первый клиент создал заказ, ссылка на оплату действует — второй код уже не получит
        createOrder(createUser().id, { promo_code: p.code, payment_url: 'https://pay.test/1', payment_expires_at: new Date(now + 3_600_000).toISOString() });
        assert.throws(() => applyPromo(p.code, m1(), createUser().id, now), /исчерпаны/);
    });

    test('один раз на клиента', () => {
        const p = promo();
        const user = createUser();
        assert.ok(applyPromo(p.code, m1(), user.id));
        createOrder(user.id, { status: 'applied', promo_code: p.code });
        assert.throws(() => applyPromo(p.code, m1(), user.id), /уже воспользовались/);
        assert.ok(applyPromo(p.code, m1(), createUser().id), 'другому клиенту — можно');
    });

    test('один раз на клиента: второй заказ, пока первый можно оплатить, не получает скидку', () => {
        const p = promo();
        const user = createUser();
        const now = Date.now();
        // Платёж ещё создаётся (ссылки нет)
        const o = createOrder(user.id, { promo_code: p.code });
        assert.throws(() => applyPromo(p.code, m1(), user.id, now), /неоплаченному заказу/);
        // Ссылка действует — тоже нельзя; другому клиенту можно
        db.prepare('UPDATE orders SET payment_url = ?, payment_expires_at = ? WHERE id = ?').run('https://pay.test/1', new Date(now + 3_600_000).toISOString(), o.id);
        assert.throws(() => applyPromo(p.code, m1(), user.id, now), /неоплаченному заказу/);
        assert.ok(applyPromo(p.code, m1(), createUser().id, now));
        // Ссылка истекла — код снова доступен
        db.prepare('UPDATE orders SET payment_expires_at = ? WHERE id = ?').run(new Date(now - 1000).toISOString(), o.id);
        assert.ok(applyPromo(p.code, m1(), user.id, now));
        // Заказ не оплачен и закрыт — тоже доступен
        db.prepare("UPDATE orders SET status = 'canceled', payment_expires_at = NULL WHERE id = ?").run(o.id);
        assert.ok(applyPromo(p.code, m1(), user.id, now));
    });
});

describe('админка', () => {
    test('проверка полей при создании', () => {
        assert.throws(() => promo({ code: 'ab' }), /3–32 символа/);
        assert.throws(() => promo({ code: 'ПРИВЕТ' }), /латинские/);
        assert.throws(() => promo({ value: 150 }), /от 1 до 100/);
        assert.throws(() => promo({ kind: 'fixed', value: 0 }), /от 1 ₽/);
        assert.throws(() => promo({ planIds: ['nope'] }), /не найден/);
        assert.throws(() => promo({ validFrom: '2026-10-10', validUntil: '2026-10-01' }), /позже/);
        assert.throws(() => promo({ maxUses: 0 }), /от 1/);
        promo({ code: 'DUP1' });
        assert.throws(() => promo({ code: 'dup1' }), /уже есть/);
    });

    test('изменение: код не меняется; список с числом использований и выручкой', () => {
        const p = promo({ code: 'EDIT1' });
        const { after } = updatePromo(p.id, { code: 'OTHER', kind: 'fixed', value: 50, active: false });
        assert.equal(after.code, 'EDIT1');
        assert.equal(after.kind, 'fixed');
        assert.equal(after.active, false);
        const user = createUser();
        createOrder(user.id, { status: 'applied', amount: 149, promo_code: 'EDIT1' });
        const row = listPromos().find((x) => x.code === 'EDIT1');
        assert.equal(row.uses, 1);
        assert.equal(row.revenue, 149);
    });
});
