// Серверный рендер страниц: views/*.html + общий layout. Плейсхолдеры: {{name}}.
// Всё, что видит банк при проверке (тарифы, контакты, документы), есть в HTML без JavaScript.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from './config.js';
import { getSettings, listPlans, onSettingsChange } from './settings.js';
import { onBotReady, supportBotUsername } from './tgsupport.js';

const VIEWS_DIR = path.join(ROOT_DIR, 'views');
const ASSETS_DIR = path.join(ROOT_DIR, 'public', 'assets');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rub = (n) => `${Number(n).toLocaleString('ru-RU')} ₽`;

export function plural(n, [one, few, many]) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

const DEVICE_WORDS = ['устройство', 'устройства', 'устройств'];

function devicesText(n) {
    if (!n) return 'Без ограничения числа устройств';
    return `До ${n} ${plural(n, DEVICE_WORDS)} одновременно`;
}

const daysText = (n) => `${n} ${plural(n, ['день', 'дня', 'дней'])}`;

// Подпись под ценой: цена в месяц — для тарифов от двух месяцев, иначе срок оплаты
function planSub(days, price) {
    if (days >= 60) return `${rub(Math.round(price / Math.round(days / 30)))} в месяц`;
    if (days >= 28 && days <= 31) return 'Оплата за 1 месяц';
    return `Оплата за ${daysText(days)}`;
}

function plansHtml(st) {
    return listPlans()
        .map((p) => {
            const perMonth = `<div class="plan-sub">${planSub(p.days, p.price)}</div>`;
            return `<article class="plan${p.badge ? ' plan--accent' : ''}">
    ${p.badge ? `<div class="plan-badge">${esc(p.badge)}</div>` : ''}
    <h3 class="plan-title">${esc(p.title)}</h3>
    <div class="plan-price">${rub(p.price)}</div>
    ${perMonth}
    <ul class="plan-list">
        <li>Доступ на ${daysText(p.days)}</li>
        <li>Безлимитный трафик</li>
        <li>${devicesText(st.paidDeviceLimit)}</li>
        <li>Разовая оплата, без автосписаний</li>
    </ul>
    <a class="btn ${p.badge ? 'btn--primary' : 'btn--ghost'} btn--block" href="/cabinet?plan=${encodeURIComponent(p.id)}">Оформить за ${rub(p.price)}</a>
</article>`;
        })
        .join('\n');
}

function vars() {
    const st = getSettings();
    const plans = listPlans();
    // Если бот поддержки запущен, ссылки Telegram ведут на него, иначе — на юзернейм из настроек
    const tg = supportBotUsername() || st.supportTelegram;
    return {
        brand: esc(st.brandName),
        year: String(new Date().getFullYear()),
        siteUrl: esc(config.siteUrl),
        supportEmail: esc(st.supportEmail),
        supportEmailLink: `<a href="mailto:${esc(st.supportEmail)}">${esc(st.supportEmail)}</a>`,
        supportTelegramLink: tg ? `<a href="https://t.me/${esc(tg)}" target="_blank" rel="noopener">@${esc(tg)}</a>` : '',
        supportTelegramItem: tg
            ? `<li><span>Telegram</span><a href="https://t.me/${esc(tg)}" target="_blank" rel="noopener">@${esc(tg)}</a></li>`
            : '',
        supportContactsText: tg
            ? `на <a href="mailto:${esc(st.supportEmail)}">${esc(st.supportEmail)}</a> или в Telegram <a href="https://t.me/${esc(tg)}" target="_blank" rel="noopener">@${esc(tg)}</a>`
            : `на <a href="mailto:${esc(st.supportEmail)}">${esc(st.supportEmail)}</a>`,
        docsDate: esc(st.docsDate),
        trialDaysText: daysText(st.trialDays),
        trialDevicesText: `${st.trialDeviceLimit} ${plural(st.trialDeviceLimit, DEVICE_WORDS)}`,
        devicesText: esc(devicesText(st.paidDeviceLimit)),
        paidDeviceLimit: String(st.paidDeviceLimit || 'неограниченное количество'),
        minPrice: rub(Math.min(...plans.map((p) => p.price))),
        plans: plansHtml(st),
        trialBlock: st.trialEnabled ? read('partials/trial.html') : '',
        verification: st.verificationPhrase ? `<p class="footer-verify">${esc(st.verificationPhrase)}</p>` : '',
    };
}

const read = (file) => fs.readFileSync(path.join(VIEWS_DIR, file), 'utf8');

function fill(template, values) {
    // Два прохода: подставленные блоки (например, trialBlock) тоже могут содержать плейсхолдеры.
    let out = template;
    for (let i = 0; i < 2; i++) out = out.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in values ? values[key] : m));
    return out;
}

// ?v=<хэш содержимого> у скриптов и стилей: после обновления браузер не берёт старую версию из кеша
const assetVersions = new Map();
function assetVersion(file) {
    if (!assetVersions.has(file)) {
        let v = '';
        try {
            v = crypto.createHash('sha256').update(fs.readFileSync(path.join(ASSETS_DIR, file))).digest('hex').slice(0, 10);
        } catch {} // файла нет — ссылка остаётся без версии
        if (process.env.NODE_ENV !== 'production') return v;
        assetVersions.set(file, v);
    }
    return assetVersions.get(file);
}
const versionAssets = (html) =>
    html.replace(/(["'])\/assets\/([\w.-]+\.(?:js|css))\1/g, (m, q, file) => {
        const v = assetVersion(file);
        return v ? `${q}/assets/${file}?v=${v}${q}` : m;
    });

const cache = new Map();
let cacheYear = new Date().getFullYear();
onSettingsChange(() => cache.clear());
onBotReady(() => cache.clear());

// Публичные страницы (для sitemap.xml, canonical и Open Graph). Кабинет и 404 не индексируются.
export const PUBLIC_PAGES = { index: '/', terms: '/terms', privacy: '/privacy', contacts: '/contacts' };

function seoTags(name, title, description) {
    const path = PUBLIC_PAGES[name];
    if (!path) return '    <meta name="robots" content="noindex">';
    const url = esc(`${config.siteUrl}${path === '/' ? '/' : path}`);
    return [
        `    <link rel="canonical" href="${url}">`,
        '    <meta property="og:type" content="website">',
        `    <meta property="og:site_name" content="${esc(getSettings().brandName)}">`,
        `    <meta property="og:title" content="${title}">`,
        `    <meta property="og:description" content="${description}">`,
        `    <meta property="og:url" content="${url}">`,
        '    <meta property="og:locale" content="ru_RU">',
    ].join('\n');
}

export function sitemapXml() {
    const urls = Object.values(PUBLIC_PAGES)
        .map((p) => `  <url><loc>${esc(`${config.siteUrl}${p}`)}</loc></url>`)
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function renderPage(name) {
    // В подвале выводится год — после Нового года страницы собираются заново
    const year = new Date().getFullYear();
    if (year !== cacheYear) {
        cache.clear();
        cacheYear = year;
    }
    if (cache.has(name)) return cache.get(name);
    const source = read(`${name}.html`);
    // Первая строка страницы: <!-- title: ... | description: ... -->
    const meta = source.match(/^<!--\s*title:\s*(.*?)\s*\|\s*description:\s*(.*?)\s*-->/);
    const body = meta ? source.slice(meta[0].length) : source;
    const values = vars();
    const title = meta ? fill(meta[1], values) : values.brand;
    const description = meta ? fill(meta[2], values) : '';
    const html = versionAssets(fill(read('layout.html'), {
        ...values,
        title,
        description,
        seo: seoTags(name, title, description),
        page: name,
        content: fill(body, values),
    }));
    if (process.env.NODE_ENV === 'production') cache.set(name, html);
    return html;
}
