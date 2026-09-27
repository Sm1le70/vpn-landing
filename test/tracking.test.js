import './helpers/env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrder, createUser, DAY_MS } from './helpers/factories.js';
import { db } from '../src/db.js';
import {
    attachVisitor, deviceOf, isBot, rollupAndCleanup, sourceOf, trackBeacon, trackPageView, trackStep, trafficMetrics,
} from '../src/tracking.js';
import { analytics } from '../src/admin/analytics.js';
import { cleanupRateLimits } from '../src/ratelimit.js';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let ipSeq = 0;
// Запрос браузера; cookie — значение vid, если посетитель уже был
function request({ vid = null, query = {}, referer, ua = CHROME, headers = {}, body, method = 'GET' } = {}) {
    return {
        method,
        ip: `10.0.0.${++ipSeq % 250}`,
        query,
        body,
        headers: {
            'user-agent': ua,
            'accept-language': 'ru-RU,ru;q=0.9',
            ...(vid ? { cookie: `vid=${vid}` } : {}),
            ...(referer ? { referer } : {}),
            ...headers,
        },
    };
}
function response() {
    const res = { cookies: {} };
    res.cookie = (name, value, options) => (res.cookies[name] = { value, options });
    return res;
}
// Новый посетитель: возвращает его vid
function visit(path = '/', opts = {}) {
    const res = response();
    trackPageView(request(opts), res, path);
    return res.cookies.vid?.value;
}
const events = (vid) => db.prepare('SELECT kind, name, user_id FROM web_events WHERE vid = ? ORDER BY id').all(vid);

beforeEach(() => {
    db.exec('DELETE FROM web_events; DELETE FROM visitors; DELETE FROM web_daily; DELETE FROM orders; DELETE FROM users');
    cleanupRateLimits(Date.now() + DAY_MS);
});

test('источник визита: utm → ?ref= → площадка по рефереру → прямой заход', () => {
    assert.deepEqual(sourceOf({ utm_source: 'TG Channel', utm_medium: 'post', utm_campaign: 'autumn' }, 'https://t.me/x', 'example.com'), {
        source: 'tg_channel', medium: 'post', campaign: 'autumn', content: null, term: null, referrer: 't.me',
    });
    assert.equal(sourceOf({ ref: 'ivan' }, '', 'example.com').source, 'ivan');
    assert.equal(sourceOf({ ref: 'ivan' }, '', 'example.com').medium, 'ref');
    assert.equal(sourceOf({}, 'https://www.google.ru/search?q=1', 'example.com').source, 'google');
    assert.equal(sourceOf({}, 'https://web.telegram.org/k/', 'example.com').source, 'telegram');
    assert.equal(sourceOf({}, 'https://blog.example.org/post', 'example.com').source, 'blog.example.org');
    // Переход внутри сайта и пустой реферер — прямой заход
    assert.equal(sourceOf({}, 'https://www.example.com/terms', 'example.com').source, 'direct');
    assert.equal(sourceOf({}, 'не адрес', 'example.com').source, 'direct');
    // Мусор в метке вычищается, массив из повторных параметров — первое значение
    assert.equal(sourceOf({ utm_source: ['<script>x', 'b'] }, '', 'example.com').source, 'scriptx');
});

test('устройство и система по User-Agent', () => {
    assert.deepEqual(deviceOf(IPHONE), { device: 'mobile', os: 'iOS' });
    assert.deepEqual(deviceOf(CHROME), { device: 'desktop', os: 'Windows' });
    assert.deepEqual(deviceOf('Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'), { device: 'tablet', os: 'Android' });
    assert.deepEqual(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36'), { device: 'mobile', os: 'Android' });
});

test('роботы, превью ссылок и предзагрузка не считаются', () => {
    assert.equal(isBot(request()), false);
    assert.equal(isBot(request({ ua: 'Mozilla/5.0 (compatible; YandexBot/3.0)' })), true);
    assert.equal(isBot(request({ ua: 'TelegramBot (like TwitterBot)' })), true);
    assert.equal(isBot(request({ ua: 'curl/8.0' })), true);
    assert.equal(isBot(request({ headers: { 'accept-language': '' } })), true);
    assert.equal(isBot(request({ headers: { 'sec-purpose': 'prefetch' } })), true);
    assert.equal(visit('/', { ua: 'Googlebot/2.1' }), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visitors').get().n, 0);
});

test('первый визит: cookie на 30 дней, источник и просмотр; повторный — без новой cookie, источник прежний', () => {
    const vid = visit('/', { query: { utm_source: 'tg', utm_campaign: 'sept' }, ua: IPHONE });
    assert.match(vid, /^[A-Za-z0-9_-]{22}$/);
    const v = db.prepare('SELECT * FROM visitors WHERE vid = ?').get(vid);
    assert.equal(v.source, 'tg');
    assert.equal(v.campaign, 'sept');
    assert.equal(v.landing, '/');
    assert.equal(v.device, 'mobile');

    const res = response();
    trackPageView(request({ vid, query: { utm_source: 'other' } }), res, '/cabinet');
    assert.deepEqual(res.cookies, {});
    assert.equal(db.prepare('SELECT source FROM visitors WHERE vid = ?').get(vid).source, 'tg');
    assert.deepEqual(events(vid).map((e) => e.name), ['/', '/cabinet']);
});

test('cookie с неизвестным id: посетитель заводится заново, cookie не перезаписывается', () => {
    const vid = 'A'.repeat(22);
    const res = response();
    trackPageView(request({ vid }), res, '/');
    assert.deepEqual(res.cookies, {});
    assert.ok(db.prepare('SELECT 1 FROM visitors WHERE vid = ?').get(vid));
    // Подделанное значение cookie не принимается
    assert.ok(visit('/', { vid: 'x" OR 1=1' }));
});

test('клики: только известному посетителю и с допустимым названием', () => {
    const vid = visit();
    const beacon = (body, v = vid) => trackBeacon(request({ vid: v, method: 'POST', body: JSON.stringify(body) }));
    beacon({ e: 'click', n: 'plan:m3' });
    beacon({ e: 'click', n: 'faq:refund' });
    beacon({ e: 'click', n: '<img src=x>' });
    beacon({ e: 'view', n: 'x' });
    beacon({ e: 'click', n: 'trial' }, 'B'.repeat(22));
    trackBeacon(request({ vid, method: 'POST', body: 'не json' }));
    assert.deepEqual(events(vid).filter((e) => e.kind === 'click').map((e) => e.name), ['plan:m3', 'faq:refund']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_events WHERE vid = ?').get('B'.repeat(22)).n, 0);
});

test('вход: шаги воронки и источник новому клиенту (существующий не перезаписывается)', () => {
    const vid = visit('/', { query: { ref: 'friend' }, referer: 'https://t.me/c' });
    trackStep(request({ vid }), 'code');
    const user = createUser();
    trackStep(request({ vid }), 'login', user.id);
    attachVisitor(request({ vid }), user.id);
    assert.deepEqual(events(vid).slice(1).map((e) => [e.kind, e.user_id]), [['code', null], ['login', user.id]]);
    const u = db.prepare('SELECT source, utm_medium, referrer, landing, first_visit_at FROM users WHERE id = ?').get(user.id);
    assert.equal(u.source, 'friend');
    assert.equal(u.utm_medium, 'ref');
    assert.equal(u.referrer, 't.me');
    assert.equal(u.landing, '/');
    assert.ok(u.first_visit_at);

    const other = visit('/', { query: { utm_source: 'ads' } });
    attachVisitor(request({ vid: other }), user.id);
    assert.equal(db.prepare('SELECT source FROM users WHERE id = ?').get(user.id).source, 'friend');
});

test('воронка посетителей: кабинет → код → вход → оплата', () => {
    const a = visit('/');
    const b = visit('/');
    visit('/');
    for (const vid of [a, b]) trackPageView(request({ vid }), response(), '/cabinet');
    trackStep(request({ vid: a }), 'code');
    trackStep(request({ vid: b }), 'code');
    const user = createUser();
    trackStep(request({ vid: a }), 'login', user.id);
    createOrder(user.id, { status: 'applied', paid_at: new Date(Date.now() + 1000).toISOString().replace('T', ' ').slice(0, 19) });

    const { exact, funnel, metrics } = trafficMetrics(Date.now() - DAY_MS, Date.now() + DAY_MS);
    assert.equal(exact, true);
    assert.deepEqual(funnel, { visitors: 3, cabinet: 2, code: 2, login: 1, paid: 1 });
    assert.equal(metrics.get('visitors|'), 3);
    assert.equal(metrics.get('views|/'), 3);
    assert.equal(metrics.get('views|/cabinet'), 2);
    assert.equal(metrics.get('step|cabinet'), 2);
});

test('итоги по дням: сырые данные старше 90 дней сворачиваются и удаляются', () => {
    const now = Date.now();
    const old = now - 100 * DAY_MS;
    const insVisitor = db.prepare("INSERT INTO visitors (vid, first_seen, source, device, os) VALUES (?, ?, ?, 'mobile', 'iOS')");
    const insEvent = db.prepare("INSERT INTO web_events (vid, kind, name, created_at) VALUES (?, ?, ?, ?)");
    insVisitor.run('v1', old, 'tg');
    insVisitor.run('v2', old + 1000, 'direct');
    insEvent.run('v1', 'view', '/', old);
    insEvent.run('v1', 'view', '/', old + 500);
    insEvent.run('v2', 'view', '/', old + 1000);
    insEvent.run('v1', 'click', 'trial', old + 2000);
    insEvent.run('v2', 'view', '/', now - DAY_MS); // свежее событие остаётся

    rollupAndCleanup(now);
    const day = new Date(old + 3 * 3_600_000).toISOString().slice(0, 10);
    const daily = Object.fromEntries(db.prepare('SELECT metric, key, n FROM web_daily WHERE day = ?').all(day).map((r) => [`${r.metric}|${r.key}`, r.n]));
    assert.equal(daily['visitors|'], 2);
    assert.equal(daily['views|/'], 3);
    assert.equal(daily['clicks|trial'], 1);
    assert.equal(daily['new_visitors|tg|'], 1);
    assert.equal(daily['device|mobile'], 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_events').get().n, 1);
    // Посетители хранятся на 30 дней дольше событий
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visitors').get().n, 2);

    // Повторный запуск не дублирует итоги
    rollupAndCleanup(now);
    assert.equal(db.prepare("SELECT n FROM web_daily WHERE day = ? AND metric = 'views' AND key = '/'").get(day).n, 3);

    // Период старше 90 дней — по итогам, без воронки
    const t = trafficMetrics(old - DAY_MS, now, now);
    assert.equal(t.exact, false);
    assert.equal(t.funnel, null);
    assert.equal(t.metrics.get('views|/'), 4);
});

test('аналитика: источники — посетители, клиенты, оплаты и выручка', () => {
    const tg = visit('/', { query: { utm_source: 'tg', utm_campaign: 'sept' } });
    visit('/', { query: { utm_source: 'tg', utm_campaign: 'sept' } });
    visit('/');
    const payer = createUser();
    attachVisitor(request({ vid: tg }), payer.id);
    createOrder(payer.id, { status: 'applied', amount: 549, paid_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
    createUser(); // без источника

    const a = analytics({});
    const byKey = Object.fromEntries(a.sources.map((s) => [`${s.source}|${s.campaign}`, s]));
    assert.deepEqual(byKey['tg|sept'], { source: 'tg', campaign: 'sept', visitors: 2, clients: 1, paid: 1, revenue: 549, conversion: 0.5 });
    assert.equal(byKey['direct|null'].visitors, 1);
    assert.equal(byKey['null|null'].clients, 1);
    assert.equal(a.current.traffic.visitors, 3);
    assert.equal(a.current.traffic.newVisitors, 3);
    assert.deepEqual(a.current.traffic.funnel, { visitors: 3, cabinet: 0, code: 0, login: 0, paid: 0 });
});
