// Одноразовые почтовые адреса: на них не выдаётся пробный период.
// Список доменов — config/disposable-domains.txt (строки с # — комментарии). Поддомены тоже считаются одноразовыми.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.js';

let domains = null;

function load() {
    try {
        const text = fs.readFileSync(path.join(ROOT_DIR, 'config', 'disposable-domains.txt'), 'utf8');
        return new Set(text.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
    } catch (err) {
        console.error('[trial] список одноразовых доменов не загружен:', err.message);
        return new Set();
    }
}

export function isDisposableEmail(email) {
    domains ??= load();
    const parts = String(email ?? '').toLowerCase().split('@').pop().split('.');
    // a.b.mailinator.com → a.b.mailinator.com, b.mailinator.com, mailinator.com
    for (let i = 0; i < parts.length - 1; i++) if (domains.has(parts.slice(i).join('.'))) return true;
    return false;
}
