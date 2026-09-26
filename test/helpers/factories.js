// Тестовые данные в базе. Импортировать после env.js.
import crypto from 'node:crypto';
import { db } from '../../src/db.js';
import { findOrCreateUser, getUserRow } from '../../src/subscriptions.js';

let seq = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}${++seq}-${crypto.randomBytes(3).toString('hex')}@test.local`;

// Пользователь сайта; fields — колонки users (rw_user_id, plan_kind, blocked…)
export function createUser(fields = {}) {
    const user = findOrCreateUser(fields.email ?? uniqueEmail());
    const { email, ...rest } = fields;
    const keys = Object.keys(rest);
    if (keys.length) {
        db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(rest), user.id);
    }
    return getUserRow(user.id);
}

export function createOrder(userId, { planId = 'm1', days = 30, amount = 199, status = 'pending', txId = null, ...rest } = {}) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO orders (id, user_id, plan_id, days, amount, status, platega_tx_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, userId, planId, days, amount, status, txId,
    );
    const keys = Object.keys(rest);
    if (keys.length) db.prepare(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(rest), id);
    return getOrder(id);
}

export const getOrder = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

export const ADMIN = { id: 1, login: 'test-admin', role: 'admin' };
export const SUPPORT = { id: 2, login: 'test-support', role: 'support' };

export const DAY_MS = 86_400_000;
// Разница дат в днях (дробная)
export const daysBetween = (a, b) => (new Date(b) - new Date(a)) / DAY_MS;
