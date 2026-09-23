(() => {
    const $ = (id) => document.getElementById(id);
    const params = new URLSearchParams(location.search);
    const state = { config: null, me: null, selectedPlan: params.get('plan'), email: '', platform: null };

    const rub = (n) => `${Number(n).toLocaleString('ru-RU')} ₽`;
    const fmtDate = (s) => new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const plural = (n, [one, few, many]) => {
        const m10 = n % 10, m100 = n % 100;
        if (m10 === 1 && m100 !== 11) return one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
        return many;
    };

    async function api(method, url, body) {
        const res = await fetch(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
            credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || 'Ошибка запроса');
            err.status = res.status;
            throw err;
        }
        return data;
    }

    function show(view) {
        for (const v of ['view-login', 'view-dashboard', 'view-loading']) $(v).hidden = v !== view;
    }

    function banner(type, html) {
        const el = $('banner');
        if (!html) {
            el.hidden = true;
            return;
        }
        el.className = `banner banner--${type}`;
        el.innerHTML = html;
        el.hidden = false;
    }

    function setError(id, msg) {
        $(id).textContent = msg || '';
        $(id).hidden = !msg;
    }

    function busy(btn, on, text) {
        if (on) {
            btn.dataset.text = btn.textContent;
            btn.textContent = text || 'Подождите…';
        } else if (btn.dataset.text) {
            btn.textContent = btn.dataset.text;
        }
        btn.disabled = on;
    }

    // ---------- Вход ----------

    $('form-email').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.submitter;
        state.email = e.target.email.value.trim();
        setError('login-error');
        busy(btn, true, 'Отправляем…');
        try {
            await api('POST', '/api/auth/request-code', { email: state.email });
            showCodeForm(true);
        } catch (err) {
            setError('login-error', err.message);
        } finally {
            busy(btn, false);
        }
    });

    function showCodeForm(sent) {
        $('code-email').textContent = state.email;
        $('code-email-own').textContent = state.email;
        $('code-sent').hidden = !sent;
        $('code-own').hidden = sent;
        $('form-email').hidden = true;
        $('form-code').hidden = false;
        $('form-code').code.focus();
    }

    // Код уже есть (например, выдан командой login-code) — письмо не запрашиваем
    $('btn-have-code').addEventListener('click', () => {
        const form = $('form-email');
        if (!form.reportValidity()) return;
        state.email = form.email.value.trim();
        setError('login-error');
        showCodeForm(false);
    });

    $('form-code').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.submitter;
        setError('login-error');
        busy(btn, true, 'Проверяем…');
        try {
            await api('POST', '/api/auth/verify', { email: state.email, code: e.target.code.value.trim() });
            await load();
        } catch (err) {
            setError('login-error', err.message);
        } finally {
            busy(btn, false);
        }
    });

    $('btn-change-email').addEventListener('click', () => {
        $('form-code').hidden = true;
        $('form-email').hidden = false;
        setError('login-error');
    });

    // Поддержка в Telegram: ссылка с одноразовым токеном привязывает Telegram к аккаунту
    $('btn-tg-support').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        // Окно открываем сразу, иначе после запроса браузер не даст открыть всплывающее окно
        const win = window.open('', '_blank');
        if (win) win.opener = null;
        setError('tg-error');
        busy(btn, true, 'Открываем…');
        try {
            const { url } = await api('POST', '/api/me/telegram-link');
            if (win) win.location.href = url;
            else location.href = url;
        } catch (err) {
            if (win) win.close();
            setError('tg-error', err.message);
        } finally {
            busy(btn, false);
        }
    });

    $('btn-logout').addEventListener('click', async () => {
        await api('POST', '/api/auth/logout').catch(() => {});
        location.href = '/';
    });

    // ---------- Кабинет ----------

    const STATUS = {
        ACTIVE: ['Активна', 'ok'],
        EXPIRED: ['Срок истёк', 'warn'],
        DISABLED: ['Отключена', 'bad'],
        LIMITED: ['Лимит исчерпан', 'warn'],
    };
    const ORDER_STATUS = {
        pending: 'Ожидает оплаты',
        paid: 'Оплачен, выдаём доступ',
        applied: 'Оплачен',
        canceled: 'Не оплачен',
        chargeback: 'Возврат',
        refunded: 'Возврат',
        refund_pending: 'Возврат в обработке',
    };

    function renderSubscription() {
        const { subscription: s, subscriptionError } = state.me;
        const card = $('sub-card');
        if (subscriptionError) {
            card.innerHTML = '<h2>Подписка</h2><p class="muted">Не удалось получить данные о подписке. Обновите страницу через минуту.</p>';
            return;
        }
        if (!s) {
            card.innerHTML = '<h2>Подписка</h2><p class="muted">У вас пока нет активной подписки. Выберите тариф ниже — доступ появится сразу после оплаты.</p>';
            return;
        }
        const expired = new Date(s.expireAt) < new Date();
        const [label, tone] = STATUS[s.status] || [s.status, 'warn'];
        const daysLeft = Math.max(0, Math.ceil((new Date(s.expireAt) - Date.now()) / 86400000));
        const devices = s.deviceLimit ? `${s.devices ?? '—'} из ${s.deviceLimit}` : `${s.devices ?? '—'}`;
        const blocked = s.trialBlocked && s.status === 'DISABLED'
            ? '<div class="note note--bad">Пробный период уже использовался на этом устройстве, поэтому он был отключён. Оформите подписку, чтобы продолжить пользоваться сервисом.</div>'
            : '';
        card.innerHTML = `
            <div class="sub-head">
                <h2>${s.isTrial ? 'Пробный период' : 'Подписка'}</h2>
                <span class="pill pill--${tone}">${esc(label)}</span>
            </div>
            ${blocked}
            <div class="sub-stats">
                <div><small>${expired ? 'Закончилась' : 'Действует до'}</small><b>${fmtDate(s.expireAt)}</b></div>
                <div><small>Осталось</small><b>${daysLeft} ${plural(daysLeft, ['день', 'дня', 'дней'])}</b></div>
                <div><small>Устройства</small><b>${devices}</b></div>
            </div>
            <div class="sub-link">
                <div class="sub-link-main">
                    <label class="field"><span>Ссылка на подписку</span>
                        <div class="copy-row">
                            <input type="text" readonly value="${esc(s.subscriptionUrl)}" id="sub-url">
                            <button class="btn btn--ghost btn--small" type="button" id="btn-copy">Копировать</button>
                        </div>
                    </label>
                    <ol class="howto">
                        <li>Установите одно из приложений ниже.</li>
                        <li>Скопируйте ссылку и добавьте её в приложение (обычно «+» → «Импорт из буфера») или отсканируйте QR-код.</li>
                        <li>Подключитесь. Подробная инструкция — <a href="${esc(s.subscriptionUrl)}" target="_blank" rel="noopener">на странице подписки</a>.</li>
                    </ol>
                </div>
                <img class="qr" src="/api/me/qr.svg?t=${Date.now()}" alt="QR-код ссылки на подписку" width="168" height="168">
            </div>
            ${renderApps()}`;
        bindAppTabs();
        $('btn-copy').addEventListener('click', async () => {
            const input = $('sub-url');
            try {
                await navigator.clipboard.writeText(input.value);
            } catch {
                input.select();
                document.execCommand('copy');
            }
            $('btn-copy').textContent = 'Скопировано';
            setTimeout(() => ($('btn-copy').textContent = 'Копировать'), 1500);
        });
    }

    function detectPlatform() {
        const ua = navigator.userAgent;
        if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
        if (/Android/i.test(ua)) return 'android';
        return 'windows';
    }

    function renderApps() {
        const groups = state.config.apps || [];
        if (!groups.length) return '';
        const current = groups.some((g) => g.platform === state.platform) ? state.platform : groups[0].platform;
        state.platform = current;
        const tabs = groups
            .map((g) => `<button type="button" class="apps-tab${g.platform === current ? ' apps-tab--active' : ''}" data-platform="${esc(g.platform)}">${esc(g.title)}</button>`)
            .join('');
        const panels = groups
            .map(
                (g) => `<div class="apps-panel" data-platform="${esc(g.platform)}"${g.platform === current ? '' : ' hidden'}>
                    ${g.apps
                        .map(
                            (a) => `<div class="app-row"><b>${esc(a.name)}</b><span class="app-links">${a.links
                                .map((l) => `<a class="btn btn--ghost btn--small" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`)
                                .join('')}</span></div>`,
                        )
                        .join('')}
                </div>`,
            )
            .join('');
        return `<div class="apps"><h3>Приложения для подключения</h3><div class="apps-tabs" role="tablist">${tabs}</div>${panels}</div>`;
    }

    function bindAppTabs() {
        for (const btn of document.querySelectorAll('.apps-tab')) {
            btn.addEventListener('click', () => {
                state.platform = btn.dataset.platform;
                for (const b of document.querySelectorAll('.apps-tab')) b.classList.toggle('apps-tab--active', b === btn);
                for (const p of document.querySelectorAll('.apps-panel')) p.hidden = p.dataset.platform !== state.platform;
            });
        }
    }

    function renderTrial() {
        const { trial } = state.config;
        const show = state.me.trialAvailable && trial.enabled;
        $('trial-card').hidden = !show;
        if (!show) return;
        $('trial-text').textContent =
            `${trial.days} ${plural(trial.days, ['день', 'дня', 'дней'])} бесплатно, ${trial.deviceLimit} ${plural(trial.deviceLimit, ['устройство', 'устройства', 'устройств'])}. ` +
            'Предоставляется один раз на аккаунт и устройство.';
        if (params.get('trial') === '1') $('trial-card').classList.add('card--highlight');
    }

    function renderPlans() {
        const { plans } = state.config;
        if (!plans.some((p) => p.id === state.selectedPlan)) {
            state.selectedPlan = (plans.find((p) => p.badge) || plans[0]).id;
        }
        $('buy-title').textContent = state.me.subscription ? 'Продлить подписку' : 'Оформить подписку';
        $('plan-picker').innerHTML = plans
            .map((p) => {
                const sub = p.days >= 60
                    ? `${rub(Math.round(p.price / Math.round(p.days / 30)))} / мес`
                    : `${p.days} ${plural(p.days, ['день', 'дня', 'дней'])}`;
                return `<label class="pp${p.id === state.selectedPlan ? ' pp--active' : ''}">
                    <input type="radio" name="plan" value="${esc(p.id)}" ${p.id === state.selectedPlan ? 'checked' : ''}>
                    <span class="pp-title">${esc(p.title)}${p.badge ? ` <em>${esc(p.badge)}</em>` : ''}</span>
                    <span class="pp-price">${rub(p.price)}</span>
                    <span class="pp-sub">${sub}</span>
                </label>`;
            })
            .join('');
        updatePayButton();
    }

    function updatePayButton() {
        const plan = state.config.plans.find((p) => p.id === state.selectedPlan);
        $('btn-pay').textContent = `Оплатить ${rub(plan.price)}`;
    }

    $('plan-picker').addEventListener('change', (e) => {
        if (e.target.name !== 'plan') return;
        state.selectedPlan = e.target.value;
        for (const el of document.querySelectorAll('.pp')) el.classList.toggle('pp--active', el.querySelector('input').checked);
        updatePayButton();
    });

    function renderOrders() {
        const orders = state.me.orders.filter((o) => o.status !== 'canceled' || o.paid_at);
        $('orders-card').hidden = orders.length === 0;
        $('orders-body').innerHTML = orders
            .map(
                (o) => `<tr><td>${new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('ru-RU')}</td><td>${esc(o.planTitle)}</td>` +
                    `<td>${rub(o.amount)}</td><td>${esc(ORDER_STATUS[o.status] || o.status)}</td></tr>`,
            )
            .join('');
    }

    $('form-buy').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('btn-pay');
        setError('buy-error');
        busy(btn, true, 'Создаём платёж…');
        try {
            const { paymentUrl } = await api('POST', '/api/orders', { planId: state.selectedPlan, agree: e.target.agree.checked });
            location.href = paymentUrl;
        } catch (err) {
            setError('buy-error', err.message);
            busy(btn, false);
        }
    });

    $('btn-trial').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        busy(btn, true, 'Активируем…');
        try {
            await api('POST', '/api/trial');
            banner('ok', 'Пробный период активирован. Ссылка для подключения — ниже, копия отправлена на почту.');
            await load();
        } catch (err) {
            banner('bad', esc(err.message));
            busy(btn, false);
        }
    });

    // ---------- Возврат с платёжной страницы ----------

    async function watchOrder(orderId) {
        if (params.get('failed') === '1') {
            banner('bad', 'Оплата не прошла. Попробуйте ещё раз или выберите другой способ оплаты.');
        } else {
            banner('info', 'Проверяем оплату… Обычно это занимает несколько секунд.');
        }
        const started = Date.now();
        while (Date.now() - started < 3 * 60 * 1000) {
            let order;
            try {
                order = await api('GET', `/api/orders/${encodeURIComponent(orderId)}`);
            } catch {
                break;
            }
            if (order.status === 'applied') {
                banner('ok', `Оплата получена — подписка «${esc(order.planTitle)}» активна. Ссылка для подключения — ниже.`);
                history.replaceState(null, '', '/cabinet');
                await load();
                return;
            }
            if (order.status === 'paid') banner('info', 'Оплата получена, выдаём доступ…');
            if (order.status === 'canceled') {
                banner('bad', 'Платёж не завершён. Вы можете попробовать оплатить снова.');
                return;
            }
            await new Promise((r) => setTimeout(r, 3000));
        }
        banner('info', 'Платёж ещё обрабатывается. Как только он будет подтверждён, подписка появится здесь, а ссылка придёт на почту.');
    }

    // ---------- Загрузка ----------

    async function load() {
        try {
            state.me = await api('GET', '/api/me');
        } catch (err) {
            if (err.status === 401) {
                show('view-login');
                return;
            }
            $('view-loading').textContent = 'Не удалось загрузить данные. Обновите страницу.';
            return;
        }
        $('user-email').textContent = state.me.email;
        $('tg-support').hidden = !state.me.telegramSupport;
        renderSubscription();
        renderTrial();
        renderPlans();
        renderOrders();
        show('view-dashboard');
        if (params.get('plan')) $('buy-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    (async () => {
        try {
            state.config = await api('GET', '/api/config');
            state.platform = detectPlatform();
        } catch {
            $('view-loading').textContent = 'Сервис временно недоступен. Попробуйте позже.';
            return;
        }
        await load();
        const orderId = params.get('order');
        if (orderId && state.me) watchOrder(orderId);
    })();
})();
