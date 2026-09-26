import './helpers/env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrder, createUser } from './helpers/factories.js';
import { db } from '../src/db.js';
import { listOrders, stats } from '../src/admin/service.js';

const HOUR = 3_600_000;
const MSK = 3 * HOUR;
const sqlUtc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
// Полночь сегодняшних суток по Москве, мс UTC
const mskMidnight = () => {
    const d = new Date(Date.now() + MSK);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime() - MSK;
};
const mskDate = (ms) => new Date(ms + MSK).toISOString().slice(0, 10);

let early; // сегодня 00:30 МСК = вчера 21:30 UTC
let late; // вчера 23:30 МСК

beforeEach(() => {
    db.exec('DELETE FROM orders');
    const user = createUser();
    early = mskMidnight() + 0.5 * HOUR;
    late = mskMidnight() - 0.5 * HOUR;
    createOrder(user.id, { status: 'applied', amount: 100, paid_at: sqlUtc(early), created_at: sqlUtc(early) });
    createOrder(user.id, { status: 'applied', amount: 1000, paid_at: sqlUtc(late), created_at: sqlUtc(late) });
});

test('«сегодня» — с полуночи по Москве', () => {
    const s = stats();
    assert.equal(s.revenue.today.sum, 100);
    assert.equal(s.revenue.today.n, 1);
    assert.equal(s.revenue.week.sum, 1100);
});

test('график по дням — по московской дате', () => {
    const { daily } = stats();
    assert.equal(daily.length, 30);
    assert.equal(daily.at(-1).day, mskDate(Date.now()));
    assert.equal(daily.at(-1).sum, 100);
    assert.equal(daily.at(-2).day, mskDate(Date.now() - 24 * HOUR));
    assert.equal(daily.at(-2).sum, 1000);
});

test('фильтр платежей по датам — по московским суткам', () => {
    const today = mskDate(Date.now());
    const yesterday = mskDate(Date.now() - 24 * HOUR);
    assert.deepEqual(listOrders({ from: today }).items.map((o) => o.amount), [100]);
    assert.deepEqual(listOrders({ to: yesterday }).items.map((o) => o.amount), [1000]);
    assert.equal(listOrders({ from: yesterday, to: today }).total, 2);
});

test('некорректная дата в фильтре игнорируется', () => {
    assert.equal(listOrders({ from: 'вчера', to: '2026-13-45' }).total, 2);
});
