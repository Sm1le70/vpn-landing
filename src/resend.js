// Клиент API Resend (прямые HTTP-запросы, без SDK) и проверка подписи вебхуков.
// Документация: https://resend.com/docs/api-reference
import crypto from 'node:crypto';
import { config } from './config.js';

export class ResendError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

export const resendEnabled = () => Boolean(config.mail.resendApiKey);

async function request(method, path, body) {
    if (!resendEnabled()) throw new ResendError('RESEND_API_KEY не задан', 0);
    const res = await fetch(`${config.mail.resendApiUrl}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${config.mail.resendApiKey}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    if (!res.ok) throw new ResendError(`Resend ${method} ${path.split('?')[0]} → ${res.status}: ${raw.slice(0, 300)}`, res.status);
    return raw ? JSON.parse(raw) : {};
}

export const resend = {
    // https://resend.com/docs/api-reference/emails/send-email
    sendEmail: (payload) => request('POST', '/emails', payload),
    // https://resend.com/docs/api-reference/emails/retrieve-email — нужен ради message_id отправленного письма
    getSentEmail: (id) => request('GET', `/emails/${encodeURIComponent(id)}`),
    // https://resend.com/docs/api-reference/emails/retrieve-received-email
    // html_format=cid: картинки в HTML не встраиваются как data URI, тело не раздувается
    getReceivedEmail: (id) => request('GET', `/emails/receiving/${encodeURIComponent(id)}?html_format=cid`),
    // https://resend.com/docs/api-reference/emails/retrieve-received-email-attachment
    // download_url действует 1 час, поэтому запрашиваем его при каждом скачивании
    getReceivedAttachment: (emailId, attachmentId) =>
        request('GET', `/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`),
};

// Проверка подписи вебхука (Resend подписывает через Svix):
// HMAC-SHA256 от "svix-id.svix-timestamp.тело", ключ — base64 из секрета после "whsec_".
// https://docs.svix.com/receiving/verifying-payloads/how-manual
const TOLERANCE_SEC = 5 * 60;

export function verifyWebhook(rawBody, headers, secret) {
    const id = String(headers['svix-id'] ?? '');
    const timestamp = String(headers['svix-timestamp'] ?? '');
    const signatures = String(headers['svix-signature'] ?? '');
    if (!secret || !id || !/^\d+$/.test(timestamp) || !signatures) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SEC) return false;

    const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
    const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest();
    return signatures.split(' ').some((part) => {
        const [version, sig] = part.split(',');
        if (version !== 'v1' || !sig) return false;
        const actual = Buffer.from(sig, 'base64');
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    });
}

// Для демо: подпись в том же формате.
export function signWebhook(rawBody, secret, id = `msg_${crypto.randomBytes(12).toString('hex')}`) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
    const sig = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
    return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${sig}` };
}
