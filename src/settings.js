// Настройки, тарифы и приложения, изменяемые из админки.
// Значения по умолчанию берутся из .env и config/*.json; сохранённые в админке значения имеют приоритет.
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from './config.js';
import { db, tx } from './db.js';
import { findForbidden } from './wording.js';

export class ValidationError extends Error {}

const listeners = new Set();
export const onSettingsChange = (fn) => listeners.add(fn);
const emitChange = () => listeners.forEach((fn) => fn());

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config', file), 'utf8'));

function checkWording(label, value) {
    const hit = findForbidden(value);
    if (hit) throw new ValidationError(`${label}: формулировка «${hit}» недопустима для проверки банком`);
}

// ---------- Настройки сервиса ----------

const FIELDS = {
    brandName: { type: 'string', label: 'Название сервиса', max: 40, required: true },
    supportEmail: { type: 'email', label: 'Email поддержки', required: true },
    supportTelegram: { type: 'string', label: 'Telegram поддержки', max: 32, pattern: /^[A-Za-z0-9_]*$/ },
    docsDate: { type: 'string', label: 'Дата редакции документов', max: 20, required: true },
    verificationPhrase: { type: 'string', label: 'Кодовое слово', max: 60 },
    paidDeviceLimit: { type: 'int', label: 'Лимит устройств (платная подписка)', min: 0, max: 50 },
    trialEnabled: { type: 'bool', label: 'Пробный период включён' },
    trialDays: { type: 'int', label: 'Дней пробного периода', min: 1, max: 30 },
    trialDeviceLimit: { type: 'int', label: 'Устройств на пробном периоде', min: 1, max: 10 },
    telegramEmailNotify: { type: 'bool', label: 'Оповещения об обращениях в Telegram' },
    telegramAlerts: { type: 'bool', label: 'Служебные алерты в Telegram' },
};

const defaults = () => ({
    brandName: config.brandName,
    supportEmail: config.supportEmail,
    supportTelegram: config.supportTelegram,
    docsDate: config.docsDate,
    verificationPhrase: config.verificationPhrase,
    paidDeviceLimit: config.paidDeviceLimit,
    trialEnabled: config.trial.enabled,
    trialDays: config.trial.days,
    trialDeviceLimit: config.trial.deviceLimit,
    telegramEmailNotify: true,
    telegramAlerts: true,
});

let settingsCache = null;

export function getSettings() {
    if (!settingsCache) {
        const values = defaults();
        for (const row of db.prepare('SELECT key, value FROM settings').all()) {
            if (row.key in FIELDS) values[row.key] = JSON.parse(row.value);
        }
        settingsCache = values;
    }
    return settingsCache;
}

export function saveSettings(patch) {
    const clean = {};
    for (const [key, raw] of Object.entries(patch ?? {})) {
        const f = FIELDS[key];
        if (!f) continue;
        let v = raw;
        if (f.type === 'string' || f.type === 'email') {
            v = String(v ?? '').trim();
            if (key === 'supportTelegram') v = v.replace(/^@/, '');
            if (f.required && !v) throw new ValidationError(`${f.label}: обязательное поле`);
            if (f.max && v.length > f.max) throw new ValidationError(`${f.label}: не длиннее ${f.max} символов`);
            if (f.pattern && !f.pattern.test(v)) throw new ValidationError(`${f.label}: недопустимые символы`);
            if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw new ValidationError(`${f.label}: некорректный email`);
            checkWording(f.label, v);
        } else if (f.type === 'int') {
            v = Number(v);
            if (!Number.isInteger(v) || v < f.min || v > f.max) throw new ValidationError(`${f.label}: целое число от ${f.min} до ${f.max}`);
        } else if (f.type === 'bool') {
            v = v === true || v === 'true';
        }
        clean[key] = v;
    }
    const before = { ...getSettings() };
    tx(() => {
        const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        for (const [k, v] of Object.entries(clean)) stmt.run(k, JSON.stringify(v));
    });
    settingsCache = null;
    emitChange();
    return { before, after: getSettings() };
}

// ---------- Тарифы ----------

if (db.prepare('SELECT COUNT(*) AS n FROM plans').get().n === 0) {
    const seed = readJson('plans.json');
    const stmt = db.prepare('INSERT INTO plans (id, title, days, price, badge, sort, hidden) VALUES (?, ?, ?, ?, ?, ?, 0)');
    seed.forEach((p, i) => stmt.run(p.id, p.title, p.days, p.price, p.badge ?? null, i));
}

const mapPlan = (r) => ({ id: r.id, title: r.title, days: r.days, price: r.price, badge: r.badge || undefined, hidden: Boolean(r.hidden) });

export function listPlans({ includeHidden = false } = {}) {
    const rows = db.prepare(`SELECT * FROM plans ${includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY sort, days`).all();
    return rows.map(mapPlan);
}

export function getPlan(id, { includeHidden = false } = {}) {
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(String(id ?? ''));
    if (!row || (row.hidden && !includeHidden)) return undefined;
    return mapPlan(row);
}

export function savePlans(list) {
    if (!Array.isArray(list) || list.length === 0) throw new ValidationError('Нужен хотя бы один тариф');
    const ids = new Set();
    const clean = list.map((p, i) => {
        const id = String(p.id ?? '').trim();
        const title = String(p.title ?? '').trim();
        const badge = String(p.badge ?? '').trim();
        const days = Number(p.days);
        const price = Number(p.price);
        if (!/^[a-z0-9_-]{1,20}$/i.test(id)) throw new ValidationError(`Тариф ${i + 1}: ID — латиница, цифры, _ и -, до 20 символов`);
        if (ids.has(id)) throw new ValidationError(`Тариф ${id}: ID повторяется`);
        ids.add(id);
        if (!title || title.length > 40) throw new ValidationError(`Тариф ${id}: название от 1 до 40 символов`);
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new ValidationError(`Тариф ${id}: срок — целое число дней от 1 до 3650`);
        if (!(price >= 1) || price > 1_000_000) throw new ValidationError(`Тариф ${id}: цена от 1 ₽`);
        if (badge.length > 24) throw new ValidationError(`Тариф ${id}: метка до 24 символов`);
        checkWording(`Тариф ${id}`, `${title} ${badge}`);
        return { id, title, days, price: Math.round(price * 100) / 100, badge: badge || null, sort: i, hidden: p.hidden ? 1 : 0 };
    });
    if (!clean.some((p) => !p.hidden)) throw new ValidationError('Хотя бы один тариф должен быть видимым');

    const before = listPlans({ includeHidden: true });
    tx(() => {
        db.exec('DELETE FROM plans');
        const stmt = db.prepare('INSERT INTO plans (id, title, days, price, badge, sort, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const p of clean) stmt.run(p.id, p.title, p.days, p.price, p.badge, p.sort, p.hidden);
    });
    emitChange();
    return { before, after: listPlans({ includeHidden: true }) };
}

// ---------- Приложения ----------

let appsCache = null;

export function getApps() {
    if (!appsCache) {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'apps'").get();
        appsCache = row ? JSON.parse(row.value) : readJson('apps.json');
    }
    return appsCache;
}

export function saveApps(groups) {
    if (!Array.isArray(groups)) throw new ValidationError('Некорректный формат');
    const clean = groups.map((g, gi) => {
        const platform = String(g.platform ?? '').trim().toLowerCase();
        const title = String(g.title ?? '').trim();
        if (!/^[a-z0-9_-]{1,20}$/.test(platform)) throw new ValidationError(`Платформа ${gi + 1}: код — латиница и цифры`);
        if (!title) throw new ValidationError(`Платформа ${platform}: нужно название`);
        const apps = (g.apps ?? []).map((a) => {
            const name = String(a.name ?? '').trim();
            if (!name) throw new ValidationError(`Платформа ${title}: у приложения нет названия`);
            const links = (a.links ?? []).map((l) => {
                const label = String(l.label ?? '').trim();
                const url = String(l.url ?? '').trim();
                if (!label) throw new ValidationError(`${name}: у ссылки нет подписи`);
                if (!/^https:\/\/\S+$/.test(url)) throw new ValidationError(`${name}: ссылка должна начинаться с https://`);
                return { label, url };
            });
            if (!links.length) throw new ValidationError(`${name}: нужна хотя бы одна ссылка`);
            checkWording(name, `${name} ${links.map((l) => l.label).join(' ')}`);
            return { name, links };
        });
        checkWording(title, title);
        return { platform, title, apps };
    });
    const before = getApps();
    db.prepare("INSERT INTO settings (key, value) VALUES ('apps', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(clean));
    appsCache = null;
    emitChange();
    return { before, after: getApps() };
}
