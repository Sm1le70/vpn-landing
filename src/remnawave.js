// Клиент API панели Remnawave (контракт 3.3.x).
import { config } from './config.js';
import { reportResult } from './health.js';

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

// Кэш данных пользователя и его устройств — только для кабинета (getUserCached, getUserDevicesCached):
// кабинет запрашивает их при каждой загрузке, а выдача и продление всегда читают панель напрямую.
// Любой изменяющий запрос к пользователю сбрасывает его кэш — после оплаты или действия админа данные свежие.
const CACHE_MS = 30_000;
const cache = new Map();

function cached(key, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    // Кэшируем и сам запрос: одновременные загрузки кабинета (страница и QR-код) не дублируют его
    const value = load().catch((err) => {
        cache.delete(key);
        throw err;
    });
    cache.set(key, { at: Date.now(), value });
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
    return value;
}

function invalidate(id) {
    if (id == null) return;
    cache.delete(`user:${id}`);
    cache.delete(`devices:${id}`);
}

// ID пользователя изменяющего запроса: из пути (/api/users/5/...) или тела (PATCH { id }, devices { userId })
const mutatedUserId = (apiPath, body) => apiPath.match(/^\/api\/users\/(\d+)/)?.[1] ?? body?.id ?? body?.userId ?? null;

async function call(method, apiPath, body) {
    if (method === 'GET') return request(method, apiPath, body);
    // Сбрасываем до и после: чтение, начатое во время изменения, не оставит в кэше старые данные
    const id = mutatedUserId(apiPath, body);
    invalidate(id);
    try {
        return await request(method, apiPath, body);
    } finally {
        invalidate(id);
    }
}

async function request(method, apiPath, body) {
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

    let res;
    let text;
    try {
        res = await fetch(`${url}${apiPath}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });
        text = await res.text();
    } catch (err) {
        reportResult('remnawave', false, `${method} ${apiPath}: ${err.message}`);
        throw err;
    }
    reportResult('remnawave', res.status < 500, `${method} ${apiPath} → ${res.status}`);
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
    // Список пользователей панели постранично: { users, total }
    listUsers: (start, size) => call('GET', `/api/users?start=${start}&size=${size}`),
    deleteUser: (id) => call('DELETE', `/api/users/${id}`),
    disableUser: (id) => call('POST', `/api/users/${id}/actions/disable`),
    enableUser: (id) => call('POST', `/api/users/${id}/actions/enable`),
    // Перевыпуск ссылки подписки: старая ссылка перестаёт работать
    revokeSubscription: (id) => call('POST', `/api/users/${id}/actions/revoke`, {}),
    deleteAllDevices: (id) => call('POST', '/api/hwid/devices/delete-all', { userId: id }),
    deleteDevice: (id, hwid) => call('POST', '/api/hwid/devices/delete', { userId: id, hwid }),
    getUserDevices: (id) => call('GET', `/api/hwid/devices/${id}`),
    // Для кабинета: данные не старше CACHE_MS
    getUserCached: (id) => cached(`user:${id}`, () => call('GET', `/api/users/${id}`)),
    getUserDevicesCached: (id) => cached(`devices:${id}`, () => call('GET', `/api/hwid/devices/${id}`)),
};

// Для тестов
export const clearRemnawaveCache = () => cache.clear();
