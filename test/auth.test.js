import './helpers/env.js';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakes, resetFakes } from './helpers/fakes.js';
import { uniqueEmail } from './helpers/factories.js';
import { db } from '../src/db.js';
import {
    AuthError,
    issueLoginCode,
    issueStaticLoginCode,
    requestLoginCode,
    revokeStaticLoginCode,
    verifyLoginCode,
} from '../src/auth.js';

beforeEach(resetFakes);

const wrong = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
const sessionsOf = (userId) => db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n;

describe('код из письма', () => {
    test('requestLoginCode отправляет письмо с кодом; повтор раньше чем через минуту — ошибка', async () => {
        const email = uniqueEmail();
        await requestLoginCode(email);
        assert.equal(fakes.resend.sent.length, 1);
        assert.deepEqual(fakes.resend.sent[0].to, [email]);
        const code = fakes.resend.sent[0].subject.match(/\d{6}/)[0];

        await assert.rejects(requestLoginCode(email), (err) => err instanceof AuthError && /через \d+ с/.test(err.message));
        assert.equal(fakes.resend.sent.length, 1);

        const { user, token } = verifyLoginCode(email, code);
        assert.equal(user.email, email);
        assert.ok(token.length >= 40);
    });

    test('верный код: сессия создаётся, код одноразовый', () => {
        const email = uniqueEmail();
        const code = issueLoginCode(email);
        const { user } = verifyLoginCode(email, ` ${code} `);
        assert.equal(sessionsOf(user.id), 1);
        assert.throws(() => verifyLoginCode(email, code), /истёк/);
    });

    test('неверный код: счётчик попыток, после 5 — только новый код', () => {
        const email = uniqueEmail();
        const code = issueLoginCode(email);
        for (let i = 0; i < 5; i++) assert.throws(() => verifyLoginCode(email, wrong(code)), /Неверный код/);
        assert.throws(() => verifyLoginCode(email, code), /Слишком много попыток/);

        const fresh = issueLoginCode(email);
        assert.ok(verifyLoginCode(email, fresh).token);
    });

    test('истёкший код не принимается', () => {
        const email = uniqueEmail();
        const code = issueLoginCode(email, -1000);
        assert.throws(() => verifyLoginCode(email, code), /истёк/);
    });

    test('код одного email не подходит к другому', () => {
        const a = uniqueEmail();
        const b = uniqueEmail();
        const codeA = issueLoginCode(a);
        // Коды случайные и могут совпасть (шанс 1 из миллиона) — перевыпускаем код b, пока не отличается
        while (issueLoginCode(b) === codeA);
        assert.throws(() => verifyLoginCode(b, codeA), /Неверный код/);
        assert.ok(verifyLoginCode(a, codeA).token);
    });
});

describe('постоянный код (login-code --permanent)', () => {
    test('работает многократно и не мешает коду из письма', () => {
        const email = uniqueEmail();
        const fixed = issueStaticLoginCode(email);
        assert.ok(verifyLoginCode(email, fixed).token);
        assert.ok(verifyLoginCode(email, fixed).token);

        const mailed = issueLoginCode(email);
        if (mailed !== fixed) assert.ok(verifyLoginCode(email, mailed).token);
        assert.ok(verifyLoginCode(email, fixed).token);
    });

    test('неверный постоянный код без кода из письма — «Неверный код», а не «истёк»', () => {
        const email = uniqueEmail();
        const fixed = issueStaticLoginCode(email);
        assert.throws(() => verifyLoginCode(email, wrong(fixed)), { message: 'Неверный код' });
    });

    test('после 20 неверных попыток отключается; новый код заменяет старый', () => {
        const email = uniqueEmail();
        const fixed = issueStaticLoginCode(email);
        for (let i = 0; i < 20; i++) assert.throws(() => verifyLoginCode(email, wrong(fixed)));
        assert.throws(() => verifyLoginCode(email, fixed), /истёк/);

        const renewed = issueStaticLoginCode(email);
        assert.ok(verifyLoginCode(email, renewed).token);
    });

    test('отзыв', () => {
        const email = uniqueEmail();
        const fixed = issueStaticLoginCode(email);
        assert.equal(revokeStaticLoginCode(email), true);
        assert.throws(() => verifyLoginCode(email, fixed), /истёк/);
        assert.equal(revokeStaticLoginCode(email), false);
    });
});
