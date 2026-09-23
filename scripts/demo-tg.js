// Демо: имитация сообщений боту поддержки в Telegram (работает при запущенном npm run demo).
// От клиента:      npm run demo:tg -- --text "Не подключается" [--user 111 --name Иван --username ivan] [--reply-to <id>]
// Привязка:        npm run demo:tg -- --start <токен из ссылки t.me/...?start=...>
// От сотрудника:   npm run demo:tg -- --topic 2 --text "Ответ клиенту" [--reply-to <id>]
// Закрыть тему:    npm run demo:tg -- --close 2     (открыть: --reopen 2)
import { parseArgs } from 'node:util';

const { values: v } = parseArgs({
    options: {
        text: { type: 'string', default: 'Здравствуйте! Не получается подключиться, подскажите, что делать?' },
        user: { type: 'string', default: '111' },
        name: { type: 'string', default: 'Иван' },
        username: { type: 'string', default: 'ivan_demo' },
        start: { type: 'string' },
        topic: { type: 'string' },
        close: { type: 'string' },
        reopen: { type: 'string' },
        'reply-to': { type: 'string' },
    },
});

let body;
if (v.close || v.reopen) body = { type: v.close ? 'close' : 'reopen', topic: v.close ?? v.reopen };
else if (v.topic) body = { type: 'staff', topic: v.topic, text: v.text, replyTo: v['reply-to'] };
else body = { type: 'client', user: v.user, name: v.name, username: v.username, text: v.start ? `/start ${v.start}` : v.text, replyTo: v['reply-to'] };

const mock = `http://localhost:${(Number(process.env.DEMO_PORT) || 3000) + 999}`;
try {
    const res = await fetch(`${mock}/demo/tg`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    console.log(res.ok ? `Отправлено (сообщение ${data.messageId}) — ответ бота смотрите в консоли npm run demo` : `Ошибка: ${res.status}`);
} catch {
    console.error(`Демо-сервер ${mock} не отвечает — сначала запустите npm run demo`);
    process.exit(1);
}
