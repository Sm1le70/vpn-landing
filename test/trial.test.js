import './helpers/env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakes, resetFakes } from './helpers/fakes.js';
import { createUser } from './helpers/factories.js';
import { isDisposableEmail } from '../src/disposable.js';
import { getUserRow, startTrial, trialAvailable } from '../src/subscriptions.js';

beforeEach(resetFakes);

test('одноразовые домены и их поддомены', () => {
    assert.equal(isDisposableEmail('someone@mailinator.com'), true);
    assert.equal(isDisposableEmail('someone@YOPMAIL.COM'), true);
    assert.equal(isDisposableEmail('someone@x.mailinator.com'), true);
    assert.equal(isDisposableEmail('someone@gmail.com'), false);
    assert.equal(isDisposableEmail('someone@mail.ru'), false);
    assert.equal(isDisposableEmail('someone@qwmailinator.com'), false, 'совпадение только по целым частям домена');
    assert.equal(isDisposableEmail('someone@mailinator.com.ru'), false);
    assert.equal(isDisposableEmail('someone@yandex.ru'), false);
    assert.equal(isDisposableEmail(''), false);
});

test('пробный период на обычную почту выдаётся', async () => {
    const user = createUser({ email: `trial${Date.now()}@gmail.com` });
    assert.equal(trialAvailable(user), true);
    await startTrial(user.id);
    assert.equal(getUserRow(user.id).plan_kind, 'trial');
});

test('пробный период на одноразовую почту не выдаётся, оплата не ограничена', async () => {
    const user = createUser({ email: `trial${Date.now()}@mailinator.com` });
    assert.equal(trialAvailable(user), false);
    await assert.rejects(startTrial(user.id), /временн/);
    assert.equal(fakes.remnawave.users.size, 0);
    assert.equal(getUserRow(user.id).trial_used_at, null);
});

test('trialDisposable — только если пробный период положен, но почта одноразовая', async () => {
    const { trialDisposable } = await import('../src/subscriptions.js');
    assert.equal(trialDisposable(createUser({ email: `a${Date.now()}@mailinator.com` })), true);
    assert.equal(trialDisposable(createUser({ email: `b${Date.now()}@gmail.com` })), false);
    assert.equal(trialDisposable(createUser({ email: `c${Date.now()}@mailinator.com`, trial_used_at: '2026-01-01 00:00:00' })), false);
});
