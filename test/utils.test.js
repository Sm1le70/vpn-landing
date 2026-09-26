import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidEmail, normalizeEmail } from '../src/auth.js';
import { db } from '../src/db.js';
import { plural } from '../src/pages.js';
import { signWebhook, verifyWebhook } from '../src/resend.js';
import { extractMessageIds, normalizeSubject, parseAddress } from '../src/support.js';
import { excerpt } from '../src/tgnotify.js';
import { findForbidden } from '../src/wording.js';

test('база тестов — временная, не data/app.db', () => {
    assert.match(process.env.DATABASE_PATH, /vpn-landing-test-/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
});

test('normalizeEmail и isValidEmail', () => {
    assert.equal(normalizeEmail('  Ivan@Mail.RU '), 'ivan@mail.ru');
    assert.equal(normalizeEmail(undefined), '');
    assert.ok(isValidEmail('ivan@mail.ru'));
    assert.ok(!isValidEmail('ivan@mail'));
    assert.ok(!isValidEmail('ivan mail@mail.ru'));
    assert.ok(!isValidEmail(`${'a'.repeat(250)}@mail.ru`));
});

test('plural', () => {
    const words = ['день', 'дня', 'дней'];
    assert.equal(plural(1, words), 'день');
    assert.equal(plural(3, words), 'дня');
    assert.equal(plural(5, words), 'дней');
    assert.equal(plural(11, words), 'дней');
    assert.equal(plural(21, words), 'день');
    assert.equal(plural(112, words), 'дней');
});

test('findForbidden', () => {
    assert.equal(findForbidden('Защищённое подключение'), null);
    assert.equal(findForbidden('Доступ без ограничений'), 'без ограничений');
});

test('parseAddress, normalizeSubject, extractMessageIds', () => {
    assert.deepEqual(parseAddress('"Иван Петров" <Ivan@Mail.ru>'), { name: 'Иван Петров', email: 'ivan@mail.ru' });
    assert.deepEqual(parseAddress('ivan@mail.ru'), { name: null, email: 'ivan@mail.ru' });
    assert.equal(normalizeSubject('Re: Fwd: RE[2]: Вопрос  по   оплате'), 'вопрос по оплате');
    assert.deepEqual(extractMessageIds('<a@x>', '<b@x> <a@x>'), ['<a@x>', '<b@x>']);
});

test('excerpt обрезает цитату прошлой переписки', () => {
    assert.equal(excerpt('Не работает\n\n> старое письмо'), 'Не работает');
    assert.equal(excerpt('Вопрос\nOn Mon, 1 Jan 2026 Support wrote:\nцитата'), 'Вопрос');
});

test('подпись вебхука Resend: своя проходит, чужая нет', () => {
    const secret = `whsec_${Buffer.from('test-key').toString('base64')}`;
    const body = JSON.stringify({ type: 'email.received' });
    const headers = signWebhook(body, secret);
    assert.ok(verifyWebhook(Buffer.from(body), headers, secret));
    assert.ok(!verifyWebhook(Buffer.from(`${body} `), headers, secret));
    assert.ok(!verifyWebhook(Buffer.from(body), headers, `whsec_${Buffer.from('other').toString('base64')}`));
});

test('SEO: canonical и Open Graph на публичных страницах, noindex — в кабинете и 404; sitemap', async () => {
    const { renderPage, sitemapXml } = await import('../src/pages.js');
    const index = renderPage('index');
    assert.match(index, /<link rel="canonical" href="http:\/\/localhost:3000\/">/);
    assert.match(index, /<meta property="og:title" content="TestVPN — [^"]+">/);
    assert.match(index, /<meta property="og:description" content="[^"]+">/);
    assert.doesNotMatch(index, /noindex/);
    assert.match(renderPage('terms'), /<link rel="canonical" href="http:\/\/localhost:3000\/terms">/);
    for (const page of ['cabinet', '404']) {
        const html = renderPage(page);
        assert.match(html, /<meta name="robots" content="noindex">/);
        assert.doesNotMatch(html, /canonical|og:title/);
    }
    const xml = sitemapXml();
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset/);
    assert.equal((xml.match(/<loc>/g) ?? []).length, 4);
    assert.doesNotMatch(xml, /cabinet/);
});
