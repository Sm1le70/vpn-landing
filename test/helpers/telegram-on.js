// Включает бота поддержки в тестах. Импортировать сразу после env.js, до модулей из src/.
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_SUPPORT_CHAT_ID: '-1001' });
