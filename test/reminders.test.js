import './helpers/env.js';
import './helpers/telegram-on.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addRemnaUser, fakes, resetFakes } from './helpers/fakes.js';
import { createUser } from './helpers/factories.js';
import { db } from '../src/db.js';
import { dueThreshold, sendExpiryReminders } from '../src/reminders.js';
import { saveSettings } from '../src/settings.js';

const DAY = 86_400_000;
// 12:00 по Москве сегодня — в разрешённые часы
const noonMsk = () => {
    const d = new Date(Date.now() + 3 * 3_600_000);
    d.setUTCHours(12, 0, 0, 0);
    return d.getTime() - 3 * 3_600_000;
};

beforeEach(() => {
    resetFakes();
    db.exec('DELETE FROM expiry_reminders; UPDATE users SET rw_status = NULL');
    saveSettings({ remindersEnabled: true, reminderDays: '3, 1' });
});

// Клиент, подписка которого заканчивается через days дней от now; кэш в базе совпадает с панелью
function client(now, days, fields = {}) {
    const expireAt = new Date(now + days * DAY).toISOString();
    const rw = addRemnaUser({ expireAt, status: 'ACTIVE' });
    const user = createUser({ rw_user_id: rw.id, plan_kind: 'paid', expire_at: expireAt, rw_status: 'ACTIVE', ...fields });
    return { rw, user };
}
const mailsTo = (email) => fakes.resend.sent.filter((m) => m.to.includes(email));
const tgMessages = () => fakes.telegram.calls.filter((c) => c.method === 'sendMessage');

describe('dueThreshold', () => {
    test('ближайший порог, в который попадает остаток', () => {
        assert.equal(dueThreshold(2.5 * DAY, [1, 3]), 3);
        assert.equal(dueThreshold(0.5 * DAY, [1, 3]), 1);
        assert.equal(dueThreshold(4 * DAY, [1, 3]), null);
        assert.equal(dueThreshold(-1, [1, 3]), null);
    });
});

describe('sendExpiryReminders', () => {
    test('за 3 дня — письмо один раз; за 1 день — второе', async () => {
        const now = noonMsk();
        const { user } = client(now, 2.2);
        await sendExpiryReminders(now);
        await sendExpiryReminders(now + 3_600_000);
        assert.equal(mailsTo(user.email).length, 1);
        assert.match(mailsTo(user.email)[0].subject, /Подписка заканчивается через 3 дня/);

        // Через 1,3 дня (19:12 МСК) осталось 0,9 дня
        await sendExpiryReminders(now + 1.3 * DAY);
        assert.equal(mailsTo(user.email).length, 2);
        assert.match(mailsTo(user.email)[1].subject, /заканчивается завтра/);
    });

    test('окно пропущено: до конца меньше суток — только ближайшее напоминание', async () => {
        const now = noonMsk();
        const { user } = client(now, 0.5);
        await sendExpiryReminders(now);
        assert.equal(mailsTo(user.email).length, 1);
        assert.match(mailsTo(user.email)[0].subject, /завтра/);
    });

    test('продлили в панели — напоминания нет; после продления цикл заново', async () => {
        const now = noonMsk();
        const { user, rw } = client(now, 2);
        rw.expireAt = new Date(now + 32 * DAY).toISOString(); // кэш в базе ещё старый
        await sendExpiryReminders(now);
        assert.equal(mailsTo(user.email).length, 0);

        const renewed = client(now, 2.5);
        await sendExpiryReminders(now);
        // Продлили на 30 дней; кэш срока в базе обновляет фоновая задача — здесь вручную
        renewed.rw.expireAt = new Date(now + 2.9 * DAY + 30 * DAY).toISOString();
        db.prepare('UPDATE users SET expire_at = ? WHERE id = ?').run(renewed.rw.expireAt, renewed.user.id);
        await sendExpiryReminders(now + 30 * DAY);
        assert.equal(mailsTo(renewed.user.email).length, 2, 'новая дата окончания — новое напоминание');
    });

    test('ночью не пишем', async () => {
        const now = noonMsk() - 10 * 3_600_000; // 02:00 МСК
        const { user } = client(now, 2);
        await sendExpiryReminders(now);
        assert.equal(mailsTo(user.email).length, 0);
    });

    test('пробный период — текст про тариф; отключённым и выключенным в настройках — не пишем', async () => {
        const now = noonMsk();
        const trial = client(now, 1.5, { plan_kind: 'trial' });
        const blocked = client(now, 1.5, { blocked: 1 });
        await sendExpiryReminders(now);
        assert.match(mailsTo(trial.user.email)[0].text, /выберите тариф/);
        assert.equal(mailsTo(blocked.user.email).length, 0);

        saveSettings({ remindersEnabled: false });
        const off = client(now, 1.5);
        await sendExpiryReminders(now);
        assert.equal(mailsTo(off.user.email).length, 0);
    });

    test('пробный период на 3 дня: «через 3 дня» сразу после активации не приходит, «завтра» — приходит', async () => {
        const now = noonMsk();
        const startedAt = new Date(now - 60_000).toISOString().replace('T', ' ').slice(0, 19);
        const { user } = client(now, 3 - 60_000 / DAY, { plan_kind: 'trial', trial_used_at: startedAt });
        await sendExpiryReminders(now);
        assert.equal(mailsTo(user.email).length, 0);
        // Через 2 дня 1 час (13:00 МСК) до конца меньше суток
        await sendExpiryReminders(now + 2 * DAY + 3_600_000);
        assert.equal(mailsTo(user.email).length, 1);
        assert.match(mailsTo(user.email)[0].subject, /Пробный период заканчивается завтра/);
    });

    test('склонение порога в теме письма', async () => {
        saveSettings({ reminderDays: '21' });
        const now = noonMsk();
        const { user } = client(now, 20.5);
        await sendExpiryReminders(now);
        assert.match(mailsTo(user.email)[0].subject, /через 21 день —/);
    });

    test('привязан Telegram — сообщение от бота; заблокированный /ban — нет', async () => {
        const now = noonMsk();
        const a = client(now, 2);
        const b = client(now, 2);
        db.prepare('INSERT INTO tg_clients (tg_user_id, user_id) VALUES (?, ?)').run(7001, a.user.id);
        db.prepare('INSERT INTO tg_clients (tg_user_id, user_id, banned) VALUES (?, ?, 1)').run(7002, b.user.id);
        await sendExpiryReminders(now);
        const to = tgMessages().map((c) => c.params.chat_id);
        assert.ok(to.includes(7001));
        assert.ok(!to.includes(7002));
        assert.match(tgMessages().find((c) => c.params.chat_id === 7001).params.text, /действует до/);
    });
});
