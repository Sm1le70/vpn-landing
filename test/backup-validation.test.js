import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateBackup } from '../scripts/validate-backup.cjs';
import { db } from '../src/db.js';

test('проверка восстановления: корректная копия, повреждение, .env и чужая схема', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-validation-'));
    try {
        const valid = path.join(dir, 'valid.db');
        db.exec(`VACUUM INTO '${valid.replace(/'/g, "''")}'`);
        const original = fs.readFileSync(valid);
        validateBackup(valid);
        assert.deepEqual(fs.readFileSync(valid), original, 'проверка не изменяет копию');
        const broken = path.join(dir, 'broken.db');
        fs.writeFileSync(broken, original.subarray(0, 200));
        assert.throws(() => validateBackup(broken));
        const env = path.join(dir, '.env');
        fs.writeFileSync(env, 'APP_SECRET=secret');
        assert.throws(() => validateBackup(env));
        const other = path.join(dir, 'other.db');
        const foreign = new DatabaseSync(other);
        foreign.exec('CREATE TABLE unrelated (id INTEGER)');
        foreign.close();
        assert.throws(() => validateBackup(other), /неверная схема/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
