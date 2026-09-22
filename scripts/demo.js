// Демо-режим: сайт + заглушки Platega и Remnawave, без реальных ключей и оплаты.
// Запуск: npm run demo  →  http://localhost:3000
import http from 'node:http';
import crypto from 'node:crypto';

const APP_PORT = Number(process.env.DEMO_PORT) || 3000;
const MOCK_PORT = APP_PORT + 999;
const APP = `http://localhost:${APP_PORT}`;
const MOCK = `http://localhost:${MOCK_PORT}`;

// Значения из этого файла имеют приоритет над .env
Object.assign(process.env, {
    PORT: String(APP_PORT),
    SITE_URL: APP,
    APP_SECRET: 'demo-secret',
    DATABASE_PATH: APP_PORT === 3000 ? './data/demo.db' : `./data/demo-${APP_PORT}.db`,
    REMNAWAVE_URL: MOCK,
    REMNAWAVE_TOKEN: 'demo',
    REMNAWAVE_SQUADS: '',
    REMNAWAVE_WEBHOOK_SECRET: 'demo',
    PLATEGA_URL: MOCK,
    PLATEGA_MERCHANT_ID: 'demo-merchant',
    PLATEGA_SECRET: 'demo-secret',
    RESEND_API_KEY: '', // письма (и коды входа) выводятся в консоль
    ADMIN_PATH: '/admin-demo',
    DEMO_ADMIN_NO_2FA: 'true', // в демо вход в админку без 2FA: admin / admin и support / support
});

const transactions = new Map();
const users = new Map();
let nextUserId = 1;
// Демо-устройства: у каждой новой подписки появляется одно «подключённое» устройство
const devices = new Map();

const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
};

const payPage = (t) => `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Тестовая оплата</title>
<body style="font-family:system-ui;background:#f3f4f6;display:grid;place-items:center;min-height:100vh;margin:0">
<form method="post" style="background:#fff;padding:32px;border-radius:16px;box-shadow:0 10px 30px #0001;max-width:360px;width:100%">
<p style="color:#6b7280;margin:0">ТЕСТОВАЯ ПЛАТЁЖНАЯ СТРАНИЦА (демо)</p>
<h2 style="margin:8px 0">${t.paymentDetails.amount} ₽</h2>
<p>${t.description}</p>
<button name="action" value="pay" style="width:100%;padding:14px;border:0;border-radius:10px;background:#16a34a;color:#fff;font-size:16px;cursor:pointer">Оплатить</button>
<button name="action" value="cancel" style="width:100%;padding:12px;margin-top:8px;border:1px solid #d1d5db;border-radius:10px;background:#fff;cursor:pointer">Отменить</button>
</form></body></html>`;

async function sendCallback(t) {
    await fetch(`${APP}/webhooks/platega`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MerchantId': 'demo-merchant', 'X-Secret': 'demo-secret' },
        body: JSON.stringify({ id: t.id, amount: t.paymentDetails.amount, currency: 'RUB', status: t.status, paymentMethod: 2, payload: t.payload }),
    }).catch((err) => console.error('[demo] callback:', err.message));
}

http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
        const path = new URL(req.url, MOCK).pathname;
        const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : {};
        let m;

        // ---- Platega ----
        if (path === '/v2/transaction/process' && req.method === 'POST') {
            const id = crypto.randomUUID();
            transactions.set(id, { id, status: 'PENDING', ...body });
            return json(res, 200, { transactionId: id, status: 'PENDING', url: `${MOCK}/pay/${id}`, expiresIn: '00:15:00' });
        }
        if ((m = path.match(/^\/transaction\/([\w-]+)\/cancel-supported$/))) {
            return json(res, 200, { supported: true, totalDeductUsdt: 2.15, penaltyUsdt: 0, penaltyNativeAmount: 0, penaltyNativeCurrency: 'RUB', penaltyConversionRate: 0, blockReason: '' });
        }
        if ((m = path.match(/^\/transaction\/([\w-]+)\/cancel$/))) {
            const t = transactions.get(m[1]);
            if (t) t.status = 'CHARGEBACKED';
            return json(res, 200, { transactionId: m[1], accepted: true, manualControlRequired: false, message: 'Возврат выполнен (демо)' });
        }
        if ((m = path.match(/^\/transaction\/([\w-]+)$/))) {
            const t = transactions.get(m[1]);
            return t ? json(res, 200, t) : json(res, 404, {});
        }
        if ((m = path.match(/^\/pay\/([\w-]+)$/))) {
            const t = transactions.get(m[1]);
            if (!t) return json(res, 404, {});
            if (req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(payPage(t));
            }
            const paid = new URLSearchParams(raw).get('action') === 'pay';
            t.status = paid ? 'CONFIRMED' : 'CANCELED';
            await sendCallback(t);
            res.writeHead(302, { Location: paid ? t.return : t.failedUrl });
            return res.end();
        }

        // ---- Remnawave ----
        if (path === '/api/users' && req.method === 'POST') {
            const id = nextUserId++;
            const user = { id, status: 'ACTIVE', ...body, subscriptionUrl: `https://sub.demo.local/${crypto.randomBytes(8).toString('hex')}` };
            users.set(id, user);
            devices.set(id, [{ hwid: crypto.randomBytes(6).toString('hex'), userId: id, platform: 'Android', osVersion: '14', deviceModel: 'Pixel 8', userAgent: 'Happ/3.0', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
            return json(res, 201, { response: user });
        }
        if (path === '/api/users' && req.method === 'PATCH') {
            const user = users.get(body.id);
            if (!user) return json(res, 404, { message: 'User not found' });
            Object.assign(user, body);
            return json(res, 200, { response: user });
        }
        if ((m = path.match(/^\/api\/users\/(\d+)$/))) {
            const user = users.get(Number(m[1]));
            return user ? json(res, 200, { response: user }) : json(res, 404, { message: 'User not found' });
        }
        if ((m = path.match(/^\/api\/users\/(\d+)\/actions\/disable$/))) {
            const user = users.get(Number(m[1]));
            user.status = 'DISABLED';
            return json(res, 200, { response: user });
        }
        if ((m = path.match(/^\/api\/users\/(\d+)\/actions\/enable$/))) {
            const user = users.get(Number(m[1]));
            user.status = new Date(user.expireAt) > new Date() ? 'ACTIVE' : 'EXPIRED';
            return json(res, 200, { response: user });
        }
        if ((m = path.match(/^\/api\/users\/(\d+)\/actions\/revoke$/))) {
            const user = users.get(Number(m[1]));
            user.subscriptionUrl = `https://sub.demo.local/${crypto.randomBytes(8).toString('hex')}`;
            return json(res, 200, { response: user });
        }
        if (path === '/api/hwid/devices/delete-all') {
            devices.delete(body.userId);
            return json(res, 200, { response: { total: 0, devices: [] } });
        }
        if ((m = path.match(/^\/api\/hwid\/devices\/(\d+)$/))) {
            const list = devices.get(Number(m[1])) ?? [];
            return json(res, 200, { response: { total: list.length, devices: list } });
        }

        json(res, 404, { message: 'demo: route not mocked' });
    });
}).listen(MOCK_PORT, async () => {
    await import('../src/server.js');
    console.log(`
==============================================================
  ДЕМО-РЕЖИМ: платежи и панель — заглушки, деньги не списываются
  Откройте: ${APP}
  Код входа в кабинет появится здесь, в консоли ("Код входа: ...")
  Админка:  ${APP}/admin-demo/  (admin / admin, support / support)
  База демо: data/demo.db (удалите файл, чтобы начать заново)
==============================================================
`);
});
