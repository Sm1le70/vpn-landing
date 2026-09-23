import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { config, ROOT_DIR } from './config.js';
import { getSettings, listPlans, getPlan, getApps } from './settings.js';
import { adminRouter } from './admin/routes.js';
import { cleanupAdminAuth, ensureBootstrap, ensureDemoAdmin } from './admin/auth.js';
import { db } from './db.js';
import {
    AuthError,
    SESSION_COOKIE,
    cleanupExpired,
    destroySession,
    isValidEmail,
    normalizeEmail,
    requestLoginCode,
    sessionCookieOptions,
    sessionMiddleware,
    verifyLoginCode,
} from './auth.js';
import { createPayment, getTransaction, isAuthenticCallback } from './platega.js';
import {
    UserFacingError,
    applyPaidOrder,
    getSubscriptionInfo,
    handleHwidDeviceAdded,
    markOrderPaid,
    startBackgroundJobs,
    startTrial,
    syncOrderWithPlatega,
    trialAvailable,
} from './subscriptions.js';
import { renderPage } from './pages.js';
import { verifyWebhook } from './resend.js';
import { enqueueInbound, startSupportJobs } from './support.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

app.use((_req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Frame-Options': 'DENY',
    });
    next();
});

// ---------- Вебхуки (до json-парсера: Remnawave подписывает сырое тело) ----------

app.post('/webhooks/remnawave', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const secret = config.remnawave.webhookSecret;
    if (!secret) return res.status(503).json({ error: 'webhook secret not configured' });

    const signature = String(req.headers['x-remnawave-signature'] ?? '');
    const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return res.status(401).json({ error: 'bad signature' });
    }

    let event;
    try {
        event = JSON.parse(req.body.toString('utf8'));
    } catch {
        return res.status(400).json({ error: 'bad json' });
    }
    res.json({ ok: true });

    if (event.event === 'user_hwid_devices.added') {
        const { user, hwidUserDevice } = event.data ?? {};
        if (user?.id && hwidUserDevice?.hwid) {
            handleHwidDeviceAdded(user.id, hwidUserDevice.hwid).catch((err) => console.error('[webhook remnawave]', err.message));
        }
    }
});

// Входящая почта поддержки (Resend Inbound, событие email.received). Подпись — по схеме Svix.
app.post('/webhooks/resend-inbound', express.raw({ type: '*/*', limit: '256kb' }), (req, res) => {
    const secret = config.support.inboundWebhookSecret;
    if (!secret) return res.status(503).json({ error: 'webhook secret not configured' });
    if (!Buffer.isBuffer(req.body) || !verifyWebhook(req.body, req.headers, secret)) {
        return res.status(401).json({ error: 'bad signature' });
    }

    let event;
    try {
        event = JSON.parse(req.body.toString('utf8'));
    } catch {
        return res.status(400).json({ error: 'bad json' });
    }
    if (event.type !== 'email.received') return res.json({ ok: true, ignored: true });
    try {
        // Письмо ставится в очередь; повторная доставка того же email_id ничего не создаёт
        enqueueInbound(event.data);
        res.json({ ok: true });
    } catch (err) {
        console.error('[webhook resend-inbound]', err.message);
        res.status(500).json({ error: 'temporary error' });
    }
});

app.post('/webhooks/platega', express.json({ limit: '100kb' }), async (req, res) => {
    if (!isAuthenticCallback(req.headers)) return res.status(401).json({ error: 'unauthorized' });

    // Поля приходят как в camelCase, так и в PascalCase (callback подписок).
    const body = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const txId = String(body.id ?? '');
    const status = String(body.status ?? '');

    const order =
        db.prepare('SELECT * FROM orders WHERE platega_tx_id = ?').get(txId) ??
        (body.payload ? db.prepare('SELECT * FROM orders WHERE id = ?').get(String(body.payload)) : undefined);
    if (!order) {
        console.warn(`[webhook platega] заказ для транзакции ${txId} не найден`);
        return res.json({ ok: true });
    }

    try {
        if (status === 'CONFIRMED') {
            // Не доверяем телу callback'а: перепроверяем транзакцию через API.
            const transaction = await getTransaction(order.platega_tx_id ?? txId);
            if (transaction.status === 'CONFIRMED' && markOrderPaid(order, transaction)) {
                applyPaidOrder(order.id).catch((err) => console.error('[webhook platega]', err));
            }
        } else if (status === 'CANCELED') {
            db.prepare("UPDATE orders SET status = 'canceled' WHERE id = ? AND status = 'pending'").run(order.id);
        } else if (status === 'CHARGEBACKED') {
            db.prepare("UPDATE orders SET status = CASE WHEN status IN ('refunded', 'refund_pending') THEN 'refunded' ELSE 'chargeback' END WHERE id = ?").run(order.id);
            console.warn(`[webhook platega] возврат средств по заказу ${order.id} (user ${order.user_id})`);
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[webhook platega]', err.message);
        res.status(500).json({ error: 'temporary error' });
    }
});

// ---------- Админка (секретный путь) ----------

if (config.admin.path) app.use(config.admin.path, adminRouter());

// ---------- API ----------

app.use(express.json({ limit: '20kb' }));
app.use(sessionMiddleware);

// Защита от CSRF: изменяющие запросы принимаем только со своего origin.
const siteOrigin = new URL(config.siteUrl).origin;
app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== siteOrigin) {
        return res.status(403).json({ error: 'Запрос отклонён' });
    }
    next();
});

// Простой лимит запросов в памяти.
const hits = new Map();
function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= max;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) if (arr.every((t) => now - t > 60 * 60 * 1000)) hits.delete(k);
    cleanupExpired();
    cleanupAdminAuth();
}, 10 * 60 * 1000).unref();

const wrap = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        if (err instanceof AuthError || err instanceof UserFacingError) return res.status(400).json({ error: err.message });
        console.error(`[api ${req.method} ${req.path}]`, err);
        res.status(500).json({ error: 'Внутренняя ошибка. Попробуйте позже или напишите в поддержку.' });
    }
};

const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Требуется вход' }));

app.get('/api/config', (_req, res) => {
    res.json({
        brandName: getSettings().brandName,
        plans: listPlans(),
        apps: getApps(),
        paidDeviceLimit: getSettings().paidDeviceLimit,
        trial: { enabled: getSettings().trialEnabled, days: getSettings().trialDays, deviceLimit: getSettings().trialDeviceLimit },
    });
});

app.post(
    '/api/auth/request-code',
    wrap(async (req, res) => {
        const email = normalizeEmail(req.body?.email);
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Введите корректный email' });
        if (!rateLimit(`code:${req.ip}`, 6, 15 * 60 * 1000)) {
            return res.status(429).json({ error: 'Слишком много запросов, попробуйте позже' });
        }
        await requestLoginCode(email);
        res.json({ ok: true });
    }),
);

app.post(
    '/api/auth/verify',
    wrap(async (req, res) => {
        if (!rateLimit(`verify:${req.ip}`, 20, 15 * 60 * 1000)) {
            return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
        }
        const email = normalizeEmail(req.body?.email);
        const { token } = verifyLoginCode(email, req.body?.code);
        res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
        res.json({ ok: true });
    }),
);

app.post('/api/auth/logout', (req, res) => {
    destroySession(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
});

app.get(
    '/api/me',
    requireUser,
    wrap(async (req, res) => {
        let subscription = null;
        let subscriptionError = false;
        try {
            subscription = await getSubscriptionInfo(req.user);
        } catch (err) {
            console.error('[api /me] Remnawave:', err.message);
            subscriptionError = true;
        }
        const orders = db
            .prepare('SELECT id, plan_id, amount, status, created_at, paid_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
            .all(req.user.id)
            .map((o) => ({ ...o, planTitle: getPlan(o.plan_id, { includeHidden: true })?.title ?? o.plan_id }));
        res.json({
            email: req.user.email,
            trialAvailable: trialAvailable(req.user),
            subscription,
            subscriptionError,
            orders,
        });
    }),
);

app.get(
    '/api/me/qr.svg',
    requireUser,
    wrap(async (req, res) => {
        const info = await getSubscriptionInfo(req.user);
        if (!info?.subscriptionUrl) return res.status(404).end();
        const svg = await QRCode.toString(info.subscriptionUrl, { type: 'svg', margin: 1, color: { dark: '#0b0f17', light: '#ffffff' } });
        res.type('image/svg+xml').set('Cache-Control', 'private, no-store').send(svg);
    }),
);

app.post(
    '/api/trial',
    requireUser,
    wrap(async (req, res) => {
        await startTrial(req.user.id);
        res.json({ ok: true });
    }),
);

app.post(
    '/api/orders',
    requireUser,
    wrap(async (req, res) => {
        const plan = getPlan(req.body?.planId);
        if (!plan) return res.status(400).json({ error: 'Тариф не найден' });
        if (req.user.blocked) {
            return res.status(403).json({ error: 'Доступ к аккаунту приостановлен. Обратитесь в поддержку.' });
        }
        if (req.body?.agree !== true) {
            return res.status(400).json({ error: 'Необходимо принять пользовательское соглашение и политику конфиденциальности' });
        }
        if (!rateLimit(`order:${req.user.id}`, 10, 60 * 60 * 1000)) {
            return res.status(429).json({ error: 'Слишком много попыток оплаты, попробуйте позже' });
        }

        const orderId = crypto.randomUUID();
        db.prepare('INSERT INTO orders (id, user_id, plan_id, days, amount) VALUES (?, ?, ?, ?, ?)').run(
            orderId,
            req.user.id,
            plan.id,
            plan.days,
            plan.price,
        );
        try {
            const { transactionId, paymentUrl } = await createPayment({
                orderId,
                amount: plan.price,
                description: `Подписка ${getSettings().brandName}: ${plan.title}`,
                userId: req.user.id,
                email: req.user.email,
            });
            db.prepare('UPDATE orders SET platega_tx_id = ?, payment_url = ? WHERE id = ?').run(transactionId, paymentUrl, orderId);
            res.json({ orderId, paymentUrl });
        } catch (err) {
            db.prepare("UPDATE orders SET status = 'canceled', error = ? WHERE id = ?").run(String(err.message).slice(0, 500), orderId);
            throw err;
        }
    }),
);

app.get(
    '/api/orders/:id',
    requireUser,
    wrap(async (req, res) => {
        let order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
        if (!order) return res.status(404).json({ error: 'Заказ не найден' });
        if (order.status === 'pending') {
            try {
                order = await syncOrderWithPlatega(order);
            } catch (err) {
                console.error(`[order ${order.id}] сверка:`, err.message);
            }
        }
        res.json({ id: order.id, status: order.status, planTitle: getPlan(order.plan_id, { includeHidden: true })?.title, amount: order.amount });
    }),
);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Страницы ----------

app.use('/assets', express.static(path.join(ROOT_DIR, 'public', 'assets'), { maxAge: '1h' }));

const pages = { '/': 'index', '/cabinet': 'cabinet', '/privacy': 'privacy', '/terms': 'terms', '/contacts': 'contacts' };
for (const [route, name] of Object.entries(pages)) {
    app.get(route, (_req, res) => res.type('html').send(renderPage(name)));
}
app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /cabinet\nDisallow: /api/\n'));
app.use((_req, res) => res.status(404).type('html').send(renderPage('404')));

app.listen(config.port, () => {
    console.log(`[server] ${getSettings().brandName} слушает :${config.port} (${config.siteUrl})`);
    startBackgroundJobs();
    startSupportJobs();
    if (config.admin.demoNo2fa) ensureDemoAdmin();
    ensureBootstrap();
    if (config.admin.path) console.log(`[server] админка: ${config.siteUrl}${config.admin.path}/`);
});
