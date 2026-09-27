import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// config.js проверяет окружение при загрузке — запускаем его в отдельном процессе
function loadConfig(env) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config.js'); console.log('ok')"], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
    return { ok: r.status === 0 && r.stdout.includes('ok'), stderr: r.stderr };
}

test('демо-вход без 2FA: запрещён при https SITE_URL', () => {
    const r = loadConfig({ DEMO_ADMIN_NO_2FA: 'true', SITE_URL: 'https://example.com' });
    assert.equal(r.ok, false);
    assert.match(r.stderr, /DEMO_ADMIN_NO_2FA/);
});

test('демо-вход без 2FA: запрещён при NODE_ENV=production', () => {
    const r = loadConfig({ DEMO_ADMIN_NO_2FA: 'true', SITE_URL: 'http://localhost:3000', NODE_ENV: 'production' });
    assert.equal(r.ok, false);
    assert.match(r.stderr, /DEMO_ADMIN_NO_2FA/);
});

test('демо-вход без 2FA: разрешён локально (как в npm run demo)', () => {
    assert.equal(loadConfig({ DEMO_ADMIN_NO_2FA: 'true', SITE_URL: 'http://localhost:3000', NODE_ENV: 'development' }).ok, true);
});

test('без демо-флага https и production работают', () => {
    assert.equal(loadConfig({ DEMO_ADMIN_NO_2FA: '', SITE_URL: 'https://example.com', NODE_ENV: 'production' }).ok, true);
});

test('APP_SECRET: значение по умолчанию или пустое — запуск на рабочем сайте запрещён', () => {
    for (const APP_SECRET of ['', 'dev-secret', 'change-me-to-a-long-random-string']) {
        for (const env of [{ SITE_URL: 'https://example.com' }, { SITE_URL: 'http://localhost:3000', NODE_ENV: 'production' }]) {
            const r = loadConfig({ ...env, APP_SECRET });
            assert.equal(r.ok, false, `APP_SECRET="${APP_SECRET}" ${JSON.stringify(env)}`);
            assert.match(r.stderr, /APP_SECRET не задан/);
        }
    }
});

test('APP_SECRET: локально без секрета — только предупреждение', () => {
    const r = loadConfig({ APP_SECRET: '', SITE_URL: 'http://localhost:3000', NODE_ENV: 'development' });
    assert.equal(r.ok, true);
    assert.match(r.stderr, /APP_SECRET не задан/);
});
