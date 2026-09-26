// Управляемые заглушки внешних API: подменяют глобальный fetch, сеть в тестах не используется.
// Адреса сервисов задаются в env.js; запрос на любой другой адрес — ошибка.
import crypto from 'node:crypto';

export const HOSTS = {
    remnawave: 'http://remnawave.test',
    platega: 'http://platega.test',
    resend: 'http://resend.test',
    telegram: 'http://telegram.test',
};

// Сбой следующего запроса, подходящего под match ("PATCH /api/users"):
//   mode 'error'         — сервис отвечает status (по умолчанию 500), изменение не применяется
//   mode 'lost-response' — сервис применил изменение, но ответ не дошёл (таймаут)
const failures = [];
export const failNext = (match, mode = 'error', status = 500) => failures.push({ match, mode, status });

export const fakes = {
    remnawave: { users: new Map(), devices: new Map(), nextId: 1, requests: [] },
    platega: { transactions: new Map(), refund: { supported: true, accepted: true, manualControlRequired: false }, requests: [] },
    resend: { sent: [] },
    telegram: { calls: [] },
};

export function resetFakes() {
    failures.length = 0;
    Object.assign(fakes.remnawave, { users: new Map(), devices: new Map(), nextId: 1, requests: [] });
    Object.assign(fakes.platega, {
        transactions: new Map(),
        refund: { supported: true, accepted: true, manualControlRequired: false },
        requests: [],
    });
    fakes.resend.sent = [];
    fakes.telegram.calls = [];
}

// Пользователь в панели (как после createUser); возвращает объект пользователя
export function addRemnaUser(fields = {}) {
    const id = fakes.remnawave.nextId++;
    const user = {
        id,
        username: `user${id}`,
        status: 'ACTIVE',
        expireAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        hwidDeviceLimit: 3,
        subscriptionUrl: `https://sub.test/${id}`,
        ...fields,
    };
    fakes.remnawave.users.set(id, user);
    return user;
}

// Транзакция Platega; возвращает её id
export function addTransaction({ status = 'PENDING', amount = 199, currency = 'RUB', payload = null } = {}) {
    const id = crypto.randomUUID();
    fakes.platega.transactions.set(id, { id, status, paymentDetails: { amount, currency }, payload });
    return id;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function remnawave(method, path, body) {
    const rw = fakes.remnawave;
    rw.requests.push({ method, path, body });
    let m;
    if (method === 'POST' && path === '/api/users') {
        const user = addRemnaUser({ status: 'ACTIVE', ...body, subscriptionUrl: `https://sub.test/${rw.nextId}` });
        return () => json({ response: user }, 201);
    }
    if (method === 'PATCH' && path === '/api/users') {
        const user = rw.users.get(body.id);
        if (!user) return () => json({ message: 'User not found' }, 404);
        Object.assign(user, body);
        return () => json({ response: user });
    }
    if ((m = path.match(/^\/api\/users\/(\d+)$/))) {
        const user = rw.users.get(Number(m[1]));
        if (!user) return () => json({ message: 'User not found' }, 404);
        if (method === 'DELETE') {
            rw.users.delete(user.id);
            return () => json({ response: { isDeleted: true } });
        }
        return () => json({ response: user });
    }
    if ((m = path.match(/^\/api\/users\/(\d+)\/actions\/(disable|enable|revoke)$/))) {
        const user = rw.users.get(Number(m[1]));
        if (!user) return () => json({ message: 'User not found' }, 404);
        if (m[2] === 'disable') user.status = 'DISABLED';
        if (m[2] === 'enable') user.status = new Date(user.expireAt) > new Date() ? 'ACTIVE' : 'EXPIRED';
        if (m[2] === 'revoke') user.subscriptionUrl = `https://sub.test/${user.id}-${crypto.randomBytes(3).toString('hex')}`;
        return () => json({ response: user });
    }
    if (path === '/api/hwid/devices/delete-all') {
        rw.devices.delete(body.userId);
        return () => json({ response: { total: 0, devices: [] } });
    }
    if ((m = path.match(/^\/api\/hwid\/devices\/(\d+)$/))) {
        const list = rw.devices.get(Number(m[1])) ?? [];
        return () => json({ response: { total: list.length, devices: list } });
    }
    return () => json({ message: `fake remnawave: ${method} ${path} не поддерживается` }, 404);
}

function platega(method, path, body) {
    const p = fakes.platega;
    p.requests.push({ method, path, body });
    let m;
    if (method === 'POST' && path === '/v2/transaction/process') {
        const id = crypto.randomUUID();
        p.transactions.set(id, { id, status: 'PENDING', paymentDetails: body.paymentDetails, payload: body.payload });
        return () => json({ transactionId: id, status: 'PENDING', url: `https://pay.test/${id}`, expiresIn: '00:15:00' });
    }
    if ((m = path.match(/^\/transaction\/([^/]+)\/cancel-supported$/))) {
        return () => json({ supported: p.refund.supported, totalDeductUsdt: 2.5, penaltyUsdt: 0, blockReason: p.refund.supported ? '' : 'test' });
    }
    if ((m = path.match(/^\/transaction\/([^/]+)\/cancel$/))) {
        const { accepted, manualControlRequired } = p.refund;
        if (accepted) {
            const t = p.transactions.get(decodeURIComponent(m[1]));
            if (t) t.status = 'CHARGEBACKED';
        }
        return () => json({ transactionId: m[1], accepted, manualControlRequired, message: accepted ? 'ok' : 'rejected' });
    }
    if ((m = path.match(/^\/transaction\/([^/]+)$/))) {
        const t = p.transactions.get(decodeURIComponent(m[1]));
        return () => (t ? json(t) : json({ message: 'not found' }, 404));
    }
    return () => json({ message: `fake platega: ${method} ${path} не поддерживается` }, 404);
}

function resend(method, path, body) {
    if (method === 'POST' && path === '/emails') {
        const id = crypto.randomUUID();
        fakes.resend.sent.push({ id, ...body });
        return () => json({ id });
    }
    let m;
    if ((m = path.match(/^\/emails\/([\w-]+)$/))) {
        const email = fakes.resend.sent.find((e) => e.id === m[1]);
        return () => (email ? json({ ...email, message_id: `<${email.id}@resend.test>` }) : json({ message: 'not found' }, 404));
    }
    return () => json({ message: `fake resend: ${method} ${path} не поддерживается` }, 404);
}

function telegram(_method, path, body) {
    const name = path.split('/').pop();
    fakes.telegram.calls.push({ method: name, params: body });
    return () => json({ ok: true, result: name === 'sendMessage' ? { message_id: fakes.telegram.calls.length } : true });
}

const handlers = {
    [HOSTS.remnawave]: remnawave,
    [HOSTS.platega]: platega,
    [HOSTS.resend]: resend,
    [HOSTS.telegram]: telegram,
};

globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const handler = handlers[url.origin];
    if (!handler) throw new Error(`fetch в тестах: адрес ${url.origin} не подменён`);
    const method = (init.method ?? 'GET').toUpperCase();
    const route = `${method} ${url.pathname}`;
    const body = init.body ? JSON.parse(init.body) : undefined;

    const i = failures.findIndex((f) => route.startsWith(f.match));
    const failure = i >= 0 ? failures.splice(i, 1)[0] : null;
    if (failure?.mode === 'error') return json({ message: `fake: сбой ${route}` }, failure.status);

    const respond = handler(method, url.pathname, body);
    if (failure?.mode === 'lost-response') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return respond();
};
