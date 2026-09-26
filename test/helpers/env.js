// Окружение тестов. Импортируется в тестовом файле первым — до любых модулей из src/.
// Глобальный fetch подменяется заглушками (fakes.js): сеть в тестах не используется.
// node --test запускает каждый файл в отдельном процессе, поэтому у каждого файла своя временная база.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOSTS } from './fakes.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-landing-test-'));

Object.assign(process.env, {
    NODE_ENV: 'test',
    SITE_URL: 'http://localhost:3000',
    APP_SECRET: 'test-secret',
    DATABASE_PATH: path.join(dir, 'app.db'),
    BRAND_NAME: 'TestVPN',
    SUPPORT_EMAIL: 'support@test.local',
    REMNAWAVE_URL: HOSTS.remnawave,
    REMNAWAVE_TOKEN: 'test',
    REMNAWAVE_SQUADS: '',
    REMNAWAVE_WEBHOOK_SECRET: 'test',
    PLATEGA_URL: HOSTS.platega,
    PLATEGA_MERCHANT_ID: 'test-merchant',
    PLATEGA_SECRET: 'test-secret',
    RESEND_API_KEY: 'test',
    RESEND_API_URL: HOSTS.resend,
    RESEND_INBOUND_WEBHOOK_SECRET: '',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_SUPPORT_CHAT_ID: '',
    TELEGRAM_API_URL: HOSTS.telegram,
    ADMIN_PATH: '/admin-test',
    DEMO_ADMIN_NO_2FA: '',
});

process.on('exit', () => {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // Windows не даёт удалить открытый файл базы — останется во временном каталоге
    }
});
