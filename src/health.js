// Доступность внешних сервисов (Remnawave, Platega) по результатам запросов к ним.
// Сбой — сетевая ошибка, таймаут или ответ 5xx; ответ 4xx означает, что сервис работает.
// Алерт — после FAIL_THRESHOLD сбоев подряд, если первый был не раньше MIN_OUTAGE_MS назад; после восстановления — ещё один.
import { alert } from './alerts.js';

const FAIL_THRESHOLD = 5;
const MIN_OUTAGE_MS = 60_000;
const TITLES = { remnawave: 'Панель Remnawave', platega: 'Platega' };

const state = new Map();

export function reportResult(service, ok, error = null, now = Date.now()) {
    const s = state.get(service) ?? { failures: 0, firstFailureAt: 0, alerted: false, lastError: null };
    state.set(service, s);
    const title = TITLES[service] ?? service;
    if (ok) {
        if (s.alerted) {
            const minutes = Math.max(1, Math.round((now - s.firstFailureAt) / 60_000));
            alert({ title: `${title}: снова отвечает`, lines: [`Сбой длился около ${minutes} мин.`] });
        }
        Object.assign(s, { failures: 0, firstFailureAt: 0, alerted: false, lastError: null });
        return;
    }
    if (!s.failures) s.firstFailureAt = now;
    s.failures += 1;
    s.lastError = String(error ?? '').slice(0, 300);
    if (!s.alerted && s.failures >= FAIL_THRESHOLD && now - s.firstFailureAt >= MIN_OUTAGE_MS) {
        s.alerted = true;
        alert({
            title: `${title} не отвечает`,
            lines: [`Сбоев подряд: ${s.failures}`, `Последняя ошибка: ${s.lastError}`],
        });
    }
}

// Для тестов
export const resetHealth = () => state.clear();
