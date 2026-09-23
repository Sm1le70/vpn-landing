// Демо: имитация входящего письма в поддержку (работает при запущенном npm run demo).
// npm run demo:mail -- --from client@example.com --subject "Вопрос" --text "Текст письма" [--reply-to "<message-id>"]
import { parseArgs } from 'node:util';

const { values } = parseArgs({
    options: {
        from: { type: 'string', default: 'client@example.com' },
        subject: { type: 'string', default: 'Вопрос по подписке' },
        text: { type: 'string', default: 'Здравствуйте! Не получается подключиться, подскажите, что делать?' },
        'reply-to': { type: 'string' },
    },
});

const mock = `http://localhost:${(Number(process.env.DEMO_PORT) || 3000) + 999}`;
try {
    const res = await fetch(`${mock}/demo/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: values.from, subject: values.subject, text: values.text, inReplyTo: values['reply-to'] }),
    });
    console.log(res.ok ? `Письмо от ${values.from} отправлено в демо — откройте раздел «Обращения»` : `Ошибка: ${res.status} ${await res.text()}`);
} catch {
    console.error(`Демо-сервер ${mock} не отвечает — сначала запустите npm run demo`);
    process.exit(1);
}
