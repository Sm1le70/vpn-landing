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

    test('лимит использований считается по оплаченным заказам', () => {
        const p = promo({ maxUses: 2 });
        const [a, b, c] = [createUser(), createUser(), createUser()];
        createOrder(a.id, { status: 'pending', promo_code: p.code }); // не оплачен — не считается
        createOrder(b.id, { status: 'applied', promo_code: p.code });
        assert.ok(applyPromo(p.code, m1(), c.id));
        createOrder(a.id, { status: 'refunded', promo_code: p.code }); // возврат — использование было
        assert.throws(() => applyPromo(p.code, m1(), c.id), /исчерпаны/);
    });

    test('один раз на клиента', () => {
        const p = promo();
        const user = createUser();
        assert.ok(applyPromo(p.code, m1(), user.id));
        createOrder(user.id, { status: 'applied', promo_code: p.code });
        assert.throws(() => applyPromo(p.code, m1(), user.id), /уже воспользовались/);
        assert.ok(applyPromo(p.code, m1(), createUser().id), 'другому клиенту — можно');
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
