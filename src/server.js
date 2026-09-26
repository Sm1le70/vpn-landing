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
    syncOrderForClient,
    trialAvailable,
    trialDisposable,
} from './subscriptions.js';
import { renderPage } from './pages.js';
import { verifyWebhook } from './resend.js';
import { enqueueInbound, startSupportJobs } from './support.js';
import { telegramEnabled, telegramWebhookSecret } from './telegram.js';
import { createLinkUrl, enqueueUpdate, startTelegramSupport, supportBotUsername } from './tgsupport.js';
import { startEmailNotify } from './tgnotify.js';
import { startAlerts } from './alerts.js';
import { applyPromo } from './promo.js';
import { applyChargeback } from './admin/service.js';
import { every, staleJobs } from './jobs.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

// CSP сайта: скрипты, стили, шрифты и картинки — только свои (сторонних ресурсов на сайте нет).
// У админки свой CSP (src/admin/routes.js).
const SITE_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');

app.use((_req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': SITE_CSP,
    });
    // Браузер запомнит, что сайт только на https (полгода). Для http (локальный запуск, демо) не отправляется.
    if (config.isHttps) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
});

// ---------- Проверка работоспособности (Docker HEALTHCHECK, мониторинг) ----------

// 200 — база отвечает и фоновые задачи не зависли, иначе 503. Наружу — только названия зависших задач.
app.get('/healthz', (_req, res) => {
    let dbOk = true;
    try {
        db.prepare('SELECT 1').get();
    } catch (err) {
        dbOk = false;
        console.error('[healthz] база:', err.message);
    }
    const stale = staleJobs();
    const ok = dbOk && stale.length === 0;
    res.status(ok ? 200 : 503).set('Cache-Control', 'no-store').json({ ok, db: dbOk ? 'ok' : 'error', staleJobs: stale });
});

// ---------- Вебхуки (до json-парсера: Remnawave подписывает сырое тело) ----------

app.post('/webhooks/remnawave', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const secret = config.remnawave.webhookSecret;
    if (!secret) return res.status(503).json({ error: 'webhook secret not configured' });

    const signature = Buffer.from(String(req.headers['x-remnawave-signature'] ?? ''));
    const expected = Buffer.from(crypto.createHmac('sha256', secret).update(req.body).digest('hex'));
    if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
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

// Бот поддержки в Telegram. Секрет приходит в заголовке X-Telegram-Bot-Api-Secret-Token.
app.post('/webhooks/telegram', express.json({ limit: '1mb' }), (req, res) => {
    if (!telegramEnabled()) return res.status(404).json({ error: 'not found' });
    const got = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''));
    const expected = Buffer.from(telegramWebhookSecret());
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return res.status(401).json({ error: 'unauthorized' });
    try {
        // Обновление ставится в очередь; повторная доставка того же update_id ничего не создаёт
        enqueueUpdate(req.body);
        res.json({ ok: true });
    } catch (err) {
        console.error('[webhook telegram]', err.message);
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
            // Статус перепроверяется через API; снятие дней, журнал и алерт — в applyChargeback
            await applyChargeback(order);
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[webhook platega]', err.message);
        res.status(500).json({ error: 'temporary error' });
    }
});

// ---------- Админка (секретный путь) ----------

if (config.admin.path) app.use(config.admin.path, adminRouter());

// ---------- Статика (до сессий: запрос за стилем или скриптом не обращается к базе) ----------

// Ссылки на скрипты и стили содержат ?v=<хэш содержимого> (src/pages.js): по такому адресу файл не меняется —
// браузер хранит его год и не перепроверяет. Остальное (шрифты, иконка) — час.
app.use(
    '/assets',
    express.static(path.join(ROOT_DIR, 'public', 'assets'), {
        maxAge: '1h',
        setHeaders: (res) => {
            if (res.req.query.v) res.set('Cache-Control', 'public, max-age=31536000, immutable');
        },
    }),
);

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
every('cleanup', 10 * 60 * 1000, () => {
    const now = Date.now();
    for (const [k, arr] of hits) if (arr.every((t) => now - t > 60 * 60 * 1000)) hits.delete(k);
    cleanupExpired();
    cleanupAdminAuth();
});

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
            .prepare('SELECT id, plan_id, amount, status, created_at, paid_at, payment_url, payment_expires_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
            .all(req.user.id)
            .map(({ payment_url, payment_expires_at, ...o }) => ({
                ...o,
                planTitle: getPlan(o.plan_id, { includeHidden: true })?.title ?? o.plan_id,
                canPay: o.status === 'pending' && paymentLinkAlive({ payment_url, payment_expires_at }),
            }));
        res.json({
            email: req.user.email,
            trialAvailable: trialAvailable(req.user),
            trialDisposable: trialDisposable(req.user),
            subscription,
            subscriptionError,
            orders,
            telegramSupport: Boolean(supportBotUsername()),
        });
    }),
);

// Ссылка на бота поддержки с одноразовым токеном: по ней бот привязывает Telegram к аккаунту
app.post(
    '/api/me/telegram-link',
    requireUser,
    wrap(async (req, res) => {
        if (!rateLimit(`tglink:${req.user.id}`, 10, 60 * 60 * 1000)) {
            return res.status(429).json({ error: 'Слишком много запросов, попробуйте позже' });
        }
        const url = createLinkUrl(req.user.id);
        if (!url) return res.status(404).json({ error: 'Поддержка в Telegram сейчас не подключена, напишите на почту' });
        res.json({ url });
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

        // Промокод проверяется ещё раз при создании заказа; засчитывается, когда заказ оплачен
        const promo = String(req.body?.promoCode ?? '').trim() ? applyPromo(req.body.promoCode, plan, req.user.id) : null;
        const amount = promo ? promo.price : plan.price;

        const orderId = crypto.randomUUID();
        db.prepare('INSERT INTO orders (id, user_id, plan_id, days, amount, promo_code, price_before) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            orderId,
            req.user.id,
            plan.id,
            plan.days,
            amount,
            promo?.code ?? null,
            promo ? plan.price : null,
        );
        try {
            const { transactionId, paymentUrl, expiresAt } = await createPayment({
                orderId,
                amount,
                description: `Подписка ${getSettings().brandName}: ${plan.title}`,
                userId: req.user.id,
                email: req.user.email,
            });
            db.prepare('UPDATE orders SET platega_tx_id = ?, payment_url = ?, payment_expires_at = ? WHERE id = ?').run(
                transactionId,
                paymentUrl,
                expiresAt,
                orderId,
            );
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
                order = await syncOrderForClient(order);
            } catch (err) {
                console.error(`[order ${order.id}] сверка:`, err.message);
            }
        }
        res.json({ id: order.id, status: order.status, planTitle: getPlan(order.plan_id, { includeHidden: true })?.title, amount: order.amount });
    }),
);

// Проверка промокода до оплаты: новая цена для выбранного тарифа
app.post(
    '/api/promo/check',
    requireUser,
    wrap(async (req, res) => {
        // Ограничение — чтобы промокоды нельзя было подбирать
        if (!rateLimit(`promo:${req.user.id}`, 20, 60 * 60 * 1000)) {
            return res.status(429).json({ error: 'Слишком много попыток ввода промокода, попробуйте через час' });
        }
        const plan = getPlan(req.body?.planId);
        if (!plan) return res.status(400).json({ error: 'Тариф не найден' });
        const { code, price, priceBefore } = applyPromo(req.body?.code, plan, req.user.id);
        res.json({ code, price, priceBefore });
    }),
);

// Ссылку Platega можно открыть снова, пока не истёк её срок (если Platega его не сообщила — в пределах ORDER_PAY_HOURS)
const paymentLinkAlive = (order) =>
    Boolean(order.payment_url) && (!order.payment_expires_at || new Date(order.payment_expires_at) > new Date());

// Повторный переход к оплате неоплаченного заказа (если пользователь ушёл со страницы Platega)
app.post(
    '/api/orders/:id/pay',
    requireUser,
    wrap(async (req, res) => {
        let order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
        if (!order) return res.status(404).json({ error: 'Заказ не найден' });
        if (order.status === 'pending') {
            try {
                order = await syncOrderForClient(order);
            } catch (err) {
                console.error(`[order ${order.id}] сверка:`, err.message);
            }
        }
        if (order.status === 'paid' || order.status === 'applied') return res.json({ status: order.status });
        if (order.status !== 'pending' || !paymentLinkAlive(order)) {
            return res.status(409).json({ error: 'Срок оплаты этого заказа истёк. Выберите тариф и оформите новый платёж.' });
        }
        res.json({ status: order.status, paymentUrl: order.payment_url });
    }),
);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Страницы ----------


const pages = { '/': 'index', '/cabinet': 'cabinet', '/privacy': 'privacy', '/terms': 'terms', '/contacts': 'contacts' };
for (const [route, name] of Object.entries(pages)) {
    app.get(route, (_req, res) => res.type('html').send(renderPage(name)));
}
app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /cabinet\nDisallow: /api/\n'));
app.use((_req, res) => res.status(404).type('html').send(renderPage('404')));

const server = app.listen(config.port, () => {
    console.log(`[server] ${getSettings().brandName} слушает :${config.port} (${config.siteUrl})`);
    startBackgroundJobs();
    startSupportJobs();
    startTelegramSupport();
    startEmailNotify();
    startAlerts();
    if (config.admin.demoNo2fa) ensureDemoAdmin();
    ensureBootstrap();
    if (config.admin.path) console.log(`[server] админка: ${config.siteUrl}${config.admin.path}/`);
});

// Корректная остановка (docker stop / Ctrl+C): закрываем базу, чтобы SQLite перенёс WAL в основной файл.
// Docker ждёт 10 с и затем убивает процесс, поэтому ждём незавершённые запросы не дольше 8 с.
let stopping = false;
function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal}: остановка`);
    const exit = () => {
        try {
            db.close();
        } catch (err) {
            console.error('[server] закрытие базы:', err.message);
        }
        process.exit(0);
    };
    server.close(exit);
    server.closeIdleConnections();
    setTimeout(exit, 8_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
