// Код входа в личный кабинет без письма — например, для тестового аккаунта.
//   npm run login-code -- --email test@example.com [--hours 24]
// В Docker: docker compose exec vpn-landing npm run login-code -- --email test@example.com
// Код одноразовый; после входа сессия живёт 30 дней. Аккаунт создаётся при первом входе.
import { parseArgs } from 'node:util';
import { isValidEmail, issueLoginCode, normalizeEmail } from '../src/auth.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, hours: { type: 'string', default: '24' } } });

function fail(message) {
    console.error(`Ошибка: ${message}`);
    process.exit(1);
}

const email = normalizeEmail(values.email);
if (!isValidEmail(email)) fail('укажите корректный --email');
const hours = Number(values.hours);
if (!(hours > 0 && hours <= 72)) fail('--hours должен быть от 0 до 72');

const code = issueLoginCode(email, hours * 60 * 60 * 1000);
console.log(`\nКод входа для ${email}: ${code}\nДействует ${hours} ч, одноразовый. Новый код заменяет старый.\n`);
