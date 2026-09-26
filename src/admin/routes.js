// Админка: интерфейс и API по секретному пути config.admin.path.
import path from 'node:path';
import express from 'express';
import { config, ROOT_DIR } from '../config.js';
import { db } from '../db.js';
import { supportBotUsername, userTelegram } from '../tgsupport.js';
import { getSettings, saveSettings, listPlans, savePlans, getApps, saveApps, ValidationError } from '../settings.js';
import {
    ADMIN_COOKIE,
    AdminAuthError,
    ROLES,
    createSession,
    createSetupToken,
    destroyAdminSessions,
    destroySession,
    getSessionAdmin,
    passwordStep,
    secondFactorStep,
    sessionCookieOptions,
    setupFinish,
    setupInfo,
    setupStart,
    validateLogin,
} from './auth.js';
import * as svc from './service.js';
import * as support from './support.js';

const UI_DIR = path.join(ROOT_DIR, 'admin-ui');

function readCookie(req, name) {
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k !== name) continue;
        try {
            return decodeURIComponent(v.join('='));
        } catch {
            return null; // битое значение cookie — считаем, что сессии нет
        }
    }
    return null;
}

const publicAdmin = (a) => ({ id: a.id, login: a.login, role: a.role, roleTitle: ROLES[a.role] });

export function adminRouter() {
    const router = express.Router();
    const siteOrigin = new URL(config.siteUrl).origin;

    // CSP админки: скрипты только свои — даже если содержимое чужого письма обойдёт экранирование, оно не выполнится.
    // Встроенные стили (атрибуты style) разрешены: интерфейс ими пользуется. HTML письма и вложения отдаются со своим CSP.
    const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ].join('; ');
    router.use((_req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': csp });
        next();
    });

    // ---------- Интерфейс ----------
    router.get('/', (req, res) => {
        // Без завершающего слэша относительные пути ассетов сломаются
        if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(301, `${config.admin.path}/`);
        res.sendFile(path.join(UI_DIR, 'index.html'));
    });
    router.use('/assets', express.static(path.join(UI_DIR, 'assets'), { maxAge: 0 }));

    // ---------- API ----------
    const api = express.Router();
    router.use('/api', api);

    api.use(express.json({ limit: '200kb' }));
    api.use((req, res, next) => {
        if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== siteOrigin) {
            return res.status(403).json({ error: 'Запрос отклонён' });
        }
        req.adminToken = readCookie(req, ADMIN_COOKIE);
        req.admin = getSessionAdmin(req.adminToken);
        next();
    });

    const wrap = (fn) => async (req, res) => {
        try {
            const out = await fn(req, res);
            if (!res.headersSent) res.json(out ?? { ok: true });
        } catch (err) {
            // Ошибка посреди потоковой отдачи файла: ответ уже начат, остаётся оборвать соединение
            if (res.headersSent) {
                console.error(`[admin ${req.method} ${req.path}]`, err.message);
                return res.destroy();
            }
            if (err instanceof AdminAuthError || err instanceof svc.AdminActionError) return res.status(err.status).json({ error: err.message });
            if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
            console.error(`[admin ${req.method} ${req.path}]`, err);
            res.status(502).json({ error: `Ошибка: ${err.message}` });
        }
    };
    const auth = (req, res, next) => (req.admin ? next() : res.status(401).json({ error: 'Требуется вход' }));
    const adminOnly = (req, res, next) => (req.admin?.role === 'admin' ? next() : res.status(403).json({ error: 'Недостаточно прав' }));

    // --- вход ---
    api.post('/login', wrap(async (req, res) => {
        const { admin, ticket, done } = passwordStep(req.body?.login, req.body?.password, req.ip);
        if (done) {
            res.cookie(ADMIN_COOKIE, createSession(admin.id, req.ip), sessionCookieOptions());
            svc.audit(admin, 'auth.login', { details: { ip: req.ip, demo: true } });
            return { ok: true };
        }
        return { step: 'totp', ticket };
    }));

    api.post('/login/totp', wrap(async (req, res) => {
        const admin = secondFactorStep(req.body?.ticket, req.body?.code, req.ip);
        res.cookie(ADMIN_COOKIE, createSession(admin.id, req.ip), sessionCookieOptions());
        svc.audit(admin, 'auth.login', { details: { ip: req.ip } });
        return { ok: true };
    }));

    api.post('/logout', (req, res) => {
        destroySession(req.adminToken);
        res.clearCookie(ADMIN_COOKIE, { path: config.admin.path });
        res.json({ ok: true });
    });

    api.get('/me', auth, wrap((req) => ({
        admin: publicAdmin(req.admin),
        brandName: getSettings().brandName,
        supportMaxDays: svc.SUPPORT_MAX_EXTEND_DAYS,
        panelUrl: config.remnawave.url || null,
        demo: config.admin.demoNo2fa,
    })));

    // --- настройка доступа по одноразовой ссылке ---
    api.get('/setup/:token', wrap((req) => setupInfo(req.params.token)));
    api.post('/setup/:token/start', wrap((req) => setupStart(req.params.token, req.body ?? {})));
    api.post('/setup/:token/finish', wrap(async (req, res) => {
        const { admin, backupCodes, kind } = setupFinish(req.params.token, req.body?.code);
        res.cookie(ADMIN_COOKIE, createSession(admin.id, req.ip), sessionCookieOptions());
        svc.audit(admin, 'auth.setup', { targetType: 'admin', targetId: admin.id, targetLabel: admin.login, details: { kind } });
        return { backupCodes };
    }));

    // Ниже — только для авторизованных
    api.use(auth);

    // --- статистика ---
    api.get('/stats', adminOnly, wrap(() => svc.stats()));

    // --- пользователи ---
    const num = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);

    api.get('/users', wrap((req) => svc.listUsers({ q: req.query.q, filter: req.query.filter, page: num(req.query.page, 1) })));
    api.get('/users.csv', adminOnly, (req, res) => {
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"` });
        res.send(svc.usersCsv({ q: req.query.q, filter: req.query.filter }));
    });
    api.post('/users/grant', wrap((req) => svc.grantAccess(req.admin, req.body ?? {})));
    api.get('/users/:id', wrap(async (req) => ({
        ...(await svc.userDetails(req.params.id)),
        supportThreads: support.userThreads(Number(req.params.id)),
        telegram: userTelegram(Number(req.params.id)),
    })));
    api.post('/users/:id/extend', wrap((req) => svc.extendUser(req.admin, req.params.id, req.body ?? {})));
    api.post('/users/:id/disable', wrap((req) => svc.setEnabled(req.admin, req.params.id, false, req.body ?? {})));
    api.post('/users/:id/enable', wrap((req) => svc.setEnabled(req.admin, req.params.id, true, req.body ?? {})));
    api.post('/users/:id/reset-devices', wrap((req) => svc.resetDevices(req.admin, req.params.id, req.body ?? {})));
    api.post('/users/:id/revoke-link', wrap((req) => svc.revokeLink(req.admin, req.params.id, req.body ?? {})));
    api.post('/users/:id/resend-link', wrap((req) => svc.resendLink(req.admin, req.params.id, req.body ?? {})));
    api.post('/users/:id/reset-trial', wrap((req) => svc.resetTrial(req.admin, req.params.id, req.body ?? {})));
    api.post('/users/:id/delete-subscription', wrap((req) => svc.deleteSubscription(req.admin, req.params.id, req.body ?? {})));
    api.post('/users/:id/delete-account', wrap((req) => svc.deleteAccount(req.admin, req.params.id, req.body ?? {})));

    // --- платежи ---
    const orderFilters = (q) => ({ q: q.q, status: q.status, plan: q.plan, from: q.from, to: q.to });
    api.get('/orders', wrap((req) => svc.listOrders({ ...orderFilters(req.query), page: num(req.query.page, 1) })));
    api.get('/orders.csv', adminOnly, (req, res) => {
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"` });
        res.send(svc.ordersCsv(orderFilters(req.query)));
    });
    api.post('/orders/:id/sync', wrap((req) => svc.syncOrder(req.admin, req.params.id)));
    api.get('/orders/:id/refund', wrap((req) => svc.refundPreview(req.admin, req.params.id)));
    api.post('/orders/:id/refund', wrap((req) => svc.refundOrder(req.admin, req.params.id, req.body ?? {})));

    // --- обращения (обе роли) ---
    api.get('/support', wrap((req) => support.listThreads({ status: req.query.status, q: req.query.q, page: num(req.query.page, 1) })));
    api.get('/support/unread', wrap(() => ({ unread: support.unreadCount() })));
    api.post('/support/demo-inbound', wrap((req) => support.demoInbound(req.body ?? {})));
    // HTML письма — только внутри изолированного iframe: без скриптов, форм и внешних ресурсов
    api.get('/support/messages/:id/html', wrap((req, res) => {
        const html = support.messageHtml(req.params.id);
        res.set({
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox; frame-ancestors 'self'",
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'no-referrer',
        });
        res.send(html);
    }));
    api.get('/support/attachments/:id', wrap((req, res) => support.streamAttachment(req.params.id, res)));
    api.get('/support/:id', wrap((req) => support.threadDetails(req.params.id)));
    api.post('/support/:id/reply', wrap((req) => support.reply(req.admin, req.params.id, req.body ?? {})));
    api.post('/support/:id/status', wrap((req) => support.setStatus(req.admin, req.params.id, req.body ?? {})));

    // --- тарифы, приложения, настройки ---
    api.get('/plans', wrap(() => listPlans({ includeHidden: true })));
    api.put('/plans', adminOnly, wrap((req) => {
        const { before, after } = savePlans(req.body?.plans);
        svc.audit(req.admin, 'plans.update', { details: { before, after } });
        return after;
    }));
    api.get('/apps', adminOnly, wrap(() => getApps()));
    api.put('/apps', adminOnly, wrap((req) => {
        const { before, after } = saveApps(req.body?.apps);
        svc.audit(req.admin, 'apps.update', { details: { before, after } });
        return after;
    }));
    // telegramReady — бот запущен и группа поддержки указана (для подсказки у флажков оповещений и алертов)
    api.get('/settings', adminOnly, wrap(() => ({ ...getSettings(), telegramReady: Boolean(supportBotUsername()) })));
    api.put('/settings', adminOnly, wrap((req) => {
        const { before, after } = saveSettings(req.body ?? {});
        const changed = Object.fromEntries(
            Object.keys(after).filter((k) => before[k] !== after[k]).map((k) => [k, { before: before[k], after: after[k] }]),
        );
        if (Object.keys(changed).length) svc.audit(req.admin, 'settings.update', { details: changed });
        return after;
    }));

    // --- администраторы ---
    api.get('/admins', adminOnly, wrap(() =>
        db.prepare('SELECT id, login, role, disabled, created_at, last_login_at, totp_secret IS NOT NULL AS has2fa FROM admins ORDER BY id').all()
            .map((a) => ({ ...a, roleTitle: ROLES[a.role], disabled: Boolean(a.disabled), has2fa: Boolean(a.has2fa) })),
    ));
    api.post('/admins', adminOnly, wrap((req) => {
        const login = validateLogin(req.body?.login);
        const role = req.body?.role;
        if (!ROLES[role]) throw new svc.AdminActionError('Выберите роль');
        if (db.prepare('SELECT 1 FROM admins WHERE login = ?').get(login)) throw new svc.AdminActionError('Такой логин уже есть');
        const link = createSetupToken({ kind: 'invite', login, role, createdBy: req.admin.id });
        svc.audit(req.admin, 'admin.invite', { targetType: 'admin', targetLabel: login, details: { role } });
        return link;
    }));
    const loadAdmin = (id) => {
        const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(Number(id));
        if (!a) throw new svc.AdminActionError('Администратор не найден', 404);
        return a;
    };
    const notSelf = (req, a) => {
        if (a.id === req.admin.id) throw new svc.AdminActionError('Это действие нельзя применить к своей учётной записи');
    };
    const activeAdminsLeft = (exceptId) =>
        db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'admin' AND disabled = 0 AND id != ?").get(exceptId).n;

    api.post('/admins/:id/reset', adminOnly, wrap((req) => {
        const a = loadAdmin(req.params.id);
        const link = createSetupToken({ kind: 'reset', adminId: a.id, role: a.role, createdBy: req.admin.id });
        svc.audit(req.admin, 'admin.reset_access', { targetType: 'admin', targetId: a.id, targetLabel: a.login });
        return link;
    }));
    api.post('/admins/:id/role', adminOnly, wrap((req) => {
        const a = loadAdmin(req.params.id);
        notSelf(req, a);
        const role = req.body?.role;
        if (!ROLES[role]) throw new svc.AdminActionError('Неизвестная роль');
        db.prepare('UPDATE admins SET role = ? WHERE id = ?').run(role, a.id);
        svc.audit(req.admin, 'admin.role', { targetType: 'admin', targetId: a.id, targetLabel: a.login, details: { before: a.role, after: role } });
    }));
    api.post('/admins/:id/disable', adminOnly, wrap((req) => {
        const a = loadAdmin(req.params.id);
        notSelf(req, a);
        if (a.role === 'admin' && activeAdminsLeft(a.id) === 0) throw new svc.AdminActionError('Нельзя отключить последнего администратора');
        db.prepare('UPDATE admins SET disabled = 1 WHERE id = ?').run(a.id);
        destroyAdminSessions(a.id);
        svc.audit(req.admin, 'admin.disable', { targetType: 'admin', targetId: a.id, targetLabel: a.login });
    }));
    api.post('/admins/:id/enable', adminOnly, wrap((req) => {
        const a = loadAdmin(req.params.id);
        db.prepare('UPDATE admins SET disabled = 0 WHERE id = ?').run(a.id);
        svc.audit(req.admin, 'admin.enable', { targetType: 'admin', targetId: a.id, targetLabel: a.login });
    }));

    // --- журнал ---
    api.get('/audit', wrap((req) =>
        svc.listAudit({ admin: req.admin, adminLogin: req.query.admin, action: req.query.action, page: num(req.query.page, 1) }),
    ));
    api.get('/audit/actions', (_req, res) => res.json(svc.ACTION_TITLES));

    api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
    return router;
}
