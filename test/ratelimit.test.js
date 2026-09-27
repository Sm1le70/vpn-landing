import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRateLimits, rateLimit } from '../src/ratelimit.js';

const HOUR = 3_600_000;

test('не больше max за окно; после окна — снова можно', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) assert.equal(rateLimit('a', 3, HOUR, t0 + i), true);
    assert.equal(rateLimit('a', 3, HOUR, t0 + 10), false);
    assert.equal(rateLimit('a', 3, HOUR, t0 + HOUR + 20), true);
});

test('очистка не сбрасывает суточный лимит через час', () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 3; i++) rateLimit('revoke', 3, 24 * HOUR, t0 + i);
    cleanupRateLimits(t0 + 2 * HOUR);
    assert.equal(rateLimit('revoke', 3, 24 * HOUR, t0 + 2 * HOUR), false, 'лимит на сутки действует');
    cleanupRateLimits(t0 + 25 * HOUR);
    assert.equal(rateLimit('revoke', 3, 24 * HOUR, t0 + 25 * HOUR), true);
});
