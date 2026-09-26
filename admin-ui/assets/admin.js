(() => {
    'use strict';

    // ---------- Утилиты ----------
    const app = document.getElementById('app');
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const rub = (n) => `${Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
    // Как replySubject на сервере: «Re:» не добавляется повторно
    const replySubject = (s) => (/^re\s*:/i.test(String(s).trim()) ? String(s).trim() : `Re: ${String(s).trim()}`);
    const toDate = (s) => (s ? new Date(/\d{4}-\d\d-\d\d \d/.test(s) ? s.replace(' ', 'T') + 'Z' : s) : null);
    const fmtDate = (s) => (s ? toDate(s).toLocaleDateString('ru-RU') : '—');
    const fmtDateTime = (s) => (s ? toDate(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');
    const daysLeft = (s) => Math.ceil((toDate(s) - Date.now()) / 86_400_000);
    const plural = (n, [one, few, many]) => {
        const m10 = Math.abs(n) % 10, m100 = Math.abs(n) % 100;
        if (m10 === 1 && m100 !== 11) return one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
        return many;
    };
    const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v != null)).toString();

    const state = { me: null, plans: [] };
    const isAdmin = () => state.me?.admin.role === 'admin';

    async function api(method, path, body) {
        const res = await fetch(`api/${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
            credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 && state.me && !path.startsWith('login')) {
            state.me = null;
            renderLogin();
        }
        if (!res.ok) {
            const err = new Error(data.error || `Ошибка ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return data;
    }

    function toast(text, type = 'ok') {
        const el = document.createElement('div');
        el.className = `toast toast--${type}`;
        el.textContent = text;
        document.getElementById('toasts').append(el);
        setTimeout(() => el.remove(), type === 'bad' ? 7000 : 3500);
    }

    async function copy(text) {
        try {
            await navigator.clipboard.writeText(text);
            toast('Скопировано');
        } catch {
            toast('Не удалось скопировать — выделите текст вручную', 'bad');
        }
    }

    // Модальное окно. render(body) получает контейнер; onSubmit(form) возвращает промис.
    function modal({ title, subtitle = '', body, submitText = 'Сохранить', danger = false, onSubmit, noSubmit = false }) {
        const root = document.getElementById('modal-root');
        root.innerHTML = `<div class="modal-backdrop"><form class="modal" novalidate>
            <h2>${esc(title)}</h2>${subtitle ? `<p class="muted">${subtitle}</p>` : ''}
            <div class="modal-body form">${body}</div>
            <p class="form-error" hidden></p>
            <div class="modal-actions">
                <button type="button" class="btn btn--ghost" data-close>${noSubmit ? 'Закрыть' : 'Отмена'}</button>
                ${noSubmit ? '' : `<button type="submit" class="btn ${danger ? 'btn--danger' : 'btn--primary'}">${esc(submitText)}</button>`}
            </div></form></div>`;
        const form = root.querySelector('form');
        const close = () => (root.innerHTML = '');
        root.querySelector('[data-close]').onclick = close;
        root.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => e.target === e.currentTarget && close());
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = form.querySelector('[type=submit]');
            const errEl = form.querySelector('.form-error');
            errEl.hidden = true;
            btn.disabled = true;
            try {
                const keepOpen = await onSubmit(form);
                if (!keepOpen) close();
            } catch (err) {
                errEl.textContent = err.message;
                errEl.hidden = false;
            } finally {
                btn.disabled = false;
            }
        });
        setTimeout(() => form.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea')?.focus(), 30);
        return { form, close, body: form.querySelector('.modal-body') };
    }

    const reasonField = (required = true) => `<label class="field"><span>Причина${required ? '' : ' (необязательно)'}</span>
        <textarea name="reason" ${required ? 'required minlength="3"' : ''} placeholder="Например: компенсация за сбой, обращение №123"></textarea></label>`;
    const notifyField = (checked) => `<label class="check"><input type="checkbox" name="notify" ${checked ? 'checked' : ''}> Уведомить клиента по email</label>`;

    // ---------- Статусы ----------
    const USER_STATUS = {
        ACTIVE: ['Активна', 'ok'], EXPIRED: ['Истекла', 'warn'], DISABLED: ['Отключена', 'bad'], LIMITED: ['Лимит', 'warn'], DELETED: ['Удалена в панели', 'bad'],
    };
    function userStatusPill(u) {
        if (!u.rwUserId) return '<span class="pill">Нет подписки</span>';
        if (u.blocked) return '<span class="pill pill--bad">Отключён админом</span>';
        if (u.rwStatus === 'ACTIVE' && u.expireAt && toDate(u.expireAt) < new Date()) return '<span class="pill pill--warn">Истекла</span>';
        const [label, tone] = USER_STATUS[u.rwStatus] || [u.rwStatus || '—', ''];
        const trial = u.planKind === 'trial' ? ' <span class="pill pill--info">Пробный</span>' : '';
        return `<span class="pill pill--${tone}">${esc(label)}</span>${trial}`;
    }
    const ORDER_STATUS = {
        pending: ['Ожидает оплаты', ''], paid: ['Оплачен, выдаётся', 'warn'], applied: ['Оплачен', 'ok'], canceled: ['Не оплачен', ''],
        chargeback: ['Chargeback', 'bad'], refunded: ['Возврат', 'info'], refund_pending: ['Возврат в обработке', 'warn'],
    };
    const orderPill = (s) => {
        const [label, tone] = ORDER_STATUS[s] || [s, ''];
        return `<span class="pill ${tone ? `pill--${tone}` : ''}">${esc(label)}</span>`;
    };

    // ---------- Роутер ----------
    const NAV = [
        { path: 'dashboard', title: 'Сводка', admin: true },
        { path: 'users', title: 'Пользователи' },
        { path: 'orders', title: 'Платежи' },
        { path: 'support', title: 'Обращения' },
        { path: 'plans', title: 'Тарифы', admin: true },
        { path: 'apps', title: 'Приложения', admin: true },
        { path: 'settings', title: 'Настройки', admin: true },
        { path: 'admins', title: 'Администраторы', admin: true },
        { path: 'audit', title: 'Журнал' },
    ];

    function parseRoute() {
        const [pathPart, queryPart = ''] = location.hash.replace(/^#\/?/, '').split('?');
        const parts = pathPart.split('/').filter(Boolean);
        return { name: parts[0] || '', params: parts.slice(1), query: new URLSearchParams(queryPart) };
    }

    async function route() {
        const r = parseRoute();
        if (r.name === 'setup') return renderSetup(r.params[0]?.split('?')[0]);
        if (!state.me) {
            try {
                state.me = await api('GET', 'me');
            } catch {
                return renderLogin();
            }
        }
        const allowed = NAV.filter((n) => !n.admin || isAdmin());
        const name = allowed.some((n) => n.path === r.name) ? r.name : allowed[0].path;
        if (name !== r.name) return (location.hash = `#/${name}`);
        renderShell(name);
        const view = document.getElementById('view');
        view.innerHTML = '<div class="muted">Загрузка…</div>';
        try {
            await VIEWS[name](view, r);
        } catch (err) {
            view.innerHTML = `<div class="note note--bad">${esc(err.message)}</div>`;
        }
    }
    window.addEventListener('hashchange', route);

    function renderShell(active) {
        const items = NAV.filter((n) => !n.admin || isAdmin())
            .map((n) => `<a class="nav-link ${n.path === active ? 'active' : ''}" href="#/${n.path}">${n.title}</a>`)
            .join('');
        if (!document.querySelector('.shell')) {
            app.innerHTML = `<div class="shell">
                <aside class="sidebar">
                    <div class="brand">${esc(state.me.brandName)}<small>Админка</small></div>
                    <nav id="nav"></nav>
                    <div class="sidebar-foot">
                        <div><b>${esc(state.me.admin.login)}</b><div class="muted small">${esc(state.me.admin.roleTitle)}</div></div>
                        <button class="btn btn--sm" id="logout">Выйти</button>
                    </div>
                </aside>
                <div>
                    <div class="mobile-bar"><button class="btn btn--sm" id="nav-toggle">☰</button><b>${esc(state.me.brandName)}</b></div>
                    <main class="main" id="view"></main>
                </div>
            </div>`;
            document.getElementById('logout').onclick = async () => {
                await api('POST', 'logout').catch(() => {});
                state.me = null;
                renderLogin();
            };
            document.getElementById('nav-toggle').onclick = () => document.querySelector('.shell').classList.toggle('nav-open');
        }
        document.getElementById('nav').innerHTML = items;
        document.querySelector('.shell').classList.remove('nav-open');
        refreshSupportBadge();
    }

    // Число непрочитанных обращений рядом с пунктом меню
    async function refreshSupportBadge() {
        const link = document.querySelector('.nav-link[href="#/support"]');
        if (!link) return;
        try {
            const { unread } = await api('GET', 'support/unread');
            link.querySelector('.nav-badge')?.remove();
            if (unread) link.insertAdjacentHTML('beforeend', `<span class="nav-badge">${unread}</span>`);
        } catch {
            // значок необязателен
        }
    }

    // ---------- Вход ----------
    function renderLogin() {
        app.innerHTML = `<div class="auth"><div class="card">
            <h1>Вход в админку</h1>
            <form id="f-pass" class="form">
                <label class="field"><span>Логин</span><input type="text" name="login" autocomplete="username" required></label>
                <label class="field"><span>Пароль</span><input type="password" name="password" autocomplete="current-password" required></label>
                <button class="btn btn--primary btn--block">Продолжить</button>
            </form>
            <form id="f-code" class="form" hidden>
                <p class="muted">Введите 6-значный код из приложения-аутентификатора или резервный код.</p>
                <label class="field"><span>Код</span><input type="text" name="code" autocomplete="one-time-code" inputmode="text" required></label>
                <button class="btn btn--primary btn--block">Войти</button>
                <button type="button" class="btn btn--ghost btn--block" id="back">Назад</button>
            </form>
            <p class="form-error" id="err" hidden></p>
        </div></div>`;
        const err = (m) => {
            const el = document.getElementById('err');
            el.textContent = m || '';
            el.hidden = !m;
        };
        let ticket = null;
        const fp = document.getElementById('f-pass');
        const fc = document.getElementById('f-code');
        fp.login.focus();
        fp.onsubmit = async (e) => {
            e.preventDefault();
            err();
            try {
                const r = await api('POST', 'login', { login: fp.login.value, password: fp.password.value });
                if (r.step === 'totp') {
                    ticket = r.ticket;
                    fp.hidden = true;
                    fc.hidden = false;
                    fc.code.focus();
                } else {
                    location.hash = '';
                    route();
                }
            } catch (e2) {
                err(e2.message);
            }
        };
        fc.onsubmit = async (e) => {
            e.preventDefault();
            err();
            try {
                await api('POST', 'login/totp', { ticket, code: fc.code.value });
                route();
            } catch (e2) {
                err(e2.message);
                if (e2.message.includes('истекла')) document.getElementById('back').click();
            }
        };
        document.getElementById('back').onclick = () => {
            fc.hidden = true;
            fp.hidden = false;
            fp.password.value = '';
            fp.password.focus();
        };
    }

    // ---------- Настройка доступа по ссылке ----------
    async function renderSetup(token) {
        app.innerHTML = '<div class="auth"><div class="card" id="setup">Загрузка…</div></div>';
        const box = document.getElementById('setup');
        let info;
        try {
            info = await api('GET', `setup/${encodeURIComponent(token)}`);
        } catch (e) {
            box.innerHTML = `<h1>Ссылка недействительна</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Перейти ко входу</a>`;
            return;
        }
        const titles = { bootstrap: 'Создание первого администратора', invite: 'Приглашение в админку', reset: 'Восстановление доступа' };
        box.innerHTML = `<h1>${titles[info.kind]}</h1>
            <p class="muted">Роль: ${esc(info.roleTitle)}. Шаг 1 из 2 — задайте пароль.</p>
            <form class="form" id="s1">
                <label class="field"><span>Логин</span><input type="text" name="login" value="${esc(info.login || '')}" ${info.loginEditable ? 'required' : 'readonly'} autocomplete="username"></label>
                <label class="field"><span>Пароль (от 10 символов)</span><input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
                <label class="field"><span>Повторите пароль</span><input type="password" name="password2" required autocomplete="new-password"></label>
                <button class="btn btn--primary btn--block">Далее</button>
                <p class="form-error" hidden></p>
            </form>`;
        const s1 = document.getElementById('s1');
        s1.onsubmit = async (e) => {
            e.preventDefault();
            const errEl = s1.querySelector('.form-error');
            errEl.hidden = true;
            if (s1.password.value !== s1.password2.value) {
                errEl.textContent = 'Пароли не совпадают';
                errEl.hidden = false;
                return;
            }
            try {
                const r = await api('POST', `setup/${encodeURIComponent(token)}/start`, { login: s1.login.value, password: s1.password.value });
                step2(r);
            } catch (e2) {
                errEl.textContent = e2.message;
                errEl.hidden = false;
            }
        };
        function step2(r) {
            box.innerHTML = `<h1>Двухфакторная аутентификация</h1>
                <p class="muted">Шаг 2 из 2. Отсканируйте QR-код в Google Authenticator, Aegis, 1Password или другом приложении и введите код.</p>
                <div class="qr-box">${r.qrSvg}</div>
                <p class="small muted" style="text-align:center">Ключ для ручного ввода:<br><span class="mono">${esc(r.secret.replace(/(.{4})/g, '$1 ').trim())}</span></p>
                <form class="form" id="s2">
                    <label class="field"><span>Код из приложения</span><input type="text" name="code" inputmode="numeric" maxlength="6" required autocomplete="one-time-code"></label>
                    <button class="btn btn--primary btn--block">Подтвердить</button>
                    <p class="form-error" hidden></p>
                </form>`;
            const s2 = document.getElementById('s2');
            s2.code.focus();
            s2.onsubmit = async (e) => {
                e.preventDefault();
                const errEl = s2.querySelector('.form-error');
                errEl.hidden = true;
                try {
                    const res = await api('POST', `setup/${encodeURIComponent(token)}/finish`, { code: s2.code.value });
                    step3(res.backupCodes);
                } catch (e2) {
                    errEl.textContent = e2.message;
                    errEl.hidden = false;
                }
            };
        }
        function step3(codes) {
            box.innerHTML = `<h1>Резервные коды</h1>
                <p class="muted">Сохраните их в надёжном месте. Каждый код можно использовать один раз вместо кода из приложения — например, если телефон потерян. Больше они показаны не будут.</p>
                <div class="codes">${codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
                <div class="actions" style="margin-top:14px">
                    <button class="btn" id="copy-codes">Скопировать</button>
                    <button class="btn btn--primary" id="go">Я сохранил коды — в админку</button>
                </div>`;
            document.getElementById('copy-codes').onclick = () => copy(codes.join('\n'));
            document.getElementById('go').onclick = () => {
                state.me = null;
                location.hash = '#/';
            };
        }
    }

    // ---------- Представления ----------
    const VIEWS = {};

    // --- Сводка ---
    VIEWS.dashboard = async (view) => {
        const s = await api('GET', 'stats');
        const tile = (label, value, sub = '', warn = false) =>
            `<div class="tile ${warn ? 'tile--warn' : ''}"><small>${label}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
        view.innerHTML = `
            <div class="page-head"><h1>Сводка</h1><button class="btn btn--sm" id="refresh">Обновить</button></div>
            ${s.stuckOrders ? `<div class="note note--warn" style="margin-bottom:16px">Есть оплаченные заказы, по которым не удалось выдать подписку: ${s.stuckOrders}. <a href="#/orders?status=paid">Открыть</a></div>` : ''}
            <div class="tiles">
                ${tile('Выручка сегодня', rub(s.revenue.today.sum), `${s.revenue.today.n} ${plural(s.revenue.today.n, ['оплата', 'оплаты', 'оплат'])}`)}
                ${tile('За 7 дней', rub(s.revenue.week.sum), `${s.revenue.week.n} ${plural(s.revenue.week.n, ['оплата', 'оплаты', 'оплат'])}`)}
                ${tile('За 30 дней', rub(s.revenue.month.sum), `${s.revenue.month.n} ${plural(s.revenue.month.n, ['оплата', 'оплаты', 'оплат'])}`)}
                ${tile('Активные подписки', s.active.paid, `+ ${s.active.trial} пробных`)}
                ${tile('Конверсия пробный → оплата', `${Math.round(s.trials.rate * 100)}%`, `${s.trials.converted} из ${s.trials.total}`)}
                ${tile('Пользователей', s.totalUsers)}
            </div>
            <div class="card">
                <div class="card-head"><h2>Выручка по дням, 30 дней</h2><span class="muted small">наведите на столбец</span></div>
                <div class="chart" id="chart"></div>
            </div>
            <div class="grid-2">
                <div class="card">
                    <h2>Продажи по тарифам, 30 дней</h2>
                    <div class="table-wrap"><table class="t"><thead><tr><th>Тариф</th><th class="num">Оплат</th><th class="num">Сумма</th></tr></thead><tbody>
                    ${s.byPlan.map((p) => `<tr><td>${esc(p.planTitle)}</td><td class="num">${p.count}</td><td class="num">${rub(p.sum)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Продаж пока нет</td></tr>'}
                    </tbody></table></div>
                </div>
                <div class="card">
                    <h2>Истекают в ближайшие 3 дня</h2>
                    <div class="table-wrap"><table class="t"><thead><tr><th>Email</th><th>Действует до</th></tr></thead><tbody>
                    ${s.expiring.map((u) => `<tr class="row-link" data-href="#/users/${u.id}"><td>${esc(u.email)}${u.planKind === 'trial' ? ' <span class="pill pill--info">Пробный</span>' : ''}</td><td class="nowrap">${fmtDateTime(u.expireAt)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">Нет</td></tr>'}
                    </tbody></table></div>
                </div>
            </div>`;
        document.getElementById('refresh').onclick = () => VIEWS.dashboard(view);
        bindRowLinks(view);
        const chartEl = document.getElementById('chart');
        drawRevenueChart(chartEl, s.daily);
        let rt;
        window.onresize = () => {
            clearTimeout(rt);
            rt = setTimeout(() => document.body.contains(chartEl) && drawRevenueChart(chartEl, s.daily), 150);
        };
    };

    function drawRevenueChart(el, daily) {
        const W = Math.max(320, el.clientWidth || 900), H = 220, padL = 56, padR = 8, padT = 12, padB = 26;
        const max = Math.max(...daily.map((d) => d.sum), 1);
        const niceMax = (() => {
            const p = 10 ** Math.floor(Math.log10(max));
            return Math.ceil(max / p) * p;
        })();
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const band = plotW / daily.length;
        const barW = Math.min(24, band - 2);
        const y = (v) => padT + plotH - (v / niceMax) * plotH;
        const ticks = [0, niceMax / 2, niceMax];
        const r = 4;
        let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Выручка по дням за 30 дней">`;
        for (const t of ticks) {
            svg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>`;
            svg += `<text class="axis-label" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${Math.round(t).toLocaleString('ru-RU')}</text>`;
        }
        daily.forEach((d, i) => {
            const x = padL + i * band + (band - barW) / 2;
            const top = y(d.sum);
            const h = padT + plotH - top;
            if (h > 0.5) {
                const rr = Math.min(r, h, barW / 2);
                // Скруглён только верх, у основания — прямой угол
                svg += `<path class="bar" data-i="${i}" d="M${x},${top + h} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + barW - rr} Q${x + barW},${top} ${x + barW},${top + rr} V${top + h} Z"/>`;
            }
            svg += `<rect class="bar-hit" data-i="${i}" x="${padL + i * band}" y="${padT}" width="${band}" height="${plotH}"/>`;
            if (i === 0 || i === daily.length - 1 || i === 14) {
                svg += `<text class="axis-label" x="${x + barW / 2}" y="${H - 6}" text-anchor="middle">${new Date(d.day).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</text>`;
            }
        });
        svg += '</svg><div class="tooltip" hidden></div>';
        el.innerHTML = svg;
        const tip = el.querySelector('.tooltip');
        const svgEl = el.querySelector('svg');
        el.querySelectorAll('.bar-hit').forEach((hit) => {
            hit.addEventListener('mouseenter', () => {
                const d = daily[hit.dataset.i];
                el.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
                el.querySelector(`.bar[data-i="${hit.dataset.i}"]`)?.classList.add('hover');
                const box = hit.getBoundingClientRect();
                const host = el.getBoundingClientRect();
                const scaleY = 1;
                tip.innerHTML = `${new Date(d.day).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}<b>${rub(d.sum)}</b>${d.count} ${plural(d.count, ['оплата', 'оплаты', 'оплат'])}`;
                tip.style.left = `${box.left - host.left + box.width / 2}px`;
                tip.style.top = `${y(d.sum) * scaleY}px`;
                tip.hidden = false;
            });
        });
        svgEl.addEventListener('mouseleave', () => {
            tip.hidden = true;
            el.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
        });
    }

    function bindRowLinks(root) {
        root.querySelectorAll('[data-href]').forEach((row) => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button, a')) return;
                location.hash = row.dataset.href;
            });
        });
    }

    function pager(root, { total, page, pageSize }, onPage) {
        const pages = Math.max(1, Math.ceil(total / pageSize));
        const el = document.createElement('div');
        el.className = 'pager';
        el.innerHTML = `<span>Всего: ${total}</span>${pages > 1 ? `<button class="btn btn--sm" ${page <= 1 ? 'disabled' : ''} data-p="${page - 1}">←</button><span>${page} / ${pages}</span><button class="btn btn--sm" ${page >= pages ? 'disabled' : ''} data-p="${page + 1}">→</button>` : ''}`;
        el.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => onPage(Number(b.dataset.p))));
        root.append(el);
    }

    // --- Пользователи ---
    const USER_FILTERS = [
        ['', 'Все'], ['active', 'Активные'], ['trial', 'Пробный период'], ['expiring', 'Истекают за 3 дня'],
        ['expired', 'Истекли'], ['disabled', 'Отключены'], ['none', 'Без подписки'],
    ];

    VIEWS.users = async (view, r) => {
        const params = r.params[0];
        if (params) return renderUserCard(view, params);
        const f = { q: r.query.get('q') || '', filter: r.query.get('filter') || '', page: Number(r.query.get('page')) || 1 };
        view.innerHTML = `
            <div class="page-head"><h1>Пользователи</h1>
                <div class="actions">
                    ${isAdmin() ? '<button class="btn" id="csv">Скачать CSV</button><button class="btn btn--primary" id="grant">Выдать доступ</button>' : ''}
                </div>
            </div>
            <div class="toolbar">
                <input type="search" id="q" placeholder="Поиск по email" value="${esc(f.q)}">
                <div class="chips">${USER_FILTERS.map(([k, t]) => `<button class="chip ${f.filter === k ? 'active' : ''}" data-f="${k}">${t}</button>`).join('')}</div>
            </div>
            <div class="card" style="padding:6px 10px"><div id="list" class="table-wrap muted">Загрузка…</div></div>`;
        const go = (patch) => (location.hash = `#/users?${qs({ ...f, page: 1, ...patch })}`);
        let t;
        view.querySelector('#q').addEventListener('input', (e) => {
            clearTimeout(t);
            t = setTimeout(() => go({ q: e.target.value }), 350);
        });
        view.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => go({ filter: b.dataset.f })));
        if (isAdmin()) {
            view.querySelector('#csv').onclick = () => (location.href = `api/users.csv?${qs({ q: f.q, filter: f.filter })}`);
            view.querySelector('#grant').onclick = () => grantModal();
        }
        const data = await api('GET', `users?${qs(f)}`);
        const list = view.querySelector('#list');
        list.classList.remove('muted');
        list.innerHTML = `<table class="t"><thead><tr><th>Email</th><th>Статус</th><th>Действует до</th><th class="num">Оплачено</th><th>Регистрация</th></tr></thead><tbody>
            ${data.items.map((u) => `<tr class="row-link" data-href="#/users/${u.id}">
                <td>${esc(u.email)}</td><td>${userStatusPill(u)}</td>
                <td class="nowrap">${u.expireAt ? fmtDate(u.expireAt) : '—'}</td>
                <td class="num">${u.paidTotal ? rub(u.paidTotal) : '—'}</td>
                <td class="nowrap muted">${fmtDate(u.createdAt)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Никого не найдено</td></tr>'}
            </tbody></table>`;
        bindRowLinks(list);
        pager(list, data, (p) => go({ page: p }));
        // Сохраняем фокус в поиске после перерисовки по вводу
        const q = view.querySelector('#q');
        if (f.q) {
            q.focus();
            q.setSelectionRange(q.value.length, q.value.length);
        }
    };

    async function grantModal(email = '') {
        if (!state.plans.length) state.plans = await api('GET', 'plans');
        const m = modal({
            title: 'Выдать доступ без оплаты',
            subtitle: 'Если аккаунта с таким email нет — он будет создан. Если подписка уже есть — дни добавятся к текущему сроку.',
            body: `<label class="field"><span>Email</span><input type="email" name="email" required value="${esc(email)}"></label>
                <label class="field"><span>Тариф</span><select name="planId">
                    ${state.plans.map((p) => `<option value="${esc(p.id)}">${esc(p.title)} — ${p.days} дн.${p.hidden ? ' (скрыт)' : ''}</option>`).join('')}
                    <option value="">Свой срок</option>
                </select></label>
                <label class="field" data-days hidden><span>Дней</span><input type="number" name="days" min="1" max="3650" value="30"></label>
                ${reasonField()}${notifyField(true)}`,
            submitText: 'Выдать',
            onSubmit: async (form) => {
                const planId = form.planId.value;
                const r = await api('POST', 'users/grant', {
                    email: form.email.value,
                    planId: planId || undefined,
                    days: planId ? undefined : Number(form.days.value),
                    reason: form.reason.value,
                    notify: form.notify.checked,
                });
                toast('Доступ выдан');
                location.hash = `#/users/${r.userId}`;
            },
        });
        const daysField = m.form.querySelector('[data-days]');
        m.form.planId.onchange = (e) => (daysField.hidden = Boolean(e.target.value));
    }

    async function renderUserCard(view, id) {
        const d = await api('GET', `users/${id}`);
        const u = d.user;
        const s = d.subscription;
        const left = s ? daysLeft(s.expireAt) : null;
        const admin = isAdmin();
        const btn = (action, text, cls = '') => `<button class="btn btn--sm ${cls}" data-act="${action}">${text}</button>`;
        view.innerHTML = `
            <div class="page-head">
                <div><a href="#/users" class="small">← Пользователи</a><h1 style="margin-top:4px">${esc(u.email)}</h1></div>
                <div>${userStatusPill({ ...u, rwStatus: s?.status ?? u.rwStatus, expireAt: s?.expireAt ?? u.expireAt })}</div>
            </div>
            ${d.rwError ? `<div class="note note--bad" style="margin-bottom:16px">Не удалось получить данные из панели Remnawave: ${esc(d.rwError)}</div>` : ''}
            ${u.trialBlocked ? '<div class="note note--warn" style="margin-bottom:16px">Пробный период отключён: устройство уже использовалось на другом пробном периоде.</div>' : ''}
            ${u.blocked ? '<div class="note note--bad" style="margin-bottom:16px">Пользователь отключён администратором — оплата в личном кабинете для него закрыта.</div>' : ''}
            <div class="grid-2">
                <div class="card">
                    <div class="card-head"><h2>Подписка</h2>${d.panelUrl ? `<a class="small" href="${esc(d.panelUrl)}" target="_blank" rel="noopener">Открыть в панели ↗</a>` : ''}</div>
                    ${s ? `<dl class="kv">
                        <dt>Действует до</dt><dd>${fmtDateTime(s.expireAt)} <span class="muted">(${toDate(s.expireAt) <= new Date() ? 'истекла' : left <= 1 ? 'меньше суток' : `осталось ${left} ${plural(left, ['день', 'дня', 'дней'])}`})</span></dd>
                        <dt>Тип</dt><dd>${u.planKind === 'trial' ? 'Пробный период' : u.planKind === 'paid' ? 'Платная' : '—'}</dd>
                        <dt>Устройства</dt><dd>${d.devices.length} из ${s.deviceLimit || '∞'}</dd>
                        <dt>Пользователь в панели</dt><dd class="mono">${esc(s.username)}</dd>
                        <dt>Ссылка</dt><dd><div class="copy-box"><input type="text" readonly value="${esc(s.subscriptionUrl)}"><button class="btn btn--sm" data-copy="${esc(s.subscriptionUrl)}">Копировать</button></div></dd>
                    </dl>` : '<p class="muted">Подписки нет.</p>'}
                </div>
                <div class="card">
                    <h2>Действия</h2>
                    <div class="actions">
                        ${admin || s ? btn('extend', admin ? 'Продлить / сократить' : `Продлить (до ${state.me.supportMaxDays} дн.)`, 'btn--primary') : ''}
                        ${s ? btn('resend', 'Отправить ссылку на почту') : ''}
                        ${s ? btn('revoke', 'Перевыпустить ссылку') : ''}
                        ${s ? btn('devices', 'Сбросить устройства') : ''}
                        ${admin && s ? (s.status === 'DISABLED' ? btn('enable', 'Включить') : btn('disable', 'Отключить', 'btn--danger')) : ''}
                        ${admin && (u.trialBlocked || !u.rwUserId) && u.trialUsedAt ? btn('trial', 'Сбросить пробный период') : ''}
                    </div>
                    ${admin ? `<div class="actions" style="margin-top:10px">
                        ${s ? btn('delete-sub', 'Удалить подписку', 'btn--danger') : ''}
                        ${btn('delete-account', 'Удалить аккаунт', 'btn--danger')}
                    </div>` : ''}
                    <dl class="kv" style="margin-top:16px">
                        <dt>Регистрация</dt><dd>${fmtDateTime(u.createdAt)}</dd>
                        <dt>Пробный период</dt><dd>${u.trialUsedAt ? `использован ${fmtDate(u.trialUsedAt)}` : 'не использован'}</dd>
                        ${(d.telegram || []).length ? `<dt>Telegram</dt><dd>${d.telegram.map((t) => `${t.username ? `<a href="https://t.me/${esc(t.username)}" target="_blank" rel="noopener">@${esc(t.username)}</a>` : esc(t.name || '')} <span class="muted mono">${esc(t.tgUserId)}</span>`).join('<br>')}</dd>` : ''}
                    </dl>
                </div>
            </div>
            <div class="card">
                <h2>Устройства</h2>
                <div class="table-wrap"><table class="t"><thead><tr><th>Платформа</th><th>Модель</th><th>HWID</th><th>Подключено</th></tr></thead><tbody>
                ${d.devices.map((x) => `<tr><td>${esc(x.platform || '—')} ${esc(x.osVersion || '')}</td><td>${esc(x.model || '—')}</td><td class="mono">${esc(x.hwid)}</td><td class="nowrap">${fmtDateTime(x.createdAt)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Устройств нет</td></tr>'}
                </tbody></table></div>
            </div>
            <div class="card">
                <h2>Платежи</h2>
                <div class="table-wrap">${ordersTable(d.orders, { showEmail: false })}</div>
            </div>
            <div class="card">
                <h2>Обращения в поддержку</h2>
                <div class="table-wrap"><table class="t"><thead><tr><th>Тема</th><th>Статус</th><th class="num">Писем</th><th>Последнее</th></tr></thead><tbody>
                ${(d.supportThreads || []).map((x) => `<tr class="row-link ${x.unread ? 'unread' : ''}" data-href="#/support/${x.id}">
                    <td>${esc(x.subject || '(без темы)')}</td><td>${supportPill(x.status)}</td><td class="num">${x.messagesCount}</td>
                    <td class="nowrap muted">${fmtDateTime(x.lastMessageAt)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Обращений нет</td></tr>'}
                </tbody></table></div>
            </div>
            <div class="card">
                <h2>История действий администраторов</h2>
                ${d.history.map(historyItem).join('') || '<p class="muted">Пока нет.</p>'}
            </div>`;

        view.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
        bindOrderActions(view, () => renderUserCard(view, id));
        bindRowLinks(view);
        const done = (msg) => {
            toast(msg);
            renderUserCard(view, id);
        };
        const act = {
            extend: () => modal({
                title: admin ? 'Продлить или сократить подписку' : 'Продлить подписку',
                subtitle: admin ? 'Положительное число — продление, отрицательное — сокращение срока.' : `Не больше ${state.me.supportMaxDays} дней на клиента за 30 дней — суммарно по всем сотрудникам поддержки. Больше — через администратора.`,
                body: `<label class="field"><span>Дней</span><input type="number" name="days" value="${admin ? 30 : 3}" ${admin ? 'min="-3650"' : 'min="1"'} max="${admin ? 3650 : state.me.supportMaxDays}" required></label>
                    ${reasonField()}${notifyField(true)}`,
                onSubmit: async (f) => {
                    const r = await api('POST', `users/${id}/extend`, { days: Number(f.days.value), reason: f.reason.value, notify: f.notify.checked });
                    done(`Готово: действует до ${fmtDate(r.expireAt)}`);
                },
            }),
            resend: () => modal({
                title: 'Отправить ссылку на почту',
                subtitle: `Письмо со ссылкой на подписку уйдёт на ${esc(u.email)}.`,
                body: reasonField(false),
                submitText: 'Отправить',
                onSubmit: async (f) => {
                    await api('POST', `users/${id}/resend-link`, { reason: f.reason.value });
                    done('Письмо отправлено');
                },
            }),
            revoke: () => modal({
                title: 'Перевыпустить ссылку',
                subtitle: 'Старая ссылка перестанет работать — клиенту нужно будет добавить новую в приложение.',
                body: reasonField() + notifyField(true),
                submitText: 'Перевыпустить',
                danger: true,
                onSubmit: async (f) => {
                    await api('POST', `users/${id}/revoke-link`, { reason: f.reason.value, notify: f.notify.checked });
                    done('Ссылка перевыпущена');
                },
            }),
            devices: () => modal({
                title: 'Сбросить устройства',
                subtitle: 'Все устройства будут отвязаны, клиент сможет подключить новые.',
                body: reasonField() + notifyField(false),
                submitText: 'Сбросить',
                danger: true,
                onSubmit: async (f) => {
                    const r = await api('POST', `users/${id}/reset-devices`, { reason: f.reason.value, notify: f.notify.checked });
                    done(`Отвязано устройств: ${r.removed}`);
                },
            }),
            disable: () => modal({
                title: 'Отключить пользователя',
                subtitle: 'Подписка перестанет работать, оплата в кабинете будет закрыта до включения.',
                body: reasonField() + notifyField(false),
                submitText: 'Отключить',
                danger: true,
                onSubmit: async (f) => {
                    await api('POST', `users/${id}/disable`, { reason: f.reason.value, notify: f.notify.checked });
                    done('Пользователь отключён');
                },
            }),
            enable: () => modal({
                title: 'Включить пользователя',
                body: reasonField() + notifyField(true),
                submitText: 'Включить',
                onSubmit: async (f) => {
                    await api('POST', `users/${id}/enable`, { reason: f.reason.value, notify: f.notify.checked });
                    done('Пользователь включён');
                },
            }),
            'delete-sub': () => modal({
                title: 'Удалить подписку',
                subtitle: 'Пользователь будет удалён из панели Remnawave, ссылка перестанет работать. Аккаунт на сайте и история платежей останутся: клиент сможет войти и оформить подписку заново.',
                body: reasonField() + notifyField(false),
                submitText: 'Удалить подписку',
                danger: true,
                onSubmit: async (f) => {
                    await api('POST', `users/${id}/delete-subscription`, { reason: f.reason.value, notify: f.notify.checked });
                    done('Подписка удалена');
                },
            }),
            'delete-account': () => modal({
                title: 'Удалить аккаунт',
                subtitle: `Подписка удаляется из панели, email и вход в кабинет — тоже. Записи о платежах остаются без email: они нужны для отчётности и споров с банком. Действие необратимо.`,
                body: `<div class="note note--bad">Для подтверждения введите email пользователя: <b>${esc(u.email)}</b></div>
                    <label class="field"><span>Email</span><input type="text" name="confirmEmail" required autocomplete="off"></label>
                    ${reasonField()}`,
                submitText: 'Удалить аккаунт',
                danger: true,
                onSubmit: async (f) => {
                    await api('POST', `users/${id}/delete-account`, { confirmEmail: f.confirmEmail.value, reason: f.reason.value });
                    toast('Аккаунт удалён');
                    location.hash = '#/users';
                },
            }),
            trial: () => modal({
                title: 'Сбросить пробный период',
                subtitle: u.trialBlocked ? 'Снимет отметку о повторном устройстве и включит пробную подписку.' : 'Клиент сможет снова активировать пробный период.',
                body: reasonField(),
                submitText: 'Сбросить',
                onSubmit: async (f) => {
                    await api('POST', `users/${id}/reset-trial`, { reason: f.reason.value });
                    done('Пробный период сброшен');
                },
            }),
        };
        view.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => act[b.dataset.act]()));
    }

    function historyItem(h) {
        return `<div class="history-item">
            <div><b>${esc(h.actionTitle)}</b>${h.targetLabel ? ` · ${esc(h.targetLabel)}` : ''}${h.reason ? ` — ${esc(h.reason)}` : ''}</div>
            <div class="meta">${fmtDateTime(h.createdAt)} · ${esc(h.adminLogin)}</div>
            ${h.details ? `<details class="raw"><summary>Подробности</summary><pre>${esc(JSON.stringify(h.details, null, 2))}</pre></details>` : ''}
        </div>`;
    }

    // --- Платежи ---
    function ordersTable(orders, { showEmail = true } = {}) {
        const admin = isAdmin();
        return `<table class="t"><thead><tr><th>Дата</th>${showEmail ? '<th>Email</th>' : ''}<th>Тариф</th><th class="num">Сумма</th><th>Статус</th><th></th></tr></thead><tbody>
            ${orders.map((o) => `<tr>
                <td class="nowrap">${fmtDateTime(o.createdAt)}</td>
                ${showEmail ? `<td><a href="#/users/${o.userId}">${esc(o.email)}</a></td>` : ''}
                <td>${esc(o.planTitle)} <span class="muted small">${o.days} дн.</span></td>
                <td class="num">${rub(o.amount)}</td>
                <td>${orderPill(o.status)}${o.error ? `<div class="small" style="color:var(--bad)" title="${esc(o.error)}">ошибка выдачи</div>` : ''}${o.refundInfo?.message ? `<div class="small muted">${esc(o.refundInfo.message)}</div>` : ''}</td>
                <td class="nowrap" style="text-align:right">
                    ${admin && ['pending', 'paid'].includes(o.status) ? `<button class="btn btn--sm" data-sync="${o.id}">Сверить</button>` : ''}
                    ${admin && ['applied', 'paid'].includes(o.status) ? `<button class="btn btn--sm btn--danger" data-refund="${o.id}">Возврат</button>` : ''}
                </td></tr>`).join('') || `<tr><td colspan="${showEmail ? 6 : 5}" class="empty">Платежей нет</td></tr>`}
            </tbody></table>`;
    }

    function bindOrderActions(root, reload) {
        root.querySelectorAll('[data-sync]').forEach((b) => (b.onclick = async () => {
            b.disabled = true;
            try {
                const r = await api('POST', `orders/${b.dataset.sync}/sync`);
                toast(`Статус: ${ORDER_STATUS[r.status]?.[0] ?? r.status}${r.error ? ` (ошибка: ${r.error})` : ''}`, r.error ? 'bad' : 'ok');
                reload();
            } catch (e) {
                toast(e.message, 'bad');
                b.disabled = false;
            }
        }));
        root.querySelectorAll('[data-refund]').forEach((b) => (b.onclick = () => refundModal(b.dataset.refund, reload)));
    }

    async function refundModal(orderId, reload) {
        const m = modal({ title: 'Возврат средств', body: '<p class="muted">Проверяем возможность возврата в Platega…</p>', noSubmit: true, onSubmit: async () => {} });
        let p;
        try {
            p = await api('GET', `orders/${orderId}/refund`);
        } catch (e) {
            m.body.innerHTML = `<div class="note note--bad">${esc(e.message)}</div>`;
            return;
        }
        if (!p.supported) {
            m.body.innerHTML = `<div class="note note--bad">Возврат сейчас невозможен${p.blockReason ? `: ${esc(p.blockReason)}` : ''}. Проверьте баланс в кабинете Platega.</div>`;
            return;
        }
        modal({
            title: `Возврат ${rub(p.amount)}`,
            subtitle: `С баланса Platega будет списано ${p.totalDeductUsdt} USDT${p.penaltyUsdt ? ` (в т.ч. штраф ${p.penaltyUsdt} USDT)` : ''}.`,
            body: `<div class="radio-list">
                    ${p.daysApplied
                        ? `<label><input type="radio" name="action" value="remove_days" checked><span><b>Снять дни заказа</b><br><span class="muted small">Срок подписки уменьшится на ${p.days} дн.</span></span></label>`
                        : '<p class="muted small">Дни по этому заказу ещё не начислены: после возврата заказ не будет выдан, срок подписки не изменится.</p>'}
                    <label><input type="radio" name="action" value="disable"><span><b>Отключить подписку</b><br><span class="muted small">Доступ прекратится сразу, оплата в кабинете закроется.</span></span></label>
                    <label><input type="radio" name="action" value="keep" ${p.daysApplied ? '' : 'checked'}><span><b>Не трогать доступ</b><br><span class="muted small">Подписка останется как есть.</span></span></label>
                </div>
                ${reasonField()}${notifyField(true)}`,
            submitText: 'Оформить возврат',
            danger: true,
            onSubmit: async (f) => {
                const r = await api('POST', `orders/${orderId}/refund`, {
                    subscriptionAction: f.action.value, reason: f.reason.value, notify: f.notify.checked,
                });
                if (r.status === 'refund_pending') toast(`Platega: ${r.message || 'требуется ручная обработка'}. Свяжитесь с поддержкой Platega.`, 'bad');
                else toast('Возврат оформлен');
                if (r.subscription?.error) toast(`Подписку изменить не удалось: ${r.subscription.error}`, 'bad');
                reload();
            },
        });
    }

    VIEWS.orders = async (view, r) => {
        if (!state.plans.length) state.plans = await api('GET', 'plans');
        const f = {
            q: r.query.get('q') || '', status: r.query.get('status') || '', plan: r.query.get('plan') || '',
            from: r.query.get('from') || '', to: r.query.get('to') || '', page: Number(r.query.get('page')) || 1,
        };
        view.innerHTML = `
            <div class="page-head"><h1>Платежи</h1>${isAdmin() ? '<button class="btn" id="csv">Скачать CSV</button>' : ''}</div>
            <form class="toolbar" id="filters">
                <input type="search" name="q" placeholder="Email, номер заказа или транзакции" value="${esc(f.q)}">
                <select name="status"><option value="">Все статусы</option>${Object.entries(ORDER_STATUS).map(([k, [t]]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
                <select name="plan"><option value="">Все тарифы</option>${state.plans.map((p) => `<option value="${esc(p.id)}" ${f.plan === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select>
                <input type="date" name="from" value="${esc(f.from)}" title="С даты">
                <input type="date" name="to" value="${esc(f.to)}" title="По дату">
                <button class="btn">Применить</button>
                ${Object.values(f).some((v) => v && v !== 1) ? '<a class="btn btn--ghost" href="#/orders">Сбросить</a>' : ''}
            </form>
            <div class="card" style="padding:6px 10px"><div id="list" class="table-wrap muted">Загрузка…</div></div>`;
        const form = view.querySelector('#filters');
        form.onsubmit = (e) => {
            e.preventDefault();
            location.hash = `#/orders?${qs(Object.fromEntries(new FormData(form)))}`;
        };
        if (isAdmin()) view.querySelector('#csv').onclick = () => (location.href = `api/orders.csv?${qs({ ...f, page: '' })}`);
        const data = await api('GET', `orders?${qs(f)}`);
        const list = view.querySelector('#list');
        list.classList.remove('muted');
        list.innerHTML = `<p class="muted small" style="margin:8px 10px">Оплачено по фильтру: <b>${rub(data.paidSum)}</b></p>${ordersTable(data.items)}`;
        bindOrderActions(list, () => VIEWS.orders(view, r));
        pager(list, data, (p) => (location.hash = `#/orders?${qs({ ...f, page: p })}`));
    };

    // --- Обращения ---
    const SUPPORT_STATUS = { new: ['Новое', 'info'], waiting: ['Ждёт ответа', 'warn'], answered: ['Отвечено', 'ok'], closed: ['Закрыто', ''] };
    const supportPill = (s) => {
        const [label, tone] = SUPPORT_STATUS[s] || [s, ''];
        return `<span class="pill ${tone ? `pill--${tone}` : ''}">${esc(label)}</span>`;
    };
    const SUPPORT_FILTERS = [['open', 'Открытые'], ['unread', 'Непрочитанные'], ['new', 'Новые'], ['waiting', 'Ждут ответа'], ['answered', 'Отвечено'], ['closed', 'Закрыто'], ['', 'Все']];
    const fileSize = (n) => (n == null ? '' : n < 1024 ? `${n} Б` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} КБ` : `${(n / 1024 ** 2).toFixed(1)} МБ`);

    VIEWS.support = async (view, r) => {
        if (r.params[0]) return renderThread(view, r.params[0]);
        const f = { status: r.query.has('status') ? r.query.get('status') : 'open', q: r.query.get('q') || '', page: Number(r.query.get('page')) || 1 };
        view.innerHTML = `
            <div class="page-head"><h1>Обращения</h1>
                ${state.me.demo ? '<button class="btn" id="demo-mail">Сымитировать письмо (демо)</button>' : ''}
            </div>
            <div class="toolbar">
                <input type="search" id="q" placeholder="Поиск по email или теме" value="${esc(f.q)}">
                <div class="chips" id="chips"></div>
            </div>
            <div class="card" style="padding:6px 10px"><div id="list" class="table-wrap muted">Загрузка…</div></div>`;
        const go = (patch) => (location.hash = `#/support?${new URLSearchParams({ ...f, page: 1, ...patch }).toString()}`);
        let t;
        view.querySelector('#q').addEventListener('input', (e) => {
            clearTimeout(t);
            t = setTimeout(() => go({ q: e.target.value }), 350);
        });
        if (state.me.demo) view.querySelector('#demo-mail').onclick = demoMailModal;

        const data = await api('GET', `support?${qs(f)}`);
        view.querySelector('#chips').innerHTML = SUPPORT_FILTERS.map(([k, title]) => {
            const n = k ? data.counts[k] : null;
            return `<button class="chip ${f.status === k ? 'active' : ''}" data-f="${k}">${title}${n ? `<span class="count">${n}</span>` : ''}</button>`;
        }).join('');
        view.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => go({ status: b.dataset.f })));

        const list = view.querySelector('#list');
        list.classList.remove('muted');
        list.innerHTML = `<table class="t"><thead><tr><th>Email</th><th>Тема</th><th>Статус</th><th class="num">Писем</th><th>Последнее</th></tr></thead><tbody>
            ${data.items.map((x) => `<tr class="row-link ${x.unread ? 'unread' : ''}" data-href="#/support/${x.id}">
                <td>${esc(x.email)}</td>
                <td>${esc(x.subject || '(без темы)')}</td>
                <td>${supportPill(x.status)}</td>
                <td class="num">${x.messagesCount}</td>
                <td class="nowrap muted">${fmtDateTime(x.lastMessageAt)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Обращений нет</td></tr>'}
            </tbody></table>`;
        bindRowLinks(list);
        pager(list, data, (p) => go({ page: p }));
        const q = view.querySelector('#q');
        if (f.q) {
            q.focus();
            q.setSelectionRange(q.value.length, q.value.length);
        }
    };

    function demoMailModal() {
        modal({
            title: 'Входящее письмо (демо)',
            subtitle: 'Демо-версия Resend «примет» письмо и отправит приложению подписанный вебхук — как в настоящей работе.',
            body: `<label class="field"><span>От кого</span><input type="email" name="from" value="client@example.com" required></label>
                <label class="field"><span>Тема</span><input type="text" name="subject" value="Вопрос по подписке"></label>
                <label class="field"><span>Текст</span><textarea name="text">Здравствуйте! Не получается подключиться, подскажите, что делать?</textarea></label>
                <label class="check"><input type="checkbox" name="replyToLast"> Ответ клиента на последний ответ поддержки (In-Reply-To)</label>`,
            submitText: 'Отправить',
            onSubmit: async (form) => {
                await api('POST', 'support/demo-inbound', {
                    from: form.from.value, subject: form.subject.value, text: form.text.value, replyToLast: form.replyToLast.checked,
                });
                toast('Письмо отправлено, обновляю список…');
                setTimeout(route, 800);
            },
        });
    }

    // Текст письма: всё экранируется, строки цитаты ("> ") показываются бледнее
    const messageText = (text) => esc(text || '').split('\n')
        .map((line) => (/^\s*&gt;/.test(line) ? `<span class="quote">${line}</span>` : line)).join('\n');

    async function renderThread(view, id) {
        const d = await api('GET', `support/${id}`);
        const t = d.thread;
        view.innerHTML = `
            <div class="page-head">
                <div><a href="#/support" class="small">← Обращения</a><h1 style="margin-top:4px">${esc(t.subject || '(без темы)')}</h1>
                    <div class="muted">№${t.id} · ${esc(t.email)}${d.user ? ` · <a href="#/users/${d.user.id}">Карточка пользователя</a>` : ' · не зарегистрирован на сайте'}</div>
                </div>
                <div class="actions" style="align-items:center">${supportPill(t.status)}
                    <select id="status" style="width:auto">${Object.entries(SUPPORT_STATUS).map(([k, [label]]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${label}</option>`).join('')}</select>
                </div>
            </div>
            <div id="messages">${d.messages.map((m) => `
                <div class="msg ${m.direction === 'out' ? 'msg--out' : ''}">
                    <div class="msg-head">
                        <div><b>${m.direction === 'out' ? `Поддержка${m.adminLogin ? ` (${esc(m.adminLogin)})` : ''}` : esc(m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr)}</b>
                            <div class="meta">${m.direction === 'out' ? `кому: ${esc(m.to)}` : `кому: ${esc(m.to || '—')}${m.cc ? ` · копия: ${esc(m.cc)}` : ''}`}</div></div>
                        <div class="meta">${fmtDateTime(m.createdAt)}</div>
                    </div>
                    ${m.contentMissing ? '<div class="note note--warn" style="margin-bottom:8px">Текст письма получить не удалось — сохранены только отправитель и тема. Письмо можно посмотреть в панели Resend.</div>' : ''}
                    <pre class="msg-text">${messageText(m.text) || '<span class="muted">(пустое письмо)</span>'}</pre>
                    ${m.truncated ? '<p class="small muted">Письмо слишком большое и сохранено не полностью.</p>' : ''}
                    ${m.hasHtml ? `<div style="margin-top:8px"><button class="btn btn--sm" data-html="${m.id}">Показать HTML-версию</button>
                        <span class="small muted">— откроется в изолированном окне: без скриптов и внешних картинок</span></div>` : ''}
                    ${m.attachments.length ? `<div class="msg-files">${m.attachments.map((a) => `<a class="btn btn--sm" href="api/support/attachments/${a.id}" download>📎 ${esc(a.filename)} <span class="muted">${fileSize(a.size)}</span></a>`).join('')}</div>` : ''}
                </div>`).join('')}
            </div>
            <div class="card reply-box">
                <h2>Ответить</h2>
                <form class="form" id="reply">
                    <p class="small muted" style="margin:0">Письмо уйдёт на ${esc(t.email)} с темой «${esc(replySubject(t.subject || `Обращение №${t.id}`))}». Предыдущее сообщение клиента будет процитировано внизу.</p>
                    <textarea name="text" required maxlength="20000" placeholder="Текст ответа"></textarea>
                    <div class="actions" style="justify-content:space-between;align-items:center">
                        <label class="check"><input type="checkbox" name="close"> Закрыть обращение после ответа</label>
                        <button class="btn btn--primary">Отправить ответ</button>
                    </div>
                    <p class="form-error" hidden></p>
                </form>
            </div>`;
        refreshSupportBadge();

        view.querySelectorAll('[data-html]').forEach((b) => (b.onclick = () => {
            // sandbox без allow-scripts и allow-same-origin; сервер дополнительно запрещает внешние ресурсы через CSP
            const frame = document.createElement('iframe');
            frame.className = 'msg-html';
            frame.setAttribute('sandbox', '');
            frame.setAttribute('referrerpolicy', 'no-referrer');
            frame.src = `api/support/messages/${b.dataset.html}/html`;
            b.parentElement.replaceWith(frame);
        }));

        view.querySelector('#status').onchange = async (e) => {
            try {
                await api('POST', `support/${id}/status`, { status: e.target.value });
                toast('Статус изменён');
                renderThread(view, id);
            } catch (err) {
                toast(err.message, 'bad');
            }
        };

        const form = view.querySelector('#reply');
        form.onsubmit = async (e) => {
            e.preventDefault();
            const errEl = form.querySelector('.form-error');
            const btn = form.querySelector('button');
            errEl.hidden = true;
            btn.disabled = true;
            try {
                const r = await api('POST', `support/${id}/reply`, { text: form.text.value, close: form.close.checked });
                toast(r.sent ? 'Ответ отправлен' : 'Ответ сохранён (RESEND_API_KEY не задан — письмо выведено в консоль)');
                renderThread(view, id);
            } catch (err) {
                errEl.textContent = err.message;
                errEl.hidden = false;
                btn.disabled = false;
            }
        };
    }

    // --- Тарифы ---
    VIEWS.plans = async (view) => {
        let plans = await api('GET', 'plans');
        const render = () => {
            view.innerHTML = `
                <div class="page-head"><h1>Тарифы</h1><div class="actions"><button class="btn" id="add">Добавить тариф</button><button class="btn btn--primary" id="save">Сохранить</button></div></div>
                <div class="note" style="margin-bottom:14px">Изменения сразу появятся на сайте. Цена и срок уже созданных заказов не меняются. Скрытый тариф пропадает с сайта, но старые заказы по нему сохраняются. ID лучше не менять — по нему связаны заказы.</div>
                <div class="card" style="padding:6px 10px"><div class="table-wrap"><table class="t edit-table"><thead><tr>
                    <th>Порядок</th><th>ID</th><th>Название</th><th>Дней</th><th>Цена, ₽</th><th>Метка</th><th>Скрыт</th><th></th></tr></thead><tbody>
                    ${plans.map((p, i) => `<tr data-i="${i}">
                        <td class="nowrap"><button class="btn btn--sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button> <button class="btn btn--sm" data-down="${i}" ${i === plans.length - 1 ? 'disabled' : ''}>↓</button></td>
                        <td><input type="text" data-k="id" value="${esc(p.id)}" style="width:90px"></td>
                        <td><input type="text" data-k="title" value="${esc(p.title)}"></td>
                        <td><input type="number" data-k="days" value="${p.days}" min="1" style="width:90px"></td>
                        <td><input type="number" data-k="price" value="${p.price}" min="1" step="0.01" style="width:110px"></td>
                        <td><input type="text" data-k="badge" value="${esc(p.badge || '')}" placeholder="—"></td>
                        <td><input type="checkbox" data-k="hidden" ${p.hidden ? 'checked' : ''}></td>
                        <td><button class="btn btn--sm btn--danger" data-del="${i}">Удалить</button></td>
                    </tr>`).join('')}
                </tbody></table></div></div>`;
            const collect = () => {
                view.querySelectorAll('tr[data-i]').forEach((tr) => {
                    const p = plans[tr.dataset.i];
                    tr.querySelectorAll('[data-k]').forEach((inp) => (p[inp.dataset.k] = inp.type === 'checkbox' ? inp.checked : inp.value));
                });
            };
            const swap = (a, b) => {
                collect();
                [plans[a], plans[b]] = [plans[b], plans[a]];
                render();
            };
            view.querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => swap(+b.dataset.up, +b.dataset.up - 1)));
            view.querySelectorAll('[data-down]').forEach((b) => (b.onclick = () => swap(+b.dataset.down, +b.dataset.down + 1)));
            view.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => {
                collect();
                plans.splice(+b.dataset.del, 1);
                render();
            }));
            view.querySelector('#add').onclick = () => {
                collect();
                plans.push({ id: `plan${plans.length + 1}`, title: '', days: 30, price: 199, badge: '', hidden: false });
                render();
            };
            view.querySelector('#save').onclick = async () => {
                collect();
                try {
                    plans = await api('PUT', 'plans', { plans: plans.map((p) => ({ ...p, days: Number(p.days), price: Number(p.price) })) });
                    state.plans = plans;
                    toast('Тарифы сохранены');
                    render();
                } catch (e) {
                    toast(e.message, 'bad');
                }
            };
        };
        render();
    };

    // --- Приложения ---
    VIEWS.apps = async (view) => {
        let groups = await api('GET', 'apps');
        const render = () => {
            view.innerHTML = `
                <div class="page-head"><h1>Приложения</h1><div class="actions"><button class="btn" id="add-platform">Добавить платформу</button><button class="btn btn--primary" id="save">Сохранить</button></div></div>
                <div class="note" style="margin-bottom:14px">Показываются в личном кабинете клиента под ссылкой на подписку. Платформа выбирается автоматически по устройству (коды ios, android, windows; для остальных — первая вкладка).</div>
                ${groups.map((g, gi) => `<div class="platform" data-g="${gi}">
                    <div class="form-row">
                        <label class="field"><span>Название вкладки</span><input type="text" data-gk="title" value="${esc(g.title)}"></label>
                        <label class="field"><span>Код платформы</span><input type="text" data-gk="platform" value="${esc(g.platform)}"></label>
                        <div style="display:flex;align-items:flex-end;gap:8px"><button class="btn btn--sm" data-add-app="${gi}">+ Приложение</button><button class="btn btn--sm btn--danger" data-del-g="${gi}">Удалить платформу</button></div>
                    </div>
                    ${g.apps.map((a, ai) => `<div class="app-edit" data-a="${ai}">
                        <div class="form-row"><label class="field"><span>Приложение</span><input type="text" data-ak="name" value="${esc(a.name)}"></label>
                        <div style="display:flex;align-items:flex-end;gap:8px"><button class="btn btn--sm" data-add-link="${gi}:${ai}">+ Ссылка</button><button class="btn btn--sm btn--danger" data-del-app="${gi}:${ai}">Удалить</button></div></div>
                        ${a.links.map((l, li) => `<div class="link-row" data-l="${li}">
                            <input type="text" data-lk="label" value="${esc(l.label)}" placeholder="Подпись кнопки">
                            <input type="text" data-lk="url" value="${esc(l.url)}" placeholder="https://…">
                            <button class="btn btn--sm" data-del-link="${gi}:${ai}:${li}">✕</button></div>`).join('')}
                    </div>`).join('')}
                </div>`).join('')}`;
            const collect = () => {
                view.querySelectorAll('[data-g]').forEach((ge) => {
                    const g = groups[ge.dataset.g];
                    ge.querySelectorAll(':scope > .form-row [data-gk]').forEach((i) => (g[i.dataset.gk] = i.value));
                    ge.querySelectorAll('[data-a]').forEach((ae) => {
                        const a = g.apps[ae.dataset.a];
                        a.name = ae.querySelector('[data-ak=name]').value;
                        ae.querySelectorAll('[data-l]').forEach((le) => {
                            const l = a.links[le.dataset.l];
                            le.querySelectorAll('[data-lk]').forEach((i) => (l[i.dataset.lk] = i.value));
                        });
                    });
                });
            };
            const on = (sel, fn) => view.querySelectorAll(sel).forEach((b) => (b.onclick = () => {
                collect();
                fn(b);
                render();
            }));
            on('#add-platform', () => groups.push({ platform: '', title: '', apps: [] }));
            on('[data-del-g]', (b) => groups.splice(+b.dataset.delG, 1));
            on('[data-add-app]', (b) => groups[+b.dataset.addApp].apps.push({ name: '', links: [{ label: '', url: 'https://' }] }));
            on('[data-del-app]', (b) => {
                const [g, a] = b.dataset.delApp.split(':').map(Number);
                groups[g].apps.splice(a, 1);
            });
            on('[data-add-link]', (b) => {
                const [g, a] = b.dataset.addLink.split(':').map(Number);
                groups[g].apps[a].links.push({ label: '', url: 'https://' });
            });
            on('[data-del-link]', (b) => {
                const [g, a, l] = b.dataset.delLink.split(':').map(Number);
                groups[g].apps[a].links.splice(l, 1);
            });
            view.querySelector('#save').onclick = async () => {
                collect();
                try {
                    groups = await api('PUT', 'apps', { apps: groups });
                    toast('Приложения сохранены');
                    render();
                } catch (e) {
                    toast(e.message, 'bad');
                }
            };
        };
        render();
    };

    // --- Настройки ---
    VIEWS.settings = async (view) => {
        const s = await api('GET', 'settings');
        const text = (k, label, hint = '', attrs = '') => `<label class="field"><span>${label}</span><input type="text" name="${k}" value="${esc(s[k])}" ${attrs}>${hint ? `<span class="muted small">${hint}</span>` : ''}</label>`;
        const numf = (k, label, min, max, hint = '') => `<label class="field"><span>${label}</span><input type="number" name="${k}" value="${esc(s[k])}" min="${min}" max="${max}">${hint ? `<span class="muted small">${hint}</span>` : ''}</label>`;
        view.innerHTML = `
            <div class="page-head"><h1>Настройки</h1></div>
            <form id="sf">
                <div class="card"><h2>Сервис и поддержка</h2><div class="form">
                    <div class="form-row">${text('brandName', 'Название сервиса')}${text('docsDate', 'Дата редакции документов', 'Показывается в соглашении и политике')}</div>
                    <div class="form-row">${text('supportEmail', 'Email поддержки')}${text('supportTelegram', 'Telegram поддержки', 'Юзернейм без @, не группа')}</div>
                    ${text('verificationPhrase', 'Кодовое слово для Platega', 'Выводится в подвале сайта. После регистрации кассы очистите поле.')}
                    <label class="check"><input type="checkbox" name="telegramEmailNotify" ${s.telegramEmailNotify ? 'checked' : ''}> Оповещения об обращениях в Telegram</label>
                    <span class="muted small">${s.telegramReady
                        ? 'Новые письма клиентов, ответы и смены статуса приходят в тему «Обращения» группы поддержки. В оповещениях есть email и начало письма.'
                        : 'Бот поддержки не запущен или не указана группа (TELEGRAM_BOT_TOKEN, TELEGRAM_SUPPORT_CHAT_ID) — оповещения не отправляются.'}</span>
                    <label class="check"><input type="checkbox" name="telegramAlerts" ${s.telegramAlerts ? 'checked' : ''}> Служебные алерты в Telegram</label>
                    <span class="muted small">${s.telegramReady
                        ? 'В тему «Алерты» группы поддержки: оплаченный заказ не выдан за 10 минут, оплата не принята проверкой, панель или Platega не отвечают. В алертах нет email — только номер пользователя и ссылка.'
                        : 'Бот поддержки не запущен — алерты пишутся только в лог.'}</span>
                </div></div>
                <div class="card"><h2>Подписка</h2><div class="form">
                    <div class="form-row">${numf('paidDeviceLimit', 'Лимит устройств (платная)', 0, 50, '0 — без ограничения. Применяется к новым оплатам и продлениям; больший индивидуальный лимит клиента при продлении сохраняется.')}</div>
                    <label class="check"><input type="checkbox" name="trialEnabled" ${s.trialEnabled ? 'checked' : ''}> Пробный период включён</label>
                    <div class="form-row">${numf('trialDays', 'Дней пробного периода', 1, 30)}${numf('trialDeviceLimit', 'Устройств на пробном периоде', 1, 10)}</div>
                </div></div>
                <div class="actions"><button class="btn btn--primary">Сохранить</button></div>
            </form>`;
        const f = view.querySelector('#sf');
        f.onsubmit = async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(f));
            data.trialEnabled = f.trialEnabled.checked;
            data.telegramEmailNotify = f.telegramEmailNotify.checked;
            data.telegramAlerts = f.telegramAlerts.checked;
            for (const k of ['paidDeviceLimit', 'trialDays', 'trialDeviceLimit']) data[k] = Number(data[k]);
            try {
                await api('PUT', 'settings', data);
                state.me = await api('GET', 'me');
                toast('Настройки сохранены');
            } catch (err) {
                toast(err.message, 'bad');
            }
        };
    };

    // --- Администраторы ---
    function linkModal(title, { url, expiresInHours }) {
        modal({
            title,
            subtitle: `Передайте ссылку сотруднику защищённым каналом. Она одноразовая и действует ${expiresInHours} ч.`,
            body: `<div class="copy-box"><input type="text" readonly value="${esc(url)}"><button type="button" class="btn btn--sm" id="cp">Копировать</button></div>`,
            noSubmit: true,
            onSubmit: async () => {},
        });
        document.getElementById('cp').onclick = () => copy(url);
    }

    VIEWS.admins = async (view) => {
        const list = await api('GET', 'admins');
        view.innerHTML = `
            <div class="page-head"><h1>Администраторы</h1><button class="btn btn--primary" id="invite">Пригласить</button></div>
            <div class="card" style="padding:6px 10px"><div class="table-wrap"><table class="t"><thead><tr><th>Логин</th><th>Роль</th><th>Статус</th><th>Последний вход</th><th></th></tr></thead><tbody>
            ${list.map((a) => `<tr>
                <td><b>${esc(a.login)}</b>${a.id === state.me.admin.id ? ' <span class="muted small">(вы)</span>' : ''}</td>
                <td>${esc(a.roleTitle)}</td>
                <td>${a.disabled ? '<span class="pill pill--bad">Отключён</span>' : '<span class="pill pill--ok">Активен</span>'}${a.has2fa ? '' : ' <span class="pill pill--warn">без 2FA</span>'}</td>
                <td class="nowrap">${fmtDateTime(a.last_login_at)}</td>
                <td class="nowrap" style="text-align:right">
                    <button class="btn btn--sm" data-reset="${a.id}">Сбросить пароль и 2FA</button>
                    ${a.id !== state.me.admin.id ? `<button class="btn btn--sm" data-role="${a.id}" data-to="${a.role === 'admin' ? 'support' : 'admin'}">Сделать ${a.role === 'admin' ? 'поддержкой' : 'админом'}</button>
                    ${a.disabled ? `<button class="btn btn--sm" data-enable="${a.id}">Включить</button>` : `<button class="btn btn--sm btn--danger" data-disable="${a.id}">Отключить</button>`}` : ''}
                </td></tr>`).join('')}
            </tbody></table></div></div>
            <div class="note">Роль «Поддержка»: просмотр пользователей и платежей, ответы на обращения, продление до ${state.me.supportMaxDays} дней на клиента за 30 дней, сброс устройств, перевыпуск и повторная отправка ссылки. Возвраты, статистика, тарифы и настройки — только администраторам.</div>`;
        const reload = () => VIEWS.admins(view);
        view.querySelector('#invite').onclick = () => modal({
            title: 'Пригласить сотрудника',
            body: `<label class="field"><span>Логин</span><input type="text" name="login" required placeholder="ivan"></label>
                <label class="field"><span>Роль</span><select name="role"><option value="support">Поддержка</option><option value="admin">Администратор</option></select></label>`,
            submitText: 'Создать ссылку',
            onSubmit: async (f) => {
                const link = await api('POST', 'admins', { login: f.login.value, role: f.role.value });
                reload();
                setTimeout(() => linkModal(`Ссылка для ${f.login.value}`, link), 0);
            },
        });
        const post = async (path, msg) => {
            try {
                await api('POST', path);
                toast(msg);
                reload();
            } catch (e) {
                toast(e.message, 'bad');
            }
        };
        view.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = () => modal({
            title: 'Сбросить пароль и 2FA',
            subtitle: 'Будет создана одноразовая ссылка: по ней сотрудник задаст новый пароль и заново подключит 2FA. Текущие сессии завершатся после её использования.',
            submitText: 'Создать ссылку',
            onSubmit: async () => {
                const link = await api('POST', `admins/${b.dataset.reset}/reset`);
                setTimeout(() => linkModal('Ссылка для восстановления доступа', link), 0);
            },
        })));
        view.querySelectorAll('[data-role]').forEach((b) => (b.onclick = async () => {
            try {
                await api('POST', `admins/${b.dataset.role}/role`, { role: b.dataset.to });
                toast('Роль изменена');
                reload();
            } catch (e) {
                toast(e.message, 'bad');
            }
        }));
        view.querySelectorAll('[data-disable]').forEach((b) => (b.onclick = () => post(`admins/${b.dataset.disable}/disable`, 'Отключён')));
        view.querySelectorAll('[data-enable]').forEach((b) => (b.onclick = () => post(`admins/${b.dataset.enable}/enable`, 'Включён')));
    };

    // --- Журнал ---
    VIEWS.audit = async (view, r) => {
        const f = { admin: r.query.get('admin') || '', action: r.query.get('action') || '', page: Number(r.query.get('page')) || 1 };
        const [actions, admins] = await Promise.all([api('GET', 'audit/actions'), isAdmin() ? api('GET', 'admins') : Promise.resolve([])]);
        view.innerHTML = `
            <div class="page-head"><h1>Журнал действий</h1></div>
            ${isAdmin() ? '' : '<p class="muted">Показаны только ваши действия.</p>'}
            <form class="toolbar" id="af">
                ${isAdmin() ? `<select name="admin"><option value="">Все сотрудники</option>${admins.map((a) => `<option ${f.admin === a.login ? 'selected' : ''}>${esc(a.login)}</option>`).join('')}</select>` : ''}
                <select name="action"><option value="">Все действия</option>${Object.entries(actions).map(([k, t]) => `<option value="${k}" ${f.action === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
            </form>
            <div class="card" id="list">Загрузка…</div>`;
        const form = view.querySelector('#af');
        form.onchange = () => (location.hash = `#/audit?${qs(Object.fromEntries(new FormData(form)))}`);
        const data = await api('GET', `audit?${qs(f)}`);
        const list = view.querySelector('#list');
        list.innerHTML = data.items.map((h) => {
            const link = h.targetType === 'user' ? `#/users/${h.targetId}` : h.targetType === 'support_thread' ? `#/support/${h.targetId}` : null;
            return historyItem({ ...h, targetLabel: h.targetLabel && link ? null : h.targetLabel }).replace(
                '</b>',
                `</b>${link ? ` · <a href="${link}">${esc(h.targetLabel)}</a>` : ''}`,
            );
        }).join('') || '<p class="muted">Записей нет.</p>';
        pager(list, data, (p) => (location.hash = `#/audit?${qs({ ...f, page: p })}`));
    };

    route();
})();
