import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { AdminAuthError, currentTotp, hashPassword, passwordStep, secondFactorStep } from '../src/admin/auth.js';

const PASSWORD = 'correct-horse-battery-staple';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function createAdmin() {
    const login = `adm${Math.random().toString(36).slice(2, 8)}`;
    db.prepare("INSERT INTO admins (login, role, password_hash, totp_secret) VALUES (?, 'admin', ?, ?)").run(login, hashPassword(PASSWORD), SECRET);
    return login;
}

const wrongCode = (ticket, ip) => assert.throws(() => secondFactorStep(ticket, '12345', ip), (err) => err instanceof AdminAuthError && err.status === 401);

test('2FA: повторный ввод пароля не сбрасывает счётчик неверных кодов', () => {
    const login = createAdmin();
    // Разные IP — блокировка по IP не срабатывает, считается только учётная запись
    let { ticket } = passwordStep(login, PASSWORD, '10.0.0.1');
    for (let i = 0; i < 4; i++) wrongCode(ticket, '10.0.0.1');
    ({ ticket } = passwordStep(login, PASSWORD, '10.0.0.2'));
    wrongCode(ticket, '10.0.0.2');
    ({ ticket } = passwordStep(login, PASSWORD, '10.0.0.3'));
    assert.throws(() => secondFactorStep(ticket, currentTotp(SECRET), '10.0.0.3'), (err) => err.status === 429);
});

test('2FA: тикет входа действует только с того IP, где введён пароль', () => {
    const login = createAdmin();
    const { ticket } = passwordStep(login, PASSWORD, '10.0.1.1');
    assert.throws(() => secondFactorStep(ticket, currentTotp(SECRET), '10.0.1.2'), /истекла/);
    assert.equal(secondFactorStep(ticket, currentTotp(SECRET), '10.0.1.1').login, login);
});
