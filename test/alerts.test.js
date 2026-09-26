import './helpers/env.js';
import './helpers/telegram-on.js';
import { before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { failNext, fakes, resetFakes } from './helpers/fakes.js';
import { createOrder, createUser, getOrder } from './helpers/factories.js';
import { db } from '../src/db.js';
import { alert, alertTopicId, processAlerts } from '../src/alerts.js';
import { reportResult, resetHealth } from '../src/health.js';
import { saveSettings } from '../src/settings.js';
import { markOrderPaid, reconcileOrders } from '../src/subscriptions.js';
import { startTelegramSupport, supportBotUsername } from '../src/tgsupport.js';

const sent = () => fakes.telegram.calls.filter((c) => c.method === 'sendMessage' && c.params.message_thread_id === alertTopicId());
const rows = () => db.prepare('SELECT * FROM alerts ORDER BY id').all();
const sqlAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);

before(async () => {
    startTelegramSupport();
    for (let i = 0; i < 100 && !supportBotUsername(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(supportBotUsername(), 'бот запущен');
});

beforeEach(() => {
    resetFakes();
    resetHealth();
    db.exec('DELETE FROM alerts; DELETE FROM orders');
    saveSettings({ telegramAlerts: true });
});

describe('alert', () => {
    test('отправляется в тему «Алерты», тема создаётся один раз, текст экранирован', async () => {
        alert({ title: 'Проверка <b>', lines: ['строка & ещё'], link: 'http://localhost:3000/admin-test/#/users/1' });
        alert({ title: 'Второй' });
        await processAlerts();

        const topics = fakes.telegram.calls.filter((c) => c.method === 'createForumTopic');
        assert.equal(topics.length, 1);
        assert.equal(topics[0].params.name, 'Алерты');
        const msgs = sent();
        assert.equal(msgs.length, 2);
        assert.match(msgs[0].params.text, /Проверка &lt;b&gt;/);
        assert.match(msgs[0].params.text, /строка &amp; ещё/);
        // SITE_URL в тестах http — ссылка в тексте, а не кнопкой
        assert.match(msgs[0].params.text, /Открыть в админке/);
        assert.deepEqual(rows().map((r) => r.status), ['done', 'done']);
    });

    test('повтор с тем же ключом подавляется', async () => {
        assert.equal(alert({ key: 'k1', title: 'Раз' }), true);
        assert.equal(alert({ key: 'k1', title: 'Раз' }), false);
        assert.equal(alert({ key: 'k1', title: 'Раз', repeatAfterMs: 0 }), true, 'после окна — снова');
        await processAlerts();
        assert.equal(sent().length, 2);
    });

    test('выключены в настройках — только лог, в Telegram не уходят', async () => {
        saveSettings({ telegramAlerts: false });
        alert({ title: 'Тихо' });
        await processAlerts();
        assert.equal(rows()[0].status, 'skipped');
        assert.equal(sent().length, 0);
    });

    test('тему удалили — создаётся новая', async () => {
        alert({ title: 'Первый' });
        await processAlerts();
        const oldTopic = alertTopicId();
        fakes.telegram.deletedTopics.add(oldTopic);

        alert({ title: 'Второй' });
        await processAlerts();
        assert.notEqual(alertTopicId(), oldTopic);
        assert.equal(sent().length, 1, 'в новой теме');
        assert.equal(rows().at(-1).status, 'done');
    });

    test('Telegram недоступен — повтор позже', async () => {
        alert({ title: 'Не дошёл' });
        failNext('POST /bot', 'error', 502);
        failNext('POST /bot', 'error', 502);
        await processAlerts();
        const r = rows()[0];
        assert.equal(r.status, 'pending');
        assert.equal(r.attempts, 1);
        assert.ok(r.next_attempt_at > Date.now());
    });
});

describe('доступность сервисов', () => {
    const t0 = Date.now();
    const titles = () => rows().map((r) => r.text);

    test('короткий сбой (меньше минуты) — без алерта', () => {
        for (let i = 0; i < 10; i++) reportResult('remnawave', false, 'timeout', t0 + i * 1000);
        reportResult('remnawave', true, null, t0 + 20_000);
        assert.equal(rows().length, 0);
    });

    test('5 сбоев подряд дольше минуты — алерт; восстановление — второй алерт', () => {
        for (let i = 0; i < 4; i++) reportResult('platega', false, 'GET /transaction/x → 503', t0 + i * 20_000);
        assert.equal(rows().length, 0, '4 сбоя — ещё нет');
        reportResult('platega', false, 'GET /transaction/x → 503', t0 + 80_000);
        reportResult('platega', false, 'GET /transaction/x → 503', t0 + 100_000);
        assert.equal(rows().length, 1, 'алерт один раз');
        assert.match(titles()[0], /Platega не отвечает/);
        assert.match(titles()[0], /503/);

        reportResult('platega', true, null, t0 + 5 * 60_000);
        assert.equal(rows().length, 2);
        assert.match(titles()[1], /Platega: снова отвечает/);
        assert.match(titles()[1], /5 мин/);
    });

    test('ответ 4xx — сервис работает (сбой не засчитывается)', async () => {
        const user = createUser({ rw_user_id: 424_242 });
        const { fetchRemnaUser } = await import('../src/subscriptions.js');
        for (let i = 0; i < 6; i++) await fetchRemnaUser(user); // 404 в заглушке
        failNext('GET /api/users', 'error', 500);
        await fetchRemnaUser(user).catch(() => {});
        assert.equal(rows().length, 0);
    });
});

describe('алерты по заказам', () => {
    test('оплачен, но не выдан дольше 10 минут — алерт раз в сутки', async () => {
        const user = createUser();
        const order = createOrder(user.id, { status: 'paid', paid_at: sqlAgo(15) });
        failNext('POST /api/users', 'error', 500);
        await reconcileOrders();
        failNext('POST /api/users', 'error', 500);
        await reconcileOrders();

        assert.equal(getOrder(order.id).status, 'paid');
        const stuck = rows().filter((r) => r.dedup_key === `order-stuck:${order.id}`);
        assert.equal(stuck.length, 1);
        assert.match(stuck[0].text, new RegExp(`Пользователь #${user.id}`));
        assert.doesNotMatch(stuck[0].text, new RegExp(user.email), 'без email');
        assert.equal(stuck[0].link, `http://localhost:3000/admin-test/#/users/${user.id}`);
    });

    test('оплачен меньше 10 минут назад — без алерта', async () => {
        createOrder(createUser().id, { status: 'paid', paid_at: sqlAgo(2) });
        failNext('POST /api/users', 'error', 500);
        await reconcileOrders();
        assert.equal(rows().filter((r) => r.dedup_key?.startsWith('order-stuck')).length, 0);
    });

    test('оплата не принята проверкой — алерт', () => {
        const order = createOrder(createUser().id, { txId: 'tx-a', amount: 549 });
        markOrderPaid(order, { id: 'tx-a', paymentDetails: { amount: 199, currency: 'RUB' } });
        const r = rows().find((x) => x.dedup_key === `order-mismatch:${order.id}`);
        assert.ok(r);
        assert.match(r.text, /Оплата не принята/);
        assert.match(r.text, /меньше суммы заказа/);
    });
});
