// Демо-режим: сайт + заглушки Platega и Remnawave, без реальных ключей и оплаты.
// Запуск: npm run demo  →  http://localhost:3000
import http from 'node:http';
import crypto from 'node:crypto';

const APP_PORT = Number(process.env.DEMO_PORT) || 3000;
const MOCK_PORT = APP_PORT + 999;
const APP = `http://localhost:${APP_PORT}`;
const MOCK = `http://localhost:${MOCK_PORT}`;
const DEMO_WEBHOOK_SECRET = `whsec_${Buffer.from('demo-inbound-webhook-secret').toString('base64')}`;

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
    // Resend — заглушка: исходящие письма (и коды входа) выводятся в консоль,
    // входящие письма поддержки имитируются кнопкой в админке или npm run demo:mail
    RESEND_API_KEY: 'demo',
    RESEND_API_URL: MOCK,
    RESEND_INBOUND_WEBHOOK_SECRET: DEMO_WEBHOOK_SECRET,
    // Telegram — имитация Bot API: всё, что бот отправляет, выводится в консоль; сообщения клиента и сотрудников — npm run demo:tg
    TELEGRAM_BOT_TOKEN: '1:demo',
    TELEGRAM_SUPPORT_CHAT_ID: '-1001',
    TELEGRAM_API_URL: MOCK,
    ADMIN_PATH: '/admin-demo',
    DEMO_ADMIN_NO_2FA: 'true', // в демо вход в админку без 2FA: admin / admin и support / support
});

const transactions = new Map();
// Resend: отправленные и «полученные» письма
const sentEmails = new Map();
const receivedEmails = new Map();
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

function demoReceivedEmail({ from, subject, text, inReplyTo, extraHeaders }) {
    const raw = String(from || 'client@example.com').trim();
    const address = (raw.match(/<([^>]+)>/)?.[1] ?? raw).toLowerCase();
    const id = crypto.randomUUID();
    const messageId = `<${crypto.randomUUID()}@mail.example.com>`;
    const body = String(text || 'Здравствуйте! Не получается подключиться, подскажите, что делать?');
    const headers = { from: `Клиент <${address}>`, 'message-id': messageId, 'mime-version': '1.0' };
    if (inReplyTo) Object.assign(headers, { 'in-reply-to': inReplyTo, references: inReplyTo });
    Object.assign(headers, extraHeaders);
    const content = Buffer.from(`Демо-вложение к письму ${id}\n`);
    return {
        object: 'email',
        id,
        to: ['support@demo.local'],
        from: address,
        created_at: new Date().toISOString(),
        subject: String(subject || 'Вопрос по подписке'),
        // HTML со скриптом и внешней картинкой — чтобы проверить, что админка их не выполняет и не загружает
        html: `<p>${body.replace(/[<>&]/g, '').replace(/\n/g, '<br>')}</p><script>alert('xss')</script><img src="https://example.com/pixel.gif" alt="pixel">`,
        html_format: 'cid',
        text: body,
        headers,
        bcc: [],
        cc: [],
        reply_to: [],
        message_id: messageId,
        attachments: [{ id: crypto.randomUUID(), filename: 'demo.txt', content_type: 'text/plain', content_disposition: 'attachment', content_id: null, size: content.length, content }],
    };
}

async function sendInboundWebhook(email) {
    const { signWebhook } = await import('../src/resend.js');
    const payload = JSON.stringify({
        type: 'email.received',
        created_at: new Date().toISOString(),
        data: {
            email_id: email.id, created_at: email.created_at, from: email.from, to: email.to, cc: [], bcc: [],
            message_id: email.message_id, subject: email.subject,
            attachments: email.attachments.map(({ content, size, ...a }) => a),
        },
    });
    const res = await fetch(`${APP}/webhooks/resend-inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signWebhook(payload, DEMO_WEBHOOK_SECRET) },
        body: payload,
    });
    console.log(`[demo] входящее письмо от ${email.from} → вебхук: ${res.status}`);
}

// ---- Telegram: темы группы поддержки и сообщения (для copyMessage) ----
const TG_BOT = { id: 1, is_bot: true, first_name: 'Поддержка', username: 'demo_support_bot' };
const TG_GROUP = -1001;
const tgTopics = new Map();
const tgMessages = new Map();
let tgNextTopic = 2;
let tgNextMessage = 1;
let tgNextUpdate = 1;

const tgWhere = (chatId, threadId) => (String(chatId) === String(TG_GROUP) ? `тема #${threadId} «${tgTopics.get(threadId)?.name ?? '?'}»` : `клиенту ${chatId}`);
function tgStore(chatId, content) {
    const id = tgNextMessage++;
    tgMessages.set(`${chatId}:${id}`, content);
    return id;
}
const tgPreview = (c) => (c.text ?? (c.photo ? `[фото] ${c.caption ?? ''}` : '[сообщение]'));

function tgMethod(method, p) {
    switch (method) {
        case 'getMe': return TG_BOT;
        case 'setWebhook': return true;
        case 'getChat': return { id: TG_GROUP, type: 'supergroup', title: 'Поддержка (демо)', is_forum: true };
        case 'getChatMember': return { status: 'administrator', user: TG_BOT, can_manage_topics: true };
        case 'createForumTopic': {
            const id = tgNextTopic++;
            tgTopics.set(id, { name: p.name, closed: false });
            console.log(`[demo tg] создана тема #${id} «${p.name}»`);
            return { message_thread_id: id, name: p.name, icon_color: 7322096 };
        }
        case 'editForumTopic':
            if (tgTopics.has(p.message_thread_id)) tgTopics.get(p.message_thread_id).name = p.name;
            console.log(`[demo tg] тема #${p.message_thread_id} переименована: «${p.name}»`);
            return true;
        case 'reopenForumTopic':
        case 'closeForumTopic': {
            const topic = tgTopics.get(p.message_thread_id);
            if (!topic) throw Object.assign(new Error('Bad Request: message thread not found'), { code: 400 });
            const close = method === 'closeForumTopic';
            if (topic.closed === close) throw Object.assign(new Error('Bad Request: TOPIC_NOT_MODIFIED'), { code: 400 });
            topic.closed = close;
            console.log(`[demo tg] тема #${p.message_thread_id} ${close ? 'закрыта' : 'открыта заново'}`);
            return true;
        }
        case 'sendMessage': {
            if (p.message_thread_id && !tgTopics.has(p.message_thread_id)) throw Object.assign(new Error('Bad Request: message thread not found'), { code: 400 });
            console.log(`[demo tg] → ${tgWhere(p.chat_id, p.message_thread_id)}:\n${p.text}\n`);
            return { message_id: tgStore(p.chat_id, { text: p.text }), chat: { id: p.chat_id } };
        }
        case 'copyMessage': {
            const src = tgMessages.get(`${p.from_chat_id}:${p.message_id}`);
            if (!src) throw Object.assign(new Error('Bad Request: message to copy not found'), { code: 400 });
            if (p.message_thread_id) {
                const topic = tgTopics.get(p.message_thread_id);
                if (!topic) throw Object.assign(new Error('Bad Request: message thread not found'), { code: 400 });
                if (topic.closed) throw Object.assign(new Error('Bad Request: TOPIC_CLOSED'), { code: 400 });
            }
            const reply = p.reply_parameters ? ` (ответ на ${p.reply_parameters.message_id})` : '';
            const id = tgStore(p.chat_id, src);
            console.log(`[demo tg] → ${tgWhere(p.chat_id, p.message_thread_id)}${reply}, сообщение ${id}:\n${tgPreview(src)}\n`);
            return { message_id: id };
        }
        case 'setMessageReaction':
            console.log(`[demo tg] реакция ${p.reaction?.[0]?.emoji} на сообщение ${p.message_id} в группе`);
            return true;
        case 'leaveChat': return true;
        default: throw Object.assign(new Error(`demo: метод ${method} не поддерживается`), { code: 400 });
    }
}

// Имитация входящего сообщения: от клиента в личку бота или от сотрудника в тему
async function tgDemoIncoming(b) {
    const date = Math.floor(Date.now() / 1000);
    let message;
    if (b.type === 'close' || b.type === 'reopen') {
        const topic = tgTopics.get(Number(b.topic));
        if (topic) topic.closed = b.type === 'close';
        message = { message_id: tgNextMessage++, date, chat: { id: TG_GROUP, type: 'supergroup', is_forum: true }, from: { id: 500, is_bot: false, first_name: 'Сотрудник' },
            message_thread_id: Number(b.topic), is_topic_message: true, [b.type === 'close' ? 'forum_topic_closed' : 'forum_topic_reopened']: {} };
    } else if (b.type === 'staff') {
        const content = { text: String(b.text ?? '') };
        message = { message_id: tgStore(TG_GROUP, content), date, chat: { id: TG_GROUP, type: 'supergroup', is_forum: true }, from: { id: 500, is_bot: false, first_name: 'Сотрудник' },
            message_thread_id: Number(b.topic), is_topic_message: true, ...content };
        if (b.replyTo) message.reply_to_message = { message_id: Number(b.replyTo), date, chat: message.chat };
    } else {
        const from = { id: Number(b.user) || 111, is_bot: false, first_name: b.name || 'Иван', ...(b.username ? { username: b.username } : {}), language_code: 'ru' };
        const content = { text: String(b.text ?? '') };
        message = { message_id: tgStore(from.id, content), date, chat: { id: from.id, type: 'private', first_name: from.first_name }, from, ...content };
        if (b.replyTo) message.reply_to_message = { message_id: Number(b.replyTo), date, chat: message.chat };
    }
    const { telegramWebhookSecret } = await import('../src/telegram.js');
    const update = { update_id: tgNextUpdate++ + Math.floor(Date.now() / 1000) * 1000, message };
    const res = await fetch(`${APP}/webhooks/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': telegramWebhookSecret() },
        body: JSON.stringify(update),
    });
    console.log(`[demo tg] входящее сообщение ${message.message_id} → вебхук: ${res.status}`);
    return { messageId: message.message_id };
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

        // ---- Resend ----
        if (path === '/emails' && req.method === 'POST') {
            const id = crypto.randomUUID();
            sentEmails.set(id, { object: 'email', id, message_id: `<${crypto.randomUUID()}@demo.resend.local>`, ...body });
            const extra = body.headers ? `\nЗаголовки: ${JSON.stringify(body.headers)}` : '';
            console.log(`[demo mail] From: ${body.from}; To: ${body.to}; ${body.subject}${extra}\n${body.text}\n`);
            return json(res, 200, { id });
        }
        if ((m = path.match(/^\/emails\/receiving\/([\w-]+)\/attachments\/([\w-]+)$/))) {
            const att = receivedEmails.get(m[1])?.attachments.find((a) => a.id === m[2]);
            return att ? json(res, 200, { object: 'attachment', ...att, download_url: `${MOCK}/demo/files/${m[1]}/${m[2]}` }) : json(res, 404, {});
        }
        if ((m = path.match(/^\/emails\/receiving\/([\w-]+)$/))) {
            const email = receivedEmails.get(m[1]);
            return email ? json(res, 200, email) : json(res, 404, { message: 'not found' });
        }
        if ((m = path.match(/^\/emails\/([\w-]+)$/))) {
            const email = sentEmails.get(m[1]);
            return email ? json(res, 200, email) : json(res, 404, { message: 'not found' });
        }
        if ((m = path.match(/^\/demo\/files\/([\w-]+)\/([\w-]+)$/))) {
            const att = receivedEmails.get(m[1])?.attachments.find((a) => a.id === m[2]);
            if (!att) return json(res, 404, {});
            res.writeHead(200, { 'Content-Type': att.content_type });
            return res.end(att.content);
        }
        // Имитация входящего письма: письмо «принимается» и приложению уходит подписанный вебхук
        if (path === '/demo/inbound' && req.method === 'POST') {
            const email = demoReceivedEmail(body);
            receivedEmails.set(email.id, email);
            await sendInboundWebhook(email);
            return json(res, 200, { id: email.id });
        }

        // ---- Telegram ----
        if ((m = path.match(/^\/bot[^/]+\/(\w+)$/))) {
            try {
                return json(res, 200, { ok: true, result: tgMethod(m[1], body) });
            } catch (err) {
                return json(res, err.code ?? 400, { ok: false, error_code: err.code ?? 400, description: err.message });
            }
        }
        if (path === '/demo/tg' && req.method === 'POST') return json(res, 200, await tgDemoIncoming(body));

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
        if ((m = path.match(/^\/api\/users\/(\d+)$/)) && req.method === 'DELETE') {
            users.delete(Number(m[1]));
            devices.delete(Number(m[1]));
            return json(res, 200, { response: { isDeleted: true } });
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
    // Темы заглушки хранятся в памяти, а привязка клиентов к темам — в базе демо:
    // после перезапуска нумеруем новые темы дальше, чтобы номера не совпали со старыми
    const { db } = await import('../src/db.js');
    tgNextTopic = Math.max(tgNextTopic, (db.prepare('SELECT MAX(topic_id) AS n FROM tg_clients').get().n ?? 0) + 1);
    console.log(`
==============================================================
  ДЕМО-РЕЖИМ: платежи и панель — заглушки, деньги не списываются
  Откройте: ${APP}
  Код входа в кабинет появится здесь, в консоли ("Код входа: ...")
  Админка:  ${APP}/admin-demo/  (admin / admin, support / support)
  Письмо в поддержку: кнопка в разделе «Обращения» или npm run demo:mail
  Telegram: npm run demo:tg -- --text "Вопрос" (ответы бота — здесь, в консоли)
  База демо: data/demo.db (удалите файл, чтобы начать заново)
==============================================================
`);
});
