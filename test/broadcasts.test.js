import './helpers/env.js';
import './helpers/telegram-on.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { createUser, ADMIN } from './helpers/factories.js';
import { addRemnaUser, fakes, resetFakes, failNext } from './helpers/fakes.js';
import { createBroadcast, broadcastOverview, broadcastDetails, processBroadcasts, defaults, startBroadcasts } from '../src/broadcasts.js';

beforeEach(() => {
    resetFakes();
    db.exec('DELETE FROM broadcast_deliveries; DELETE FROM broadcasts; DELETE FROM tg_clients;');
    db.prepare('UPDATE users SET blocked = 1').run();
});
function subscriber(fields = {}, rwFields = {}) {
    const rw = addRemnaUser(rwFields);
    const user = createUser({ rw_user_id: rw.id, rw_status: rw.status, expire_at: rw.expireAt, plan_kind: 'paid', ...fields });
    return { user, rw };
}
async function drain() {
    for (let i = 0; i < 30 && db.prepare("SELECT 1 FROM broadcast_deliveries WHERE status = 'pending'").get(); i++) await processBroadcasts();
}

test('только активные платные и пробные, Telegram только привязанным и не заблокированным', async () => {
    const paid = subscriber(); const trial = subscriber({ plan_kind: 'trial' });
    subscriber({ blocked: 1 }); subscriber({ trial_blocked: 1 }); subscriber({ plan_kind: 'none' });
    subscriber({}, { status: 'DISABLED' }); subscriber({}, { expireAt: new Date(Date.now()-1000).toISOString() });
    db.prepare('INSERT INTO tg_clients(tg_user_id,user_id,banned) VALUES (100,?,0),(101,?,1)').run(paid.user.id, trial.user.id);
    assert.equal(broadcastOverview().recipients, 2);
    const { id } = createBroadcast(ADMIN, { ...defaults, text: '<b>Обновление</b>\nОбновите подписку.' });
    await drain();
    assert.deepEqual(fakes.resend.sent.map(m => m.to[0]).sort(), [paid.user.email, trial.user.email].sort());
    assert.ok(fakes.resend.sent[0].html.includes('&lt;b&gt;'));
    const telegram = fakes.telegram.calls.filter(c => c.method === 'sendMessage');
    assert.equal(telegram.length, 1);
    assert.ok(telegram[0].params.reply_markup.inline_keyboard[0][0].url.endsWith('/cabinet'));
    assert.ok(broadcastDetails(id).deliveries.every(d => d.status === 'sent'));
});
test('повторно проверяет панель, локальную блокировку и связь Telegram; не дублирует проход', async () => {
    const { rw } = subscriber(); const second = subscriber();
    const { id } = createBroadcast(ADMIN, defaults);
    rw.status = 'DISABLED';
    db.prepare('UPDATE users SET blocked = 1 WHERE id = ?').run(second.user.id);
    await Promise.all([processBroadcasts(), processBroadcasts()]); await drain(); await drain();
    assert.equal(fakes.resend.sent.length, 0);
    assert.ok(broadcastDetails(id).deliveries.every(d => d.status === 'skipped'));
});
test('тест на произвольный email без регистрации; не отправляет Telegram; сохраняет тему и текст', async () => {
    const { id } = createBroadcast(ADMIN, { subject: 'Проверка', text: 'Новый текст', email: 'Manual@Example.com' }, true);
    await drain(); await drain();
    assert.equal(fakes.resend.sent.length, 1);
    assert.equal(fakes.resend.sent[0].to[0], 'manual@example.com');
    assert.equal(fakes.resend.sent[0].subject, 'Проверка');
    assert.equal(fakes.telegram.calls.length, 0);
    assert.equal(broadcastDetails(id).broadcast.is_test, 1);
});
test('сбой одного канала не мешает другому; результат и ошибка сохраняются', async () => {
    const { user } = subscriber();
    db.prepare('INSERT INTO tg_clients(tg_user_id,user_id) VALUES (102,?)').run(user.id);
    const { id } = createBroadcast(ADMIN, defaults);
    failNext('POST /emails'); await drain();
    const d = broadcastDetails(id).deliveries;
    assert.equal(d[0].status, 'failed'); assert.ok(d[0].error);
    assert.equal(d[1].status, 'sent');
});
test('валидация, защита от параллельной рассылки и отсутствие ложного успеха без Resend', () => {
    assert.throws(() => createBroadcast(ADMIN, { ...defaults, email: 'invalid' }, true));
    assert.throws(() => createBroadcast(ADMIN, { ...defaults, subject: 'a\nb' }, true));
    assert.throws(() => createBroadcast(ADMIN, defaults));
    subscriber(); createBroadcast(ADMIN, defaults);
    assert.throws(() => createBroadcast(ADMIN, defaults), /ещё выполняется/);
    const key = config.mail.resendApiKey;
    try { config.mail.resendApiKey = ''; assert.throws(() => createBroadcast(ADMIN, defaults), /RESEND_API_KEY/); }
    finally { config.mail.resendApiKey = key; }
});
test('после перезапуска не повторяет неопределённые отправки, очередь остаётся', () => {
    subscriber(); const { id } = createBroadcast(ADMIN, defaults);
    db.prepare("UPDATE broadcast_deliveries SET status = 'sending' WHERE broadcast_id = ?").run(id);
    startBroadcasts();
    assert.equal(broadcastDetails(id).deliveries[0].status, 'unknown');
});

test('истечение подписки или отвязка Telegram после запуска исключают отправку', async () => {
    const a = subscriber(); const b = subscriber();
    db.prepare('INSERT INTO tg_clients(tg_user_id,user_id) VALUES (103,?)').run(b.user.id);
    const { id } = createBroadcast(ADMIN, defaults);
    a.rw.expireAt = new Date(Date.now()-1000).toISOString();
    db.prepare('UPDATE tg_clients SET user_id = NULL WHERE tg_user_id = 103').run();
    await drain();
    const d = broadcastDetails(id).deliveries;
    assert.equal(d.filter(x => x.status === 'skipped').length, 2);
    assert.equal(fakes.resend.sent.length, 1);
    assert.equal(fakes.telegram.calls.length, 0);
});
