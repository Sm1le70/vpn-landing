// Демо: история клиентов и платежей за год для раздела «Аналитика» (только демо-база).
// npm run demo:seed — можно запускать и при работающем npm run demo; повторный запуск заменяет прежние данные.
// Клиенты создаются без подписки в панели: их видно в аналитике и в списках, но не в заглушке Remnawave.
const APP_PORT = Number(process.env.DEMO_PORT) || 3000;
Object.assign(process.env, {
    DATABASE_PATH: APP_PORT === 3000 ? './data/demo.db' : `./data/demo-${APP_PORT}.db`,
    SITE_URL: `http://localhost:${APP_PORT}`,
    APP_SECRET: 'demo-secret',
    ADMIN_PATH: '/admin-demo',
    DEMO_ADMIN_NO_2FA: '',
});
const { db, tx } = await import('../src/db.js');
const { listPlans } = await import('../src/settings.js');

const DOMAIN = 'seed.example.com';
const DAY = 86_400_000;
const USERS = 260;
const now = Date.now();
const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// Детерминированный генератор: при каждом запуске одинаковая картина
let seed = 20260927;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const chance = (p) => rand() < p;
const pick = (weighted) => {
    let r = rand() * weighted.reduce((s, [, w]) => s + w, 0);
    for (const [v, w] of weighted) if ((r -= w) < 0) return v;
    return weighted.at(-1)[0];
};

const plans = listPlans();
const planWeights = plans.map((p) => [p, { m1: 5, m3: 3, m6: 1.5, m12: 1 }[p.id] ?? 1]);
const PROMOS = ['WELCOME20', 'FRIEND15'];

tx(() => {
    const old = db.prepare('SELECT id FROM users WHERE email LIKE ?').all(`%@${DOMAIN}`).map((u) => u.id);
    for (const id of old) {
        db.prepare('DELETE FROM expiry_reminders WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM orders WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    const promoStmt = db.prepare("INSERT OR IGNORE INTO promo_codes (code, kind, value, note) VALUES (?, 'percent', ?, 'демо')");
    promoStmt.run('WELCOME20', 20);
    promoStmt.run('FRIEND15', 15);

    const userStmt = db.prepare("INSERT INTO users (email, plan_kind, trial_used_at, created_at) VALUES (?, ?, ?, ?)");
    const orderStmt = db.prepare(
        `INSERT INTO orders (id, user_id, plan_id, days, amount, status, created_at, paid_at, applied_at, refunded_at, promo_code, price_before)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const reminderStmt = db.prepare('INSERT OR IGNORE INTO expiry_reminders (user_id, expire_at, days_before, sent_at) VALUES (?, ?, ?, ?)');
    let orders = 0;

    for (let i = 1; i <= USERS; i++) {
        // Приток клиентов растёт к сегодняшнему дню
        const created = now - Math.floor(365 * DAY * (1 - Math.sqrt(rand())));
        const trial = chance(0.45) ? created + Math.floor(rand() * 2 * 3_600_000) : null;
        const { lastInsertRowid: userId } = userStmt.run(`seed-${i}@${DOMAIN}`, trial ? 'trial' : 'none', trial ? sql(trial) : null, sql(created));

        if (!chance(trial ? 0.5 : 0.4)) {
            // Зашёл, но не купил; часть бросила оплату
            if (chance(0.35)) {
                const t = created + Math.floor(rand() * 3 * DAY);
                if (t < now) orderStmt.run(crypto.randomUUID(), userId, pick(planWeights).id, 30, 199, 'canceled', sql(t), null, null, null, null, null);
            }
            continue;
        }

        let paidAt = (trial ? trial + 3 * DAY : created) + Math.floor(rand() * 2 * DAY);
        let expire = 0;
        let plan = pick(planWeights);
        let first = true;
        while (paidAt < now) {
            if (chance(0.2)) {
                // Сначала бросил оплату, потом вернулся
                orderStmt.run(crypto.randomUUID(), userId, plan.id, plan.days, plan.price, 'canceled', sql(paidAt - 3_600_000), null, null, null, null, null);
            }
            const promo = first && chance(0.2) ? PROMOS[Math.floor(rand() * PROMOS.length)] : null;
            const amount = promo ? Math.round(plan.price * (promo === 'WELCOME20' ? 0.8 : 0.85)) : plan.price;
            const r = rand();
            const status = r < 0.03 ? 'refunded' : r < 0.04 ? 'chargeback' : 'applied';
            orderStmt.run(
                crypto.randomUUID(), userId, plan.id, plan.days, amount, status, sql(paidAt - 60_000), sql(paidAt), sql(paidAt + 30_000),
                status === 'refunded' ? sql(paidAt + DAY) : null, promo, promo ? plan.price : null,
            );
            orders++;
            if (status !== 'applied') break;
            expire = Math.max(expire, paidAt) + plan.days * DAY;

            // Напоминания за 3 и за 1 день
            const expireIso = new Date(expire).toISOString();
            for (const d of [3, 1]) if (expire - d * DAY < now) reminderStmt.run(userId, expireIso, d, sql(expire - d * DAY + 3_600_000));

            if (!chance(0.62)) break; // не продлил
            // Продлевает за пару дней до окончания, иногда — после перерыва
            paidAt = chance(0.8) ? expire - Math.floor(rand() * 3 * DAY) : expire + Math.floor((2 + rand() * 30) * DAY);
            if (chance(0.25)) plan = pick(planWeights);
            first = false;
        }
        db.prepare("UPDATE users SET plan_kind = 'paid' WHERE id = ?").run(userId);
    }
    console.log(`Демо-данные: ${USERS} клиентов, ${orders} оплат за год (адреса *@${DOMAIN}). Откройте «Аналитику» в админке.`);
});
