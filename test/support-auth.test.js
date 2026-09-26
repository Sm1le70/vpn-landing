import './helpers/env.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakes, resetFakes } from './helpers/fakes.js';
import { createUser } from './helpers/factories.js';
import { db } from '../src/db.js';
import { processInboxItem, senderAuth } from '../src/support.js';
import { threadDetails } from '../src/admin/support.js';

beforeEach(resetFakes);

const AUTH = {
    pass: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    fail: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
    gray: { spf: 'pass', dkim: 'pass', dmarc: 'gray' },
};

// Письмо «принято» Resend и прошло вебхук; возвращает строку сообщения в базе
async function receive({ from, subject = 'Вопрос', authentication, inReplyTo } = {}) {
    const id = crypto.randomUUID();
    const headers = { from };
    if (inReplyTo) Object.assign(headers, { 'in-reply-to': inReplyTo, references: inReplyTo });
    fakes.resend.received.set(id, {
        id, from, to: ['support@test.local'], subject, text: 'Текст', headers,
        message_id: `<${id}@mail.test>`, created_at: new Date().toISOString(), attachments: [],
        ...(authentication !== undefined ? { authentication } : {}),
    });
    db.prepare('INSERT INTO support_inbox (email_id, payload) VALUES (?, ?)').run(id, JSON.stringify({ email_id: id, from, subject }));
    await processInboxItem(id);
    return db.prepare('SELECT * FROM support_messages WHERE resend_id = ?').get(id);
}
const thread = (id) => db.prepare('SELECT * FROM support_threads WHERE id = ?').get(id);

describe('senderAuth', () => {
    test('подтверждает только DMARC', () => {
        assert.equal(senderAuth(AUTH.pass), 'pass');
        assert.equal(senderAuth(AUTH.fail), 'fail');
        assert.equal(senderAuth({ spf: 'fail', dkim: 'fail', dmarc: 'gray' }), 'fail');
        assert.equal(senderAuth(AUTH.gray), 'unknown', 'SPF и DKIM без DMARC не подтверждают поле From');
        assert.equal(senderAuth(null), 'unknown');
        assert.equal(senderAuth(undefined), 'unknown');
    });
});

describe('приём писем с проверкой отправителя', () => {
    test('DMARC пройден: письмо привязано к аккаунту', async () => {
        const user = createUser();
        const m = await receive({ from: user.email, authentication: AUTH.pass });
        assert.equal(m.sender_auth, 'pass');
        const t = thread(m.thread_id);
        assert.equal(t.user_id, user.id);
        assert.equal(t.sender_verified, 1);
        assert.equal(threadDetails(t.id).user.id, user.id);
    });

    test('DMARC не пройден: к аккаунту не привязано, аккаунт показан как «возможный»', async () => {
        const user = createUser();
        const m = await receive({ from: user.email, authentication: AUTH.fail });
        assert.equal(m.sender_auth, 'fail');
        const t = thread(m.thread_id);
        assert.equal(t.user_id, null);
        assert.equal(t.sender_verified, 0);
        const d = threadDetails(t.id);
        assert.equal(d.user, null);
        assert.equal(d.possibleUser.id, user.id);
        assert.equal(d.messages[0].senderAuth, 'fail');
        assert.equal(d.thread.senderVerified, false);
    });

    test('нет данных проверки — как неподтверждённый', async () => {
        const user = createUser();
        const m = await receive({ from: user.email });
        assert.equal(m.sender_auth, 'unknown');
        assert.equal(thread(m.thread_id).user_id, null);
    });

    test('неподтверждённое письмо с той же темой не попадает в переписку клиента', async () => {
        const user = createUser();
        const first = await receive({ from: user.email, subject: 'Не работает', authentication: AUTH.pass });
        const spoofed = await receive({ from: user.email, subject: 'Re: Не работает', authentication: AUTH.fail });
        assert.notEqual(spoofed.thread_id, first.thread_id);
        const genuine = await receive({ from: user.email, subject: 'Re: Не работает', authentication: AUTH.pass });
        assert.equal(genuine.thread_id, first.thread_id, 'подтверждённое — в ту же переписку, как раньше');
    });

    test('ответ на наше письмо (In-Reply-To) попадает в переписку и без DMARC, но помечен', async () => {
        const user = createUser();
        const first = await receive({ from: user.email, authentication: AUTH.pass });
        db.prepare("INSERT INTO support_messages (thread_id, direction, message_id, text) VALUES (?, 'out', '<our-reply@resend.test>', 'Ответ')").run(first.thread_id);
        const reply = await receive({ from: user.email, subject: 'Re: Вопрос', authentication: AUTH.gray, inReplyTo: '<our-reply@resend.test>' });
        assert.equal(reply.thread_id, first.thread_id);
        assert.equal(reply.sender_auth, 'unknown');
        assert.equal(thread(first.thread_id).user_id, user.id, 'привязка переписки сохраняется');
        assert.equal(thread(first.thread_id).sender_verified, 1);
    });

    test('обращения до появления проверки: аккаунт находится по email, как раньше', async () => {
        const user = createUser();
        const id = Number(db.prepare("INSERT INTO support_threads (email, subject, subject_norm) VALUES (?, 'Старое', 'старое')").run(user.email).lastInsertRowid);
        assert.equal(thread(id).sender_verified, null);
        assert.equal(threadDetails(id).user.id, user.id);
    });
});
