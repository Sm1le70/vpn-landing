// Клиент API панели Remnawave (контракт 3.3.x).
import { config } from './config.js';

const { url, token, cookie } = config.remnawave;

export class RemnawaveError extends Error {
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}

// Вызывается для каждого ответа с данными пользователя — чтобы держать кэш срока/статуса в нашей БД.
let userResponseHook = null;
export const onUserResponse = (fn) => (userResponseHook = fn);

async function call(method, apiPath, body) {
    if (!url || !token) throw new RemnawaveError('Remnawave не настроен (REMNAWAVE_URL / REMNAWAVE_TOKEN)', 0);

    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        // Панель отвечает только на HTTPS-запросы; при обращении напрямую по внутренней сети
        // эти заголовки обозначают запрос как пришедший через reverse-proxy.
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-For': '127.0.0.1',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;

    const res = await fetch(`${url}${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { raw: text };
    }
    if (!res.ok) {
        throw new RemnawaveError(`Remnawave ${method} ${apiPath} → ${res.status}: ${data?.message ?? text.slice(0, 200)}`, res.status, data);
    }
    const response = data.response;
    if (userResponseHook && response && typeof response.id === 'number' && response.expireAt && response.status) {
        try {
            userResponseHook(response);
        } catch (err) {
            console.error('[remnawave] cache hook:', err.message);
        }
    }
    return response;
}

export const remnawave = {
    createUser: (body) => call('POST', '/api/users', body),
    updateUser: (body) => call('PATCH', '/api/users', body),
    getUser: (id) => call('GET', `/api/users/${id}`),
    disableUser: (id) => call('POST', `/api/users/${id}/actions/disable`),
    enableUser: (id) => call('POST', `/api/users/${id}/actions/enable`),
    // Перевыпуск ссылки подписки: старая ссылка перестаёт работать
    revokeSubscription: (id) => call('POST', `/api/users/${id}/actions/revoke`, {}),
    deleteAllDevices: (id) => call('POST', '/api/hwid/devices/delete-all', { userId: id }),
    getUserDevices: (id) => call('GET', `/api/hwid/devices/${id}`),
};
