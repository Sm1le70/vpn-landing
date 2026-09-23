// Клиент Telegram Bot API (прямые HTTP-запросы, без библиотек).
// Документация: https://core.telegram.org/bots/api
import crypto from 'node:crypto';
import { config } from './config.js';

export class TelegramError extends Error {
    constructor(message, code, retryAfter = null) {
        super(message);
        this.code = code;
        this.retryAfter = retryAfter;
    }
}

export const telegramEnabled = () => Boolean(config.telegram.botToken);

// Секрет вебхука (заголовок X-Telegram-Bot-Api-Secret-Token) выводится из APP_SECRET и токена бота:
// отдельная переменная не нужна, а при смене токена секрет меняется сам.
export const telegramWebhookSecret = () =>
    crypto.createHmac('sha256', config.appSecret).update(`telegram-webhook:${config.telegram.botToken}`).digest('hex');

export async function tg(method, params = {}) {
    if (!telegramEnabled()) throw new TelegramError('TELEGRAM_BOT_TOKEN не задан', 0);
    let res;
    try {
        res = await fetch(`${config.telegram.apiUrl}/bot${config.telegram.botToken}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (err) {
        throw new TelegramError(`Telegram ${method}: ${err.message}`, 0);
    }
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
        const code = data.error_code ?? res.status;
        throw new TelegramError(`Telegram ${method} → ${code}: ${data.description ?? 'нет ответа'}`, code, data.parameters?.retry_after ?? null);
    }
    return data.result;
}
