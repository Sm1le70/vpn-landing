import './helpers/env.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addRemnaUser, fakes, resetFakes } from './helpers/fakes.js';
import { createUser } from './helpers/factories.js';
import { db } from '../src/db.js';
import { destroyOtherSessions, issueLoginCode, verifyLoginCode } from '../src/auth.js';
import { clearRemnawaveCache } from '../src/remnawave.js';
import { clientDevices, removeClientDevice, revokeClientLink } from '../src/subscriptions.js';

beforeEach(() => {
    resetFakes();
    clearRemnawaveCache();
});

function subscriber(status = 'ACTIVE') {
    const rw = addRemnaUser({ status });
    fakes.remnawave.devices.set(rw.id, [
        { hwid: 'hw-phone', platform: 'Android', osVersion: '14', deviceModel: 'Pixel 8', createdAt: '2026-09-01T10:00:00Z' },
        { hwid: 'hw-laptop', platform: 'Windows', osVersion: '11', deviceModel: 'PC', createdAt: '2026-09-02T10:00:00Z' },
    ]);
    return { rw, user: createUser({ rw_user_id: rw.id, plan_kind: 'paid' }) };
}

describe('устройства клиента (4.4)', () => {
    test('список и отвязка своего устройства; кабинет сразу видит изменение', async () => {
        const { user } = subscriber();
        assert.deepEqual((await clientDevices(user)).map((d) => d.model), ['Pixel 8', 'PC']);
        await removeClientDevice(user, 'hw-phone');
        assert.deepEqual((await clientDevices(user)).map((d) => d.hwid), ['hw-laptop'], 'кэш сброшен');
    });

    test('чужое или неизвестное устройство не отвязывается', async () => {
        const a = subscriber();
        const b = subscriber();
        await assert.rejects(removeClientDevice(a.user, 'hw-unknown'), /не найдено/);
        fakes.remnawave.devices.set(b.rw.id, [{ hwid: 'hw-other' }]);
        await assert.rejects(removeClientDevice(a.user, 'hw-other'), /не найдено/);
        assert.equal(fakes.remnawave.requests.filter((r) => r.path === '/api/hwid/devices/delete').length, 0);
    });

    test('без подписки — пустой список', async () => {
        assert.deepEqual(await clientDevices(createUser()), []);
    });

    test('отметка пробного периода для устройства остаётся после отвязки', async () => {
        const { user } = subscriber();
        db.prepare("INSERT INTO trial_hwids (hwid, user_id) VALUES ('hw-phone', ?)").run(user.id);
        await removeClientDevice(user, 'hw-phone');
        assert.ok(db.prepare("SELECT 1 FROM trial_hwids WHERE hwid = 'hw-phone'").get());
    });
});

describe('перевыпуск ссылки клиентом (4.5)', () => {
    test('новая ссылка, старая не работает, письмо с новой ссылкой', async () => {
        const { user, rw } = subscriber();
        const old = rw.subscriptionUrl;
        const url = await revokeClientLink(user);
        assert.notEqual(url, old);
        assert.equal(rw.subscriptionUrl, url);
        assert.equal(fakes.resend.sent.length, 1);
        assert.match(fakes.resend.sent[0].text, new RegExp(url));
    });

    test('без подписки или отключённая — ошибка', async () => {
        await assert.rejects(revokeClientLink(createUser()), /Подписки пока нет/);
        await assert.rejects(revokeClientLink(subscriber('DISABLED').user), /отключена/);
    });
});

describe('выход на других устройствах (4.3)', () => {
    test('удаляются все сессии, кроме текущей', () => {
        const email = `sessions${Date.now()}@test.local`;
        const sessions = [0, 1, 2].map(() => verifyLoginCode(email, issueLoginCode(email)));
        const userId = sessions[0].user.id;
        assert.equal(destroyOtherSessions(userId, sessions[1].token), 2);
        const left = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n;
        assert.equal(left, 1);
        assert.equal(destroyOtherSessions(userId, sessions[1].token), 0);
    });
});
