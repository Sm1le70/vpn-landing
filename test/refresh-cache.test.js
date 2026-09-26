import './helpers/env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { addRemnaUser, failNext, fakes, resetFakes } from './helpers/fakes.js';
import { createUser } from './helpers/factories.js';
import { getUserRow } from '../src/subscriptions.js';

beforeEach(resetFakes);

const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
const panelRequests = (pred) => fakes.remnawave.requests.filter(pred).length;

// Клиент сайта с пользователем в панели; кэш в базе заведомо устаревший
function client(fields = {}) {
    const rw = addRemnaUser({ expireAt: iso(10), status: 'ACTIVE', ...fields });
    const user = createUser({ rw_user_id: rw.id, expire_at: iso(1), rw_status: 'EXPIRED' });
    return { rw, user };
}

test('список панели постранично: срок и статус обновлены, запросов — по числу страниц', async () => {
    const { refreshCachedSubscriptions } = await import('../src/subscriptions.js');
    const clients = Array.from({ length: 3 }, () => client());
    for (let i = 0; i < 1200; i++) addRemnaUser(); // чужие пользователи панели: 1203 → 3 страницы по 500
    await refreshCachedSubscriptions();

    for (const { rw, user } of clients) {
        const u = getUserRow(user.id);
        assert.equal(u.expire_at, new Date(rw.expireAt).toISOString());
        assert.equal(u.rw_status, 'ACTIVE');
    }
    assert.equal(panelRequests((r) => r.path === '/api/users' && r.method === 'GET'), 3);
    assert.equal(panelRequests((r) => /^\/api\/users\/\d+$/.test(r.path)), 0, 'без запросов по одному');
});

test('пользователь, которого нет в панели, помечается удалённым', async () => {
    const { refreshCachedSubscriptions } = await import('../src/subscriptions.js');
    const { user } = client();
    const gone = createUser({ rw_user_id: 987_654, rw_status: 'ACTIVE' });
    await refreshCachedSubscriptions();
    assert.equal(getUserRow(gone.id).rw_status, 'DELETED');
    assert.equal(getUserRow(user.id).rw_status, 'ACTIVE');
});

test('страница не получена — никого не помечаем удалённым, обновляем по одному', async () => {
    const { refreshCachedSubscriptions } = await import('../src/subscriptions.js');
    const { rw, user } = client();
    failNext('GET /api/users', 'error', 502);
    await refreshCachedSubscriptions();
    assert.equal(getUserRow(user.id).rw_status, 'ACTIVE', 'обновлено запросом по одному');
    assert.equal(getUserRow(user.id).expire_at, new Date(rw.expireAt).toISOString());
});

test('панель без списка пользователей — прежний способ, по одному', async () => {
    const { refreshCachedSubscriptions } = await import('../src/subscriptions.js');
    fakes.remnawave.listUnsupported = true;
    const { user } = client();
    const gone = createUser({ rw_user_id: 876_543, rw_status: 'ACTIVE' });
    await refreshCachedSubscriptions();
    assert.equal(getUserRow(user.id).rw_status, 'ACTIVE');
    assert.equal(getUserRow(gone.id).rw_status, 'DELETED');
});
