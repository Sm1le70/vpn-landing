// Standalone: no application imports, migrations or environment loading.
const { DatabaseSync } = require('node:sqlite');

function validateBackup(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const checks = db.prepare('PRAGMA integrity_check').all();
        if (checks.length !== 1 || checks[0].integrity_check !== 'ok') {
            throw new Error('integrity_check: копия повреждена');
        }
        // Only original core columns: older backups may need migrations on startup.
        const required = {
            users: ['id', 'email', 'rw_user_id', 'plan_kind'],
            orders: ['id', 'user_id', 'plan_id', 'days', 'amount', 'status', 'platega_tx_id'],
            sessions: ['token_hash', 'user_id', 'expires_at'],
        };
        for (const [table, columns] of Object.entries(required)) {
            const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
            if (columns.some((c) => !actual.has(c))) throw new Error(`неверная схема: ${table}`);
        }
    } finally {
        db.close();
    }
}

module.exports = { validateBackup };
if (require.main === module || process.argv[1] === '-') {
    try {
        validateBackup(process.argv[2]);
    } catch (err) {
        console.error(`Копия не прошла проверку: ${err.message}`);
        process.exitCode = 1;
    }
}
