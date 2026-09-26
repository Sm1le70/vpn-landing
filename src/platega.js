// Клиент API Platega: https://docs.platega.io/
import crypto from 'node:crypto';
import { config } from './config.js';
import { reportResult } from './health.js';

const { url, merchantId, secret } = config.platega;

async function call(method, apiPath, body) {
    if (!merchantId || !secret) throw new Error('Platega не настроена (PLATEGA_MERCHANT_ID / PLATEGA_SECRET)');
    let res;
    let text;
    try {
        res = await fetch(`${url}${apiPath}`, {
            method,
            headers: {
                'X-MerchantId': merchantId,
                'X-Secret': secret,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(20_000),
        });
        text = await res.text();
    } catch (err) {
        reportResult('platega', false, `${method} ${apiPath}: ${err.message}`);
        throw err;
    }
    reportResult('platega', res.status < 500, `${method} ${apiPath} → ${res.status}`);
    let data;
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { raw: text };
    }
    if (!res.ok) throw new Error(`Platega ${method} ${apiPath} → ${res.status}: ${text.slice(0, 300)}`);
    return data;
}

// expiresIn приходит как «ЧЧ:ММ:СС» (срок жизни платёжной ссылки); без него — null
function parseExpiresIn(value) {
    const m = /^(\d+):(\d{2}):(\d{2})$/.exec(String(value ?? ''));
    if (!m) return null;
    const ms = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
    return new Date(Date.now() + ms).toISOString();
}

// Платёжная ссылка без заданного метода: способ оплаты клиент выбирает на форме Platega.
export async function createPayment({ orderId, amount, description, userId, email }) {
    const data = await call('POST', '/v2/transaction/process', {
        paymentDetails: { amount, currency: 'RUB' },
        description,
        return: `${config.siteUrl}/cabinet?order=${orderId}`,
        failedUrl: `${config.siteUrl}/cabinet?order=${orderId}&failed=1`,
        payload: orderId,
        orderId,
        metadata: { userId: String(userId), userName: email },
    });
    const paymentUrl = data.url ?? data.redirect;
    if (!data.transactionId || !paymentUrl) throw new Error(`Platega: неожиданный ответ ${JSON.stringify(data)}`);
    return { transactionId: data.transactionId, paymentUrl, expiresAt: parseExpiresIn(data.expiresIn) };
}

export const getTransaction = (id) => call('GET', `/transaction/${encodeURIComponent(id)}`);

const safeEqual = (a, b) => {
    const ba = Buffer.from(String(a ?? ''));
    const bb = Buffer.from(String(b ?? ''));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// Platega присылает в callback те же X-MerchantId / X-Secret, что выданы магазину.
export const isAuthenticCallback = (headers) =>
    Boolean(merchantId && secret) &&
    safeEqual(headers['x-merchantid'], merchantId) &&
    safeEqual(headers['x-secret'], secret);

// ---------- Возвраты ----------

// Можно ли отменить транзакцию и сколько USDT спишется с баланса.
export const checkRefund = (id) => call('GET', `/transaction/${encodeURIComponent(id)}/cancel-supported`);

// Отмена транзакции с возвратом средств плательщику.
// accepted=false + manualControlRequired=true — возврат требует ручной обработки в Platega.
export const refundTransaction = (id) => call('POST', `/transaction/${encodeURIComponent(id)}/cancel`);
