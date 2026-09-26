import './helpers/env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { addRemnaUser, fakes, resetFakes } from './helpers/fakes.js';
import { ADMIN, createUser } from './helpers/factories.js';
import { db } from '../src/db.js';
import { clearRemnawaveCache } from '../src/remnawave.js';
import { getSubscriptionInfo, getUserRow } from '../src/subscriptions.js';
import { extendUser } from '../src/admin/service.js';

beforeEach(() => {
    resetFakes();
    clearRemnawaveCache();
});

const panelReads = () => fakes.remnawave.requests.filter((r) => r.method === 'GET').length;

function subscriber() {
    const rw = addRemnaUser({ expireAt: new Date(Date.now() + 10 * 86_400_000).toISOString() });
    return { rw, user: createUser({ rw_user_id: rw.id, plan_kind: 'paid' }) };
}

test('кабинет: повторная загрузка в течение 30 с не ходит в панель', async () => {
    const { user } = subscriber();
    await getSubscriptionInfo(user);
    await getSubscriptionInfo(user);
    await Promise.all([getSubscriptionInfo(user), getSubscriptionInfo(user)]);
    assert.equal(panelReads(), 2, 'один раз пользователь и один раз устройства');
});

test('через 30 с данные запрашиваются снова', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const { user } = subscriber();
    await getSubscriptionInfo(user);
    t.mock.timers.tick(31_000);
    await getSubscriptionInfo(user);
    assert.equal(panelReads(), 4);
});

test('изменение подписки сбрасывает кэш — кабинет сразу видит новый срок', async () => {
    const { user, rw } = subscriber();
    const before = (await getSubscriptionInfo(user)).expireAt;
    await extendUser(ADMIN, user.id, { days: 30, reason: 'проверка' });
    const after = (await getSubscriptionInfo(user)).expireAt;
    assert.notEqual(after, before);
    assert.equal(after, rw.expireAt);
});

test('признаки из базы не кэшируются', async () => {
    const { user } = subscriber();
    assert.equal((await getSubscriptionInfo(user)).trialBlocked, false);
    db.prepare('UPDATE users SET trial_blocked = 1 WHERE id = ?').run(user.id);
    assert.equal((await getSubscriptionInfo(getUserRow(user.id))).trialBlocked, true);
});

test('ошибка панели не кэшируется', async () => {
    const { user } = subscriber();
    const { failNext } = await import('./helpers/fakes.js');
    failNext('GET /api/users', 'error', 502);
    await assert.rejects(getSubscriptionInfo(user), /502/);
    assert.ok(await getSubscriptionInfo(user));
});
