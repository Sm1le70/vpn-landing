// Простой лимит запросов в памяти: не больше max за скользящее окно windowMs на ключ.
// Окно хранится вместе с ключом: очистка не укорачивает длинные (суточные) лимиты.
const hits = new Map();

export function rateLimit(key, max, windowMs, now = Date.now()) {
    const times = (hits.get(key)?.times ?? []).filter((t) => now - t < windowMs);
    times.push(now);
    hits.set(key, { windowMs, times });
    return times.length <= max;
}

// Удаляет ключи, у которых все отметки вышли за их окно
export function cleanupRateLimits(now = Date.now()) {
    for (const [key, { windowMs, times }] of hits) if (times.every((t) => now - t >= windowMs)) hits.delete(key);
}
