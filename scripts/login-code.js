// Код входа в личный кабинет без письма — например, для тестового аккаунта.
//   npm run login-code -- --email test@example.com [--hours 24]   одноразовый код
//   npm run login-code -- --email test@example.com --permanent     постоянный код: не истекает, можно входить много раз
//   npm run login-code -- --email test@example.com --revoke        отозвать постоянный код
//   npm run login-code -- --list                                   постоянные коды
// В Docker: docker compose exec vpn-landing npm run login-code -- --email test@example.com
// После входа сессия живёт 30 дней. Аккаунт создаётся при первом входе.
import { parseArgs } from 'node:util';
import { isValidEmail, issueLoginCode, issueStaticLoginCode, listStaticLoginCodes, normalizeEmail, revokeStaticLoginCode } from '../src/auth.js';

const { values } = parseArgs({
    options: {
        email: { type: 'string' },
        hours: { type: 'string', default: '24' },
        permanent: { type: 'boolean', default: false },
        revoke: { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
    },
});

function fail(message) {
    console.error(`Ошибка: ${message}`);
    process.exit(1);
}

if (values.list) {
    const rows = listStaticLoginCodes();
    if (!rows.length) console.log('Постоянных кодов нет');
    for (const r of rows) console.log(`${r.email}  выдан ${r.created_at}${r.attempts >= 20 ? '  ОТКЛЮЧЁН (много неверных попыток)' : ''}`);
    process.exit(0);
}

const email = normalizeEmail(values.email);
if (!isValidEmail(email)) fail('укажите корректный --email');

if (values.revoke) {
    console.log(revokeStaticLoginCode(email) ? `Постоянный код для ${email} отозван` : `Постоянного кода для ${email} нет`);
} else if (values.permanent) {
    const code = issueStaticLoginCode(email);
    console.log(
        `\nПостоянный код входа для ${email}: ${code}\n` +
            'Не истекает, подходит для входа с любого числа устройств. Новый код заменяет старый.\n' +
            'После 20 неверных попыток код отключается — выпустите новый. Отозвать: --revoke\n',
    );
} else {
    const hours = Number(values.hours);
    if (!(hours > 0 && hours <= 72)) fail('--hours должен быть от 0 до 72');
    const code = issueLoginCode(email, hours * 60 * 60 * 1000);
    console.log(`\nКод входа для ${email}: ${code}\nДействует ${hours} ч, одноразовый. Новый код заменяет старый.\n`);
}
