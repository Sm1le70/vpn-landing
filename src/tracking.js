// Собственная аналитика посещений — без сторонних сервисов и скриптов.
// Посетитель — случайный идентификатор в первопартийной cookie vid (30 дней с первого визита); IP не хранится.
// Первый источник визита (utm-метки, ?ref=, домен реферера) запоминается у посетителя
// и при первом входе в кабинет переносится новому клиенту (users.source и др.).
// Сырые события хранятся 90 дней; перед удалением они сворачиваются в итоги по дням (web_daily).
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, tx } from './db.js';
import { readCookie } from './auth.js';
import { every } from './jobs.js';
import { rateLimit } from './ratelimit.js';

export const VISITOR_COOKIE = 'vid';
const DAY_MS = 86_400_000;
const MSK_OFFSET_MS = 3 * 3_600_000;
const VISITOR_TTL_MS = 30 * DAY_MS;
export const RAW_RETENTION_DAYS = 90;

// Московская дата момента ms и начало московских суток
const mskDay = (ms) => new Date(ms + MSK_OFFSET_MS).toISOString().slice(0, 10);
const mskMidnight = (day) => Date.parse(`${day}T00:00:00+03:00`);
// Граница хранения сырых событий: всё раньше неё удалено (или будет удалено)
export const rawCutoff = (now = Date.now()) => mskMidnight(mskDay(now - RAW_RETENTION_DAYS * DAY_MS));

// ---------- Посетитель ----------

// Роботы, сервисы превью ссылок, мониторинг. Мессенджеры (Telegram, WhatsApp) открывают ссылки во встроенном
// браузере с обычным User-Agent, а их превью-боты попадают под «bot» или названия ниже.
const BOT_RE = /bot|crawl|spider|slurp|preview|scan|monitor|uptime|headless|lighthouse|pingdom|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|httpclient|externalhit|vkshare|whatsapp\//i;

export function isBot(req) {
    const ua = req.headers['user-agent'] ?? '';
    if (!ua || BOT_RE.test(ua)) return true;
    // Браузер всегда присылает Accept-Language, большинство роботов — нет
    if (!req.headers['accept-language']) return true;
    // Предзагрузка страницы браузером — ещё не визит
    const purpose = `${req.headers['sec-purpose'] ?? ''} ${req.headers.purpose ?? ''} ${req.headers['x-moz'] ?? ''}`;
    return /prefetch|prerender/i.test(purpose);
}

export function deviceOf(ua = '') {
    const device = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? 'tablet' : /Mobi|iPhone|iPod|Android/i.test(ua) ? 'mobile' : 'desktop';
    const os = /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
        : /Android/i.test(ua) ? 'Android'
        : /Windows/i.test(ua) ? 'Windows'
        : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
        : /Linux|CrOS/i.test(ua) ? 'Linux'
        : 'other';
    return { device, os };
}

// Значение метки: строчные буквы, цифры, «._-+», пробелы → «_»
const clean = (v, max = 64) => {
    const s = String(Array.isArray(v) ? v[0] : v ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9а-яё._\-+]/g, '')
        .slice(0, max);
    return s || null;
};

// Известные площадки — одним названием для всех их доменов (остальные — по домену)
const KNOWN_HOSTS = [
    [/(^|\.)(t\.me|telegram\.org|telegram\.me)$/, 'telegram'],
    [/(^|\.)(vk\.com|vk\.ru|vk\.me)$/, 'vk'],
    [/(^|\.)(yandex\.[a-z.]+|ya\.ru)$/, 'yandex'],
    [/(^|\.)google\.[a-z.]+$/, 'google'],
    [/(^|\.)dzen\.ru$/, 'dzen'],
    [/(^|\.)bing\.com$/, 'bing'],
    [/(^|\.)duckduckgo\.com$/, 'duckduckgo'],
];

// Источник визита: utm_source → ?ref= → площадка по домену реферера → 'direct'
export function sourceOf(query = {}, referer = '', ownHost = new URL(config.siteUrl).hostname) {
    let referrer = null;
    try {
        const host = new URL(referer).hostname.toLowerCase().replace(/^www\./, '');
        if (host && host !== ownHost.replace(/^www\./, '')) referrer = host.slice(0, 100);
    } catch {} // реферера нет или он некорректный
    const ref = clean(query.ref, 40);
    const result = {
        source: clean(query.utm_source),
        medium: clean(query.utm_medium),
        campaign: clean(query.utm_campaign),
        content: clean(query.utm_content),
        term: clean(query.utm_term),
        referrer,
    };
    if (!result.source && ref) {
        result.source = ref;
        result.medium ??= 'ref';
    }
    if (!result.source && referrer) result.source = KNOWN_HOSTS.find(([re]) => re.test(referrer))?.[1] ?? referrer;
    result.source ??= 'direct';
    return result;
}

const VID_RE = /^[A-Za-z0-9_-]{22}$/;
const cookieVid = (req) => {
    const v = readCookie(req, VISITOR_COOKIE);
    return v && VID_RE.test(v) ? v : null;
};
const visitorExists = (vid) => Boolean(db.prepare('SELECT 1 FROM visitors WHERE vid = ?').get(vid));
const logEvent = (vid, kind, name = null, userId = null, now = Date.now()) =>
    db.prepare('INSERT INTO web_events (vid, kind, name, user_id, created_at) VALUES (?, ?, ?, ?, ?)').run(vid, kind, name, userId, now);

// Аналитика никогда не ломает страницу или вход
const safe = (fn) => {
    try {
        fn();
    } catch (err) {
        console.error('[tracking]', err.message);
    }
};

// Просмотр страницы: при первом визите — новый посетитель и cookie на 30 дней (срок не продлевается)
export function trackPageView(req, res, pagePath) {
    if (req.method !== 'GET' || isBot(req)) return;
    safe(() => {
        const now = Date.now();
        let vid = cookieVid(req);
        const hadCookie = Boolean(vid);
        if (!vid || !visitorExists(vid)) {
            // С одного IP — не больше 300 новых посетителей в час: защита от накрутки
            // (за общим IP мобильного оператора бывают сотни настоящих посетителей)
            if (!rateLimit(`visitor:${req.ip}`, 300, 3_600_000, now)) return;
            vid ??= crypto.randomBytes(16).toString('base64url');
            const s = sourceOf(req.query, req.headers.referer);
            const { device, os } = deviceOf(req.headers['user-agent']);
            db.prepare(
                `INSERT OR IGNORE INTO visitors (vid, first_seen, source, medium, campaign, content, term, referrer, landing, device, os)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(vid, now, s.source, s.medium, s.campaign, s.content, s.term, s.referrer, pagePath, device, os);
            if (!hadCookie) res.cookie(VISITOR_COOKIE, vid, { httpOnly: true, secure: config.isHttps, sameSite: 'lax', maxAge: VISITOR_TTL_MS, path: '/' });
        }
        if (rateLimit(`view:${vid}`, 60, 60_000, now)) logEvent(vid, 'view', pagePath, null, now);
    });
}

// Клики из /assets/track.js: { e: 'click', n: '<data-track>' }
const EVENT_NAME_RE = /^[A-Za-z0-9_:.-]{1,40}$/;
export function trackBeacon(req) {
    if (isBot(req)) return;
    safe(() => {
        const vid = cookieVid(req);
        if (!vid || !rateLimit(`beacon:${vid}`, 60, 60_000)) return;
        let data;
        try {
            data = JSON.parse(String(req.body ?? ''));
        } catch {
            return;
        }
        const name = String(data?.n ?? '');
        if (data?.e !== 'click' || !EVENT_NAME_RE.test(name) || !visitorExists(vid)) return;
        logEvent(vid, 'click', name);
    });
}

// Шаги воронки в кабинете: 'code' — запрошен код входа, 'login' — вход (с id клиента)
export function trackStep(req, kind, userId = null) {
    safe(() => {
        const vid = cookieVid(req);
        if (vid && visitorExists(vid)) logEvent(vid, kind, null, userId);
    });
}

// Новый клиент: первый источник посетителя переносится в его аккаунт
export function attachVisitor(req, userId) {
    safe(() => {
        const vid = cookieVid(req);
        const v = vid && db.prepare('SELECT * FROM visitors WHERE vid = ?').get(vid);
        if (!v) return;
        db.prepare(
            `UPDATE users SET source = ?, utm_medium = ?, utm_campaign = ?, referrer = ?, landing = ?, first_visit_at = ?
             WHERE id = ? AND source IS NULL`,
        ).run(v.source, v.medium, v.campaign, v.referrer, v.landing, new Date(v.first_seen).toISOString().replace('T', ' ').slice(0, 19), userId);
    });
}

// ---------- Итоги ----------

// Ключ источника в итогах: «источник|кампания»
export const sourceKey = (source, campaign) => `${source ?? ''}|${campaign ?? ''}`;

// Показатели за [from, to) по сырым событиям: Map «metric|key» → n.
// Посетители (visitors) считаются без повторов за весь интервал.
function computeRaw(from, to) {
    const m = new Map();
    const put = (metric, key, n) => n && m.set(`${metric}|${key ?? ''}`, (m.get(`${metric}|${key ?? ''}`) ?? 0) + n);
    const ev = 'FROM web_events WHERE created_at >= ? AND created_at < ?';
    put('visitors', '', db.prepare(`SELECT COUNT(DISTINCT vid) AS n ${ev}`).get(from, to).n);
    for (const r of db.prepare(`SELECT name, COUNT(*) AS n ${ev} AND kind = 'view' GROUP BY name`).all(from, to)) put('views', r.name, r.n);
    for (const r of db.prepare(`SELECT name, COUNT(*) AS n, COUNT(DISTINCT vid) AS u ${ev} AND kind = 'click' GROUP BY name`).all(from, to)) {
        put('clicks', r.name, r.n);
        put('click_visitors', r.name, r.u);
    }
    for (const r of db.prepare(`SELECT kind, COUNT(DISTINCT vid) AS n ${ev} AND kind IN ('code', 'login') GROUP BY kind`).all(from, to)) put('step', r.kind, r.n);
    put('step', 'cabinet', db.prepare(`SELECT COUNT(DISTINCT vid) AS n ${ev} AND kind = 'view' AND name = '/cabinet'`).get(from, to).n);
    const vis = 'FROM visitors WHERE first_seen >= ? AND first_seen < ?';
    for (const r of db.prepare(`SELECT source, campaign, COUNT(*) AS n ${vis} GROUP BY source, campaign`).all(from, to)) put('new_visitors', sourceKey(r.source, r.campaign), r.n);
    for (const r of db.prepare(`SELECT device, COUNT(*) AS n ${vis} GROUP BY device`).all(from, to)) put('device', r.device, r.n);
    for (const r of db.prepare(`SELECT os, COUNT(*) AS n ${vis} GROUP BY os`).all(from, to)) put('os', r.os, r.n);
    return m;
}

// Сворачивает завершённые сутки, которых ещё нет в web_daily; затем удаляет сырые данные старше 90 дней.
// Посетители хранятся на 30 дней дольше событий: их cookie живёт 30 дней, события ссылаются на них.
export function rollupAndCleanup(now = Date.now()) {
    const oldest = db.prepare('SELECT MIN(created_at) AS t FROM web_events').get().t;
    const today = mskDay(now);
    const insert = db.prepare('INSERT OR REPLACE INTO web_daily (day, metric, key, n) VALUES (?, ?, ?, ?)');
    const done = db.prepare("SELECT 1 FROM web_daily WHERE day = ? AND metric = 'visitors' AND key = ''");
    if (oldest != null) {
        for (let day = mskDay(oldest); day < today; day = mskDay(mskMidnight(day) + DAY_MS + 3_600_000)) {
            if (done.get(day)) continue;
            const metrics = computeRaw(mskMidnight(day), mskMidnight(day) + DAY_MS);
            tx(() => {
                // Отметка «сутки свёрнуты» есть всегда, даже при нуле посетителей
                insert.run(day, 'visitors', '', metrics.get('visitors|') ?? 0);
                for (const [k, n] of metrics) {
                    const [metric, ...key] = k.split('|');
                    if (metric !== 'visitors') insert.run(day, metric, key.join('|'), n);
                }
            });
        }
    }
    const cutoff = rawCutoff(now);
    db.prepare('DELETE FROM web_events WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM visitors WHERE first_seen < ?').run(cutoff - VISITOR_TTL_MS);
}

// Показатели трафика за период [from, to).
// Если период целиком в пределах 90 дней — по сырым данным (точно, с воронкой посетителей);
// иначе — сумма итогов по дням (посетители без повторов не считаются, воронки нет).
export function trafficMetrics(from, to, now = Date.now()) {
    const end = Math.min(to, now);
    if (from >= rawCutoff(now)) return { exact: true, metrics: computeRaw(from, end), funnel: visitorFunnel(from, end) };
    const metrics = new Map();
    const stored = db.prepare('SELECT metric, key, n FROM web_daily WHERE day = ?');
    // Самый ранний день с данными: раньше него считать нечего
    const firstRaw = db.prepare('SELECT MIN(created_at) AS t FROM web_events').get().t;
    const firstDay = [db.prepare('SELECT MIN(day) AS d FROM web_daily').get().d, firstRaw == null ? null : mskDay(firstRaw)]
        .filter(Boolean)
        .sort()[0];
    for (let t = from; t < end; t += DAY_MS) {
        const day = mskDay(t + 3_600_000);
        if (!firstDay || day < firstDay) continue;
        let rows = stored.all(day);
        if (!rows.length) rows = [...computeRaw(mskMidnight(day), Math.min(mskMidnight(day) + DAY_MS, end))].map(([k, n]) => {
            const [metric, ...key] = k.split('|');
            return { metric, key: key.join('|'), n };
        });
        for (const r of rows) metrics.set(`${r.metric}|${r.key}`, (metrics.get(`${r.metric}|${r.key}`) ?? 0) + r.n);
    }
    return { exact: false, metrics, funnel: null };
}

// Воронка по посетителям, впервые пришедшим за период: открыли кабинет → запросили код → вошли → оплатили
function visitorFunnel(from, to) {
    const has = (cond) => `EXISTS (SELECT 1 FROM web_events e WHERE e.vid = v.vid AND ${cond})`;
    const r = db
        .prepare(
            `SELECT COUNT(*) AS visitors,
                COALESCE(SUM(${has("e.kind = 'view' AND e.name = '/cabinet'")}), 0) AS cabinet,
                COALESCE(SUM(${has("e.kind = 'code'")}), 0) AS code,
                COALESCE(SUM(${has("e.kind = 'login'")}), 0) AS login,
                COALESCE(SUM(EXISTS (
                    SELECT 1 FROM web_events e JOIN orders o ON o.user_id = e.user_id
                    WHERE e.vid = v.vid AND e.kind = 'login' AND o.status IN ('applied', 'paid')
                      AND o.paid_at >= strftime('%Y-%m-%d %H:%M:%S', v.first_seen / 1000, 'unixepoch')
                )), 0) AS paid
             FROM visitors v WHERE v.first_seen >= ? AND v.first_seen < ?`,
        )
        .get(from, to);
    return { ...r };
}

export function startTracking() {
    every('web-rollup', 60 * 60_000, () => rollupAndCleanup(), { firstDelayMs: 90_000 });
}
