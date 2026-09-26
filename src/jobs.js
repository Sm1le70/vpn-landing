// Периодические фоновые задачи. Проход не запускается, пока не закончился предыдущий
// (медленный ответ Platega или панели не приводит к наложению проходов), время проходов
// запоминается — по нему /healthz видит зависшую задачу.
const jobs = new Map();

// Задача считается зависшей, если не завершалась дольше STALE_INTERVALS своих интервалов (+ запас)
const STALE_INTERVALS = 3;
const STALE_MARGIN_MS = 60_000;

// Регистрирует задачу: fn раз в intervalMs, первый раз — через firstDelayMs (по умолчанию — через интервал).
// Возвращает функцию одного прохода (для тестов и ручного запуска).
export function every(name, intervalMs, fn, { firstDelayMs = null } = {}) {
    const job = { name, intervalMs, registeredAt: Date.now(), running: false, runStartedAt: null, lastFinishAt: null, lastOkAt: null, lastError: null, skipped: 0 };
    jobs.set(name, job);
    const run = async () => {
        if (job.running) {
            job.skipped += 1;
            return;
        }
        job.running = true;
        job.runStartedAt = Date.now();
        try {
            await fn();
            job.lastOkAt = Date.now();
            job.lastError = null;
        } catch (err) {
            job.lastError = String(err?.message ?? err);
            console.error(`[jobs] ${name}:`, err);
        } finally {
            job.running = false;
            job.lastFinishAt = Date.now();
        }
    };
    setInterval(run, intervalMs).unref();
    if (firstDelayMs != null) setTimeout(run, firstDelayMs).unref();
    return run;
}

// Зависшие задачи: проход идёт слишком долго или давно не завершался (с момента регистрации — тоже)
export function staleJobs(now = Date.now()) {
    const stale = [];
    for (const j of jobs.values()) {
        const limit = STALE_INTERVALS * j.intervalMs + STALE_MARGIN_MS;
        const since = j.running ? j.runStartedAt : (j.lastFinishAt ?? j.registeredAt);
        if (now - since > limit) stale.push(j.name);
    }
    return stale;
}

export const jobsStatus = () =>
    [...jobs.values()].map(({ name, intervalMs, running, lastOkAt, lastFinishAt, lastError, skipped }) => ({ name, intervalMs, running, lastOkAt, lastFinishAt, lastError, skipped }));

// Для тестов
export const resetJobs = () => jobs.clear();
