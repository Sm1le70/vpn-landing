import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (name, fallback = '') => (process.env[name] ?? fallback).trim();
const bool = (name, fallback) => {
    const v = env(name, String(fallback)).toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
};
const int = (name, fallback) => {
    const n = Number.parseInt(env(name, String(fallback)), 10);
    return Number.isFinite(n) ? n : fallback;
};

const siteUrl = env('SITE_URL', 'http://localhost:3000').replace(/\/+$/, '');

export const config = {
    port: int('PORT', 3000),
    siteUrl,
    isHttps: siteUrl.startsWith('https://'),
    brandName: env('BRAND_NAME', 'MyVPN'),
    supportEmail: env('SUPPORT_EMAIL', 'support@example.com'),
    supportTelegram: env('SUPPORT_TELEGRAM').replace(/^@/, ''),
    docsDate: env('DOCS_DATE', '22.09.2026'),
    verificationPhrase: env('VERIFICATION_PHRASE'),
    appSecret: env('APP_SECRET', 'dev-secret'),
    databasePath: path.resolve(ROOT_DIR, env('DATABASE_PATH', './data/app.db')),

    paidDeviceLimit: int('PAID_DEVICE_LIMIT', 3),
    trial: {
        enabled: bool('TRIAL_ENABLED', true),
        days: int('TRIAL_DAYS', 3),
        deviceLimit: int('TRIAL_DEVICE_LIMIT', 1),
    },

    remnawave: {
        url: env('REMNAWAVE_URL').replace(/\/+$/, ''),
        token: env('REMNAWAVE_TOKEN'),
        squads: env('REMNAWAVE_SQUADS').split(',').map((s) => s.trim()).filter(Boolean),
        userTag: env('REMNAWAVE_USER_TAG') || null,
        cookie: env('REMNAWAVE_COOKIE'),
        webhookSecret: env('REMNAWAVE_WEBHOOK_SECRET'),
    },

    platega: {
        url: env('PLATEGA_URL', 'https://app.platega.io').replace(/\/+$/, ''),
        merchantId: env('PLATEGA_MERCHANT_ID'),
        secret: env('PLATEGA_SECRET'),
    },

    mail: {
        resendApiKey: env('RESEND_API_KEY'),
        from: env('MAIL_FROM', 'MyVPN <no-reply@example.com>'),
    },
};

if (config.appSecret === 'dev-secret' || config.appSecret.startsWith('change-me')) {
    console.warn('[config] APP_SECRET не задан — используйте длинную случайную строку в продакшене');
}

// Админка: секретный путь. Пусто — админка выключена.
const adminPath = env('ADMIN_PATH').replace(/\/+$/, '');
if (adminPath && !/^\/[A-Za-z0-9_-]{6,64}$/.test(adminPath)) {
    throw new Error('ADMIN_PATH: путь вида /panel-x7k2 (латиница, цифры, _ и -, от 6 символов)');
}
config.admin = {
    path: adminPath,
    // Только для npm run demo: вход без 2FA
    demoNo2fa: env('DEMO_ADMIN_NO_2FA') === 'true',
};
