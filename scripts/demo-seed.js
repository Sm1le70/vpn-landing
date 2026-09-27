// Демо: история клиентов и платежей за год для раздела «Аналитика» (только демо-база).
// npm run demo:seed — можно запускать и при работающем npm run demo; повторный запуск заменяет прежние данные.
// Клиенты создаются без подписки в панели: их видно в аналитике и в списках, но не в заглушке Remnawave.
// Визиты на сайт (id вида seedN) тоже заменяются; итоги посещений по дням (web_daily) пересчитываются целиком.
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
const { rollupAndCleanup } = await import('../src/tracking.js');

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
// Источники первого визита
const SOURCES = [
    [{ source: 'direct' }, 30],
    [{ source: 'telegram', referrer: 't.me' }, 25],
    [{ source: 'anna', medium: 'ref' }, 8],
    [{ source: 'max', medium: 'ref' }, 7],
    [{ source: 'tg_channel', medium: 'post', campaign: 'summer' }, 10],
    [{ source: 'tg_channel', medium: 'post', campaign: 'autumn' }, 10],
    [{ source: 'google', referrer: 'google.com' }, 10],
];
const DEVICES = [[['mobile', 'iOS'], 38], [['mobile', 'Android'], 32], [['desktop', 'Windows'], 18], [['desktop', 'macOS'], 7], [['tablet', 'iOS'], 5]];
const LOOK_CLICKS = ['hero_pricing', 'faq:payment', 'faq:devices', 'faq:refund', 'faq:autopay', 'nav_pricing', 'support_telegram'];

tx(() => {
    const old = db.prepare('SELECT id FROM users WHERE email LIKE ?').all(`%@${DOMAIN}`).map((u) => u.id);
    for (const id of old) {
        db.prepare('DELETE FROM expiry_reminders WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM orders WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    db.exec("DELETE FROM web_events WHERE vid LIKE 'seed%'; DELETE FROM visitors WHERE vid LIKE 'seed%'; DELETE FROM web_daily");
    const visitorStmt = db.prepare(
        'INSERT INTO visitors (vid, first_seen, source, medium, campaign, referrer, landing, device, os) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const eventStmt = db.prepare('INSERT INTO web_events (vid, kind, name, user_id, created_at) VALUES (?, ?, ?, ?, ?)');
    let visits = 0;
    // Визит на сайт; client — клиент, который в этот раз вошёл в кабинет
    const visit = (t0, client = null) => {
        const vid = `seed${++visits}`;
        const src = pick(SOURCES);
        const [device, os] = pick(DEVICES);
        visitorStmt.run(vid, t0, src.source, src.medium ?? null, src.campaign ?? null, src.referrer ?? null, '/', device, os);
        let t = t0;
        const ev = (kind, name = null, userId = null) => eventStmt.run(vid, kind, name, userId, (t += Math.floor(5_000 + rand() * 60_000)));
        ev('view', '/');
        if (client || chance(0.45)) ev('click', 'pricing_seen');
        if (chance(0.3)) ev('click', LOOK_CLICKS[Math.floor(rand() * LOOK_CLICKS.length)]);
        if (chance(0.06)) ev('view', chance(0.5) ? '/privacy' : '/terms');
        if (client) {
            ev('click', client.trial ? 'trial' : `plan:${pick(planWeights).id}`);
            ev('view', '/cabinet');
            ev('code');
            ev('login', null, client.id);
            return src;
        }
        if (chance(0.15)) {
            ev('click', chance(0.3) ? 'trial' : `plan:${pick(planWeights).id}`);
            ev('view', '/cabinet');
            if (chance(0.45)) ev('code');
        }
        return src;
    };

    const promoStmt = db.prepare("INSERT OR IGNORE INTO promo_codes (code, kind, value, note) VALUES (?, 'percent', ?, 'демо')");
    promoStmt.run('WELCOME20', 20);
    promoStmt.run('FRIEND15', 15);

    const userStmt = db.prepare("INSERT INTO users (email, plan_kind, trial_used_at, created_at, first_login_at) VALUES (?, ?, ?, ?, ?)");
    const orderStmt = db.prepare(
        `INSERT INTO orders (id, user_id, plan_id, days, amount, status, created_at, paid_at, applied_at, refunded_at, promo_code, price_before)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const reminderStmt = db.prepare('INSERT OR IGNORE INTO expiry_reminders (user_id, expire_at, days_before, sent_at) VALUES (?, ?, ?, ?)');
    let orders = 0;
    // Активация по «данным панели»: ссылка добавлена в приложение → подключился → есть трафик
    const activityStmt = db.prepare(
        `UPDATE users SET rw_first_device_at = ?, rw_first_connected_at = ?, rw_online_at = ?, rw_lifetime_traffic = ?, rw_activity_at = ?
         WHERE id = ?`,
    );
    const activate = (userId, start) => {
        const device = chance(0.88) ? start + Math.floor((5 + rand() * 600) * 60_000) : null;
        const connected = device && chance(0.9) ? device + Math.floor((1 + rand() * 120) * 60_000) : null;
        const bytes = connected && chance(0.95) ? Math.floor(rand() * 40e9) : 0;
        const iso = (t) => (t && t < now ? new Date(t).toISOString() : null);
        activityStmt.run(iso(device), iso(connected), iso(connected), bytes, new Date(now).toISOString(), userId);
    };

    for (let i = 1; i <= USERS; i++) {
        // Приток клиентов растёт к сегодняшнему дню
        const created = now - Math.floor(365 * DAY * (1 - Math.sqrt(rand())));
        const trial = chance(0.45) ? created + Math.floor(rand() * 2 * 3_600_000) : null;
        const { lastInsertRowid: userId } = userStmt.run(`seed-${i}@${DOMAIN}`, trial ? 'trial' : 'none', trial ? sql(trial) : null, sql(created), sql(created));
        const firstVisit = created - Math.floor((0.1 + rand() * 2) * 3_600_000);
        const src = visit(firstVisit, { id: userId, trial });
        db.prepare('UPDATE users SET source = ?, utm_medium = ?, utm_campaign = ?, referrer = ?, landing = ?, first_visit_at = ? WHERE id = ?')
            .run(src.source, src.medium ?? null, src.campaign ?? null, src.referrer ?? null, '/', sql(firstVisit), userId);
        // Посетители, которые так и не вошли в кабинет
        for (let k = 0; k < 3; k++) visit(now - Math.floor(365 * DAY * (1 - Math.sqrt(rand()))));

        if (trial) activate(userId, trial);
        if (!chance(trial ? 0.5 : 0.4)) {
            // Зашёл, но не купил; часть бросила оплату
            if (chance(0.35)) {
                const t = created + Math.floor(rand() * 3 * DAY);
                if (t < now) orderStmt.run(crypto.randomUUID(), userId, pick(planWeights).id, 30, 199, 'canceled', sql(t), null, null, null, null, null);
            }
            continue;
        }

        let paidAt = (trial ? trial + 3 * DAY : created) + Math.floor(rand() * 2 * DAY);
        if (!trial && paidAt < now) activate(userId, paidAt);
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
    console.log(`Демо-данные: ${USERS} клиентов, ${orders} оплат, ${visits} посетителей за год (адреса *@${DOMAIN}). Откройте «Аналитику» в админке.`);
});
// Как на рабочем сайте: сутки сворачиваются в итоги, визиты старше 90 дней удаляются
rollupAndCleanup(now);
