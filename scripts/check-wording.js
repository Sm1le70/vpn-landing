// Проверяет тексты сайта и писем на формулировки, которые банк может счесть намёком
// на обход блокировок (требование Platega). Запуск: npm run check-wording
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_WORDING as forbidden } from '../src/wording.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['views', 'public', 'src', 'config', 'admin-ui'];


const hits = [];
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(html|js|json|css|md)$/.test(entry.name) && !p.endsWith('check-wording.js') && !p.endsWith('wording.js')) {
            fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
                for (const re of forbidden) if (re.test(line)) hits.push(`${path.relative(root, p)}:${i + 1}  [${re.source}]  ${line.trim().slice(0, 140)}`);
            });
        }
    }
}
for (const t of targets) walk(path.join(root, t));

if (hits.length) {
    console.log(`Найдено подозрительных формулировок: ${hits.length}\n${hits.join('\n')}`);
    process.exit(1);
}
console.log('OK: подозрительных формулировок не найдено');
