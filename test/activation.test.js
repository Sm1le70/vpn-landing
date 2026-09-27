import './helpers/env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { addRemnaUser, fakes, failNext, resetFakes } from './helpers/fakes.js';
import { createOrder, createUser, DAY_MS } from './helpers/factories.js';
import { db } from '../src/db.js';
import { clearRemnawaveCache } from '../src/remnawave.js';
import { activityOf, createRemnaUser, getUserRow, refreshCachedSubscriptions } from '../src/subscriptions.js';
import { listUsers } from '../src/admin/service.js';
import { analytics } from '../src/admin/analytics.js';
import { saveSettings } from '../src/settings.js';

const HOUR = 3_600_000;
const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const iso = (ms) => new Date(ms).toISOString();
const traffic = (fields = {}) => ({ usedTrafficBytes: 0, lifetimeUsedTrafficBytes: 0, onlineAt: null, firstConnectedAt: null, lastConnectedNodeUuid: null, ...fields });

beforeEach(() => {
    resetFakes();
    clearRemnawaveCache();
    db.exec('DELETE FROM orders; DELETE FROM users');
    saveSettings({ activationHours: 24 });
});

// Клиент с подпиской в панели; paidAgoMs — когда оплатил
function subscriber({ userTraffic = traffic(), paidAgoMs = 2 * DAY_MS, fields = {} } = {}) {
    const rw = addRemnaUser({ status: 'ACTIVE', expireAt: iso(Date.now() + 20 * DAY_MS), userTraffic });
    const user = createUser({ rw_user_id: rw.id, rw_status: 'ACTIVE', expire_at: rw.expireAt, plan_kind: 'paid', ...fields });
    createOrder(user.id, { status: 'applied', paid_at: sql(Date.now() - paidAgoMs) });
    return { rw, user };
}

test('данные об использовании: из userTraffic, со старых панелей — с верхнего уровня, без данных — null', () => {
    const t = Date.parse('2026-09-01T10:00:00Z');
    assert.deepEqual(activityOf({ id: 1, userTraffic: traffic({ firstConnectedAt: iso(t), onlineAt: iso(t), lifetimeUsedTrafficBytes: 5 }) }), {
        firstConnectedAt: iso(t), onlineAt: iso(t), lifetimeTraffic: 5,
    });
    assert.deepEqual(activityOf({ id: 1, firstConnectedAt: null, lifetimeUsedTrafficBytes: 0 }), { firstConnectedAt: null, onlineAt: null, lifetimeTraffic: 0 });
    assert.equal(activityOf({ id: 1, expireAt: iso(t), status: 'ACTIVE' }), null);
});

test('синхронизация: первое подключение, трафик и самое раннее устройство', async () => {
    const connectedAt = Date.now() - 3 * HOUR;
    const { rw, user } = subscriber({ userTraffic: traffic({ firstConnectedAt: iso(connectedAt), onlineAt: iso(Date.now()), lifetimeUsedTrafficBytes: 1e9 }) });
    const firstDevice = iso(Date.now() - 4 * HOUR);
    fakes.remnawave.devices.set(rw.id, [
        { hwid: 'b', userId: rw.id, createdAt: iso(Date.now() - 2 * HOUR) },
        { hwid: 'a', userId: rw.id, createdAt: firstDevice },
    ]);
    await refreshCachedSubscriptions();
    const u = getUserRow(user.id);
    assert.equal(u.rw_first_connected_at, iso(connectedAt));
    assert.equal(u.rw_lifetime_traffic, 1e9);
    assert.equal(u.rw_first_device_at, firstDevice);
    assert.ok(u.rw_activity_at);

    // Устройство отвязали — отметка о первом устройстве остаётся
    fakes.remnawave.devices.set(rw.id, [{ hwid: 'c', userId: rw.id, createdAt: iso(Date.now()) }]);
    await refreshCachedSubscriptions();
    assert.equal(getUserRow(user.id).rw_first_device_at, firstDevice);
});

test('панель без списка пользователей: устройства всё равно обновляются', async () => {
    const { rw, user } = subscriber();
    const at = iso(Date.now() - HOUR);
    fakes.remnawave.devices.set(rw.id, [{ hwid: 'a', userId: rw.id, createdAt: at }]);
    fakes.remnawave.listUnsupported = true;
    await refreshCachedSubscriptions();
    assert.equal(getUserRow(user.id).rw_first_device_at, at);
});

test('новый пользователь панели — данные об использовании прежнего не переносятся', async () => {
    const { user } = subscriber({ userTraffic: traffic({ firstConnectedAt: iso(Date.now() - DAY_MS), lifetimeUsedTrafficBytes: 5 }) });
    await refreshCachedSubscriptions();
    assert.ok(getUserRow(user.id).rw_first_connected_at);
    // Пользователя удалили прямо в панели, клиент оплатил снова
    await createRemnaUser(getUserRow(user.id), { expireAt: new Date(Date.now() + 30 * DAY_MS), deviceLimit: 3, note: 'paid' });
    const u = getUserRow(user.id);
    assert.equal(u.rw_first_connected_at, null);
    assert.equal(u.rw_lifetime_traffic, null);
    assert.equal(u.rw_activity_at, null);
    assert.ok(u.rw_created_at);
});

test('список устройств недоступен — остальное обновляется', async () => {
    const { user } = subscriber({ userTraffic: traffic({ lifetimeUsedTrafficBytes: 10 }) });
    failNext('GET /api/hwid/devices', 'error', 500);
    await refreshCachedSubscriptions();
    const u = getUserRow(user.id);
    assert.equal(u.rw_lifetime_traffic, 10);
    assert.equal(u.rw_first_device_at, null);
});

test('фильтр «Не подключились»: подписка действует, подключения не было дольше N часов', async () => {
    const waiting = subscriber().user;
    subscriber({ userTraffic: traffic({ firstConnectedAt: iso(Date.now() - HOUR) }) }); // подключился
    subscriber({ paidAgoMs: 2 * HOUR }); // оплатил недавно
    const unknown = addRemnaUser({ status: 'ACTIVE', expireAt: iso(Date.now() + DAY_MS) }); // панель без данных об использовании
    const unknownUser = createUser({ rw_user_id: unknown.id, rw_status: 'ACTIVE', expire_at: unknown.expireAt });
    createOrder(unknownUser.id, { status: 'applied', paid_at: sql(Date.now() - 3 * DAY_MS) });
    await refreshCachedSubscriptions();

    assert.deepEqual(listUsers({ filter: 'not_connected' }).items.map((u) => u.id), [waiting.id]);
    saveSettings({ activationHours: 1 });
    assert.equal(listUsers({ filter: 'not_connected' }).total, 2);

    // Трафик есть, а времени первого подключения панель не прислала — клиент подключался
    db.prepare('UPDATE users SET rw_lifetime_traffic = 100 WHERE id = ?').run(waiting.id);
    assert.equal(listUsers({ filter: 'not_connected' }).total, 1);
    db.prepare('UPDATE users SET rw_lifetime_traffic = 0 WHERE id = ?').run(waiting.id);
    // Отсчёт — от создания текущего пользователя панели, а не от первой оплаты
    saveSettings({ activationHours: 24 });
    db.prepare('UPDATE users SET rw_created_at = ? WHERE id = ?').run(iso(Date.now() - HOUR), waiting.id);
    assert.equal(listUsers({ filter: 'not_connected' }).total, 0);
    // Неизвестный фильтр (в том числе имя свойства объекта) игнорируется
    assert.equal(listUsers({ filter: 'constructor' }).total, 4);
});

test('аналитика: лестница активации новых платящих клиентов и пробного периода', async () => {
    const now = Date.now();
    const full = subscriber({ paidAgoMs: 5 * HOUR, userTraffic: traffic({ firstConnectedAt: iso(now - 3 * HOUR), lifetimeUsedTrafficBytes: 100 }) });
    fakes.remnawave.devices.set(full.rw.id, [{ hwid: 'x', userId: full.rw.id, createdAt: iso(now - 4 * HOUR) }]);
    const deviceOnly = subscriber({ paidAgoMs: 5 * HOUR });
    fakes.remnawave.devices.set(deviceOnly.rw.id, [{ hwid: 'y', userId: deviceOnly.rw.id, createdAt: iso(now - 4 * HOUR) }]);
    subscriber({ paidAgoMs: 5 * HOUR });
    const trialRw = addRemnaUser({ status: 'ACTIVE', expireAt: iso(now + DAY_MS), userTraffic: traffic({ firstConnectedAt: iso(now - HOUR) }) });
    createUser({ rw_user_id: trialRw.id, plan_kind: 'trial', trial_used_at: sql(now - 2 * HOUR) });
    await refreshCachedSubscriptions();

    const a = analytics({});
    // Время оплаты в базе — с точностью до секунды
    const { timeToConnect: paidWait, ...paid } = a.current.activation.paid;
    const { timeToConnect: trialWait, ...trial } = a.current.activation.trial;
    assert.deepEqual(paid, { total: 3, noData: 0, device: 2, connected: 1, traffic: 1 });
    assert.deepEqual(trial, { total: 1, noData: 0, device: 0, connected: 1, traffic: 0 });
    assert.ok(Math.abs(paidWait - 2 * HOUR) < 2000);
    assert.ok(Math.abs(trialWait - HOUR) < 2000);
    // Не подключились за 24 часа — никто: оплатили 5 часов назад
    assert.equal(a.notConnected, 0);
    assert.equal(a.activationHours, 24);
    saveSettings({ activationHours: 1 });
    assert.equal(analytics({}).notConnected, 2);
});
