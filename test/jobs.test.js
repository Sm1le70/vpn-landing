import './helpers/env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { every, jobsStatus, resetJobs, staleJobs } from '../src/jobs.js';

beforeEach(resetJobs);

const MIN = 60_000;
const status = (name) => jobsStatus().find((j) => j.name === name);

test('проход не запускается, пока идёт предыдущий', async () => {
    let calls = 0;
    let release;
    // Первый проход «висит», пока не отпустим; следующие завершаются сразу
    const run = every('slow', MIN, () => {
        calls += 1;
        return calls === 1 ? new Promise((r) => (release = r)) : undefined;
    });
    const first = run();
    await run();
    await run();
    assert.equal(calls, 1);
    assert.equal(status('slow').skipped, 2);
    release();
    await first;
    await run();
    assert.equal(calls, 2, 'после завершения — снова запускается');
});

test('ошибка записывается, следующий проход идёт как обычно', async () => {
    let fail = true;
    const run = every('flaky', MIN, async () => {
        if (fail) throw new Error('Platega → 503');
    });
    await run();
    assert.equal(status('flaky').lastError, 'Platega → 503');
    assert.equal(status('flaky').lastOkAt, null);
    fail = false;
    await run();
    assert.equal(status('flaky').lastError, null);
    assert.ok(status('flaky').lastOkAt);
});

test('зависшая задача: давно не завершалась или проход идёт слишком долго', async () => {
    const now = Date.now();
    const run = every('orders', MIN, async () => {});
    assert.deepEqual(staleJobs(now), []);
    // Три интервала и минута запаса без завершения — зависла
    assert.deepEqual(staleJobs(now + 4 * MIN + 1000), ['orders']);
    await run();
    assert.deepEqual(staleJobs(Date.now() + 2 * MIN), [], 'после прохода — снова в порядке');

    let release;
    const hang = every('hang', MIN, () => new Promise((r) => (release = r)));
    const pending = hang();
    assert.deepEqual(staleJobs(Date.now() + 5 * MIN), ['orders', 'hang']);
    release();
    await pending;
});
