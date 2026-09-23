// Управление доступом администраторов из консоли (например, если потерян доступ ко всем учёткам).
//   npm run admin:create -- --login ivan --role admin|support
//   npm run admin:reset  -- --login ivan        (новый пароль и 2FA)
//   npm run admin:list
// В Docker: docker compose exec vpn-landing npm run admin:create -- --login ivan --role admin
import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { ROLES, createSetupToken, validateLogin } from '../src/admin/auth.js';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { login: { type: 'string' }, role: { type: 'string' } } });

function fail(message) {
    console.error(`Ошибка: ${message}`);
    process.exit(1);
}

if (!config.admin.path) fail('в .env не задан ADMIN_PATH — админка выключена');

function printLink({ url, expiresInHours }, what) {
    console.log(`\n${what}. Откройте ссылку (действует ${expiresInHours} ч), задайте пароль и подключите 2FA:\n\n  ${url}\n`);
}

switch (command) {
    case 'create': {
        let login;
        try {
            login = validateLogin(values.login);
        } catch (err) {
            fail(err.message);
        }
        const role = values.role ?? 'admin';
        if (!ROLES[role]) fail('--role должен быть admin или support');
        if (db.prepare('SELECT 1 FROM admins WHERE login = ?').get(login)) fail(`администратор ${login} уже существует — используйте admin:reset`);
        printLink(createSetupToken({ kind: 'invite', login, role }), `Приглашение для ${login} (${ROLES[role]})`);
        break;
    }
    case 'reset': {
        const admin = db.prepare('SELECT * FROM admins WHERE login = ?').get(String(values.login ?? '').toLowerCase());
        if (!admin) fail('администратор не найден (npm run admin:list)');
        // Отключённая учётка включится только после того, как по ссылке зададут новые пароль и 2FA
        printLink(createSetupToken({ kind: 'reset', adminId: admin.id, role: admin.role, enableAdmin: true }), `Сброс доступа для ${admin.login}`);
        if (admin.disabled) console.log('  Учётная запись сейчас отключена и будет включена после завершения сброса.\n');
        break;
    }
    case 'list': {
        const rows = db.prepare('SELECT login, role, disabled, last_login_at FROM admins ORDER BY id').all();
        if (!rows.length) console.log('Администраторов нет.');
        for (const a of rows) console.log(`${a.login.padEnd(20)} ${ROLES[a.role].padEnd(15)} ${a.disabled ? 'отключён' : 'активен '}  последний вход: ${a.last_login_at ?? '—'}`);
        break;
    }
    default:
        fail('команда: create | reset | list');
}
