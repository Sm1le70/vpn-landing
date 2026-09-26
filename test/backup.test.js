import './helpers/env.js';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT_DIR } from '../src/config.js';

// Функции шифрования scripts/backup.sh с заглушкой age. На Windows `bash` может оказаться WSL — проверка идёт в CI (Linux).
// RUN_BASH_TESTS=1 — запустить и на Windows (из Git Bash)
const skip = process.platform === 'win32' && !process.env.RUN_BASH_TESTS ? 'bash-скрипт проверяется в CI на Linux' : false;
const SCRIPT = path.join(ROOT_DIR, 'scripts', 'backup.sh');
let dir;
let bin;

before(() => {
    if (skip) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
    bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // Заглушка age: «шифрует», приписывая публичный ключ; расшифровывает только ключом, совпадающим с ним
    fs.writeFileSync(path.join(bin, 'age'), `#!/usr/bin/env bash
if [ "$1" = "-d" ]; then
  id="$3"; out="$5"; in="$6"
  [ "$(head -n 1 "$in")" = "AGE $(cat "$id")" ] || { echo "no identity matched" >&2; exit 1; }
  tail -n +2 "$in" > "$out"
else
  { echo "AGE $2"; cat "$5"; } > "$4"
fi
`, { mode: 0o755 });
});

// Выполняет команды в каталоге dir с подключённым backup.sh
function run(commands, env = {}) {
    const r = spawnSync('bash', ['-c', `source "${SCRIPT}"; ${commands}`], {
        cwd: dir,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BACKUP_AGE_RECIPIENT: '', ...env },
        encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

test('публичный ключ: из окружения или из .env (кавычки и CRLF убираются)', { skip }, () => {
    fs.writeFileSync(path.join(dir, '.env'), 'APP_SECRET=x\r\nBACKUP_AGE_RECIPIENT="age1fromenvfile"\r\n');
    assert.equal(run('age_recipient').out, 'age1fromenvfile');
    assert.equal(run('age_recipient', { BACKUP_AGE_RECIPIENT: 'age1fromvar' }).out, 'age1fromvar');
    fs.rmSync(path.join(dir, '.env'));
    assert.equal(run('age_recipient').out, '');
});

test('encrypt_file: остаётся только .age, расшифровывается своим ключом', { skip }, () => {
    fs.writeFileSync(path.join(dir, 'app.db'), 'SQLite data');
    fs.writeFileSync(path.join(dir, 'key.txt'), 'age1pub');
    assert.equal(run('encrypt_file age1pub app.db').code, 0);
    assert.equal(fs.existsSync(path.join(dir, 'app.db')), false, 'открытый файл удалён');
    assert.ok(fs.existsSync(path.join(dir, 'app.db.age')));

    const r = run('decrypt_file app.db.age restored.db', { BACKUP_AGE_IDENTITY: path.join(dir, 'key.txt') });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(path.join(dir, 'restored.db'), 'utf8'), 'SQLite data');
});

test('decrypt_file: без ключа или с чужим ключом — понятная ошибка', { skip }, () => {
    fs.writeFileSync(path.join(dir, 'b.db'), 'x');
    run('encrypt_file age1pub b.db');
    assert.match(run('decrypt_file b.db.age out.db').err, /укажите приватный ключ/);
    fs.writeFileSync(path.join(dir, 'other.txt'), 'age1other');
    const r = run('decrypt_file b.db.age out.db', { BACKUP_AGE_IDENTITY: path.join(dir, 'other.txt') });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /тот ли ключ/);
    assert.equal(fs.existsSync(path.join(dir, 'out.db')), false, 'частичный файл удалён');
});
