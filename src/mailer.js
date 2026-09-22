// Отправка писем через Resend: https://resend.com/docs/api-reference/emails/send-email
import { config } from './config.js';
import { getSettings } from './settings.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function send({ to, subject, text, html }) {
    if (!config.mail.resendApiKey) {
        console.warn(`[mail] RESEND_API_KEY не задан, письмо не отправлено. To: ${to}; ${subject}\n${text}`);
        return;
    }
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.mail.resendApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: config.mail.from, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend → ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

const layout = (body) => `<!doctype html><html><body style="margin:0;background:#0b0f17;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#e6ebf5">
<div style="max-width:480px;margin:0 auto;background:#121826;border:1px solid #232c3f;border-radius:14px;padding:28px">
<div style="font-weight:700;font-size:18px;margin-bottom:20px">${esc(getSettings().brandName)}</div>
${body}
<p style="margin-top:28px;font-size:12px;color:#8a94a8">Поддержка: ${esc(getSettings().supportEmail)}</p>
</div></body></html>`;

export function sendLoginCode(to, code) {
    return send({
        to,
        subject: `Код входа: ${code}`,
        text: `Ваш код для входа в личный кабинет ${getSettings().brandName}: ${code}\nКод действует 10 минут. Если вы не запрашивали код, просто проигнорируйте письмо.`,
        html: layout(`<p style="margin:0 0 12px">Ваш код для входа в личный кабинет:</p>
<div style="font-size:32px;letter-spacing:6px;font-weight:700;margin:8px 0 16px">${esc(code)}</div>
<p style="margin:0;color:#8a94a8;font-size:14px">Код действует 10 минут. Если вы не запрашивали код, просто проигнорируйте письмо.</p>`),
    });
}

export function sendSubscriptionReady(to, { subscriptionUrl, expireAt, isTrial }) {
    const until = new Date(expireAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const title = isTrial ? 'Пробный период активирован' : 'Подписка активна';
    return send({
        to,
        subject: `${title} — ${getSettings().brandName}`,
        text: `${title} до ${until}\n\nСсылка на подписку (добавьте её в приложение):\n${subscriptionUrl}\n\nЛичный кабинет: ${config.siteUrl}/cabinet`,
        html: layout(`<p style="margin:0 0 8px;font-size:16px;font-weight:700">${title}</p>
<p style="margin:0 0 16px;color:#8a94a8">Действует до ${esc(until)}</p>
<p style="margin:0 0 8px">Ссылка на подписку — добавьте её в приложение:</p>
<div style="background:#0b0f17;border:1px solid #232c3f;border-radius:8px;padding:12px;word-break:break-all;font-family:monospace;font-size:13px">${esc(subscriptionUrl)}</div>
<p style="margin:20px 0 0"><a href="${esc(config.siteUrl)}/cabinet" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700">Открыть личный кабинет</a></p>`),
    });
}

// Уведомление о действии администратора (продление, отключение, новая ссылка и т.п.).
export function sendAccountNotice(to, { title, text, subscriptionUrl }) {
    const linkText = subscriptionUrl ? `\n\nСсылка на подписку:\n${subscriptionUrl}` : '';
    return send({
        to,
        subject: `${title} — ${getSettings().brandName}`,
        text: `${text}${linkText}\n\nЛичный кабинет: ${config.siteUrl}/cabinet`,
        html: layout(`<p style="margin:0 0 8px;font-size:16px;font-weight:700">${esc(title)}</p>
<p style="margin:0 0 16px;color:#c5cde0">${esc(text)}</p>
${subscriptionUrl ? `<p style="margin:0 0 8px">Ссылка на подписку:</p>
<div style="background:#0b0f17;border:1px solid #232c3f;border-radius:8px;padding:12px;word-break:break-all;font-family:monospace;font-size:13px">${esc(subscriptionUrl)}</div>` : ''}
<p style="margin:20px 0 0"><a href="${esc(config.siteUrl)}/cabinet" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700">Открыть личный кабинет</a></p>`),
    });
}
