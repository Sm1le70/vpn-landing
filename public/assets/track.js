// Счётчик кликов на сайте: название элемента из атрибута data-track уходит на свой сервер (/api/t).
// Сторонних сервисов нет; посетителя сервер узнаёт по своей cookie. Ошибки счётчика не мешают странице.
(() => {
    const send = (name) => {
        try {
            const body = JSON.stringify({ e: 'click', n: name });
            if (!navigator.sendBeacon?.('/api/t', body)) {
                fetch('/api/t', { method: 'POST', body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
            }
        } catch {
            // счётчик не важнее страницы
        }
    };

    // Ссылки и кнопки. Вопросы FAQ (details) считаются при раскрытии, а не при любом клике по ним.
    document.addEventListener('click', (e) => {
        const el = e.target.closest?.('[data-track]');
        if (el && el.tagName !== 'DETAILS') send(el.dataset.track);
    }, { capture: true });
    document.querySelectorAll('details[data-track]').forEach((d) => d.addEventListener('toggle', () => d.open && send(d.dataset.track)));

    // Посетитель долистал до тарифов: верх блока поднялся выше нижней трети экрана
    const pricing = document.getElementById('pricing');
    if (pricing && 'IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
            if (entries.some((x) => x.isIntersecting)) {
                send('pricing_seen');
                io.disconnect();
            }
        }, { rootMargin: '0px 0px -30% 0px' });
        io.observe(pricing);
    }
})();
