#!/usr/bin/env bash
# Резервная копия базы и .env (Docker-установка).
#
#   sudo scripts/backup.sh                    — сделать копию в backups/ (хранятся последние BACKUP_KEEP, по умолчанию 14)
#   sudo scripts/backup.sh restore <файл.db>  — восстановить базу из копии
#
# Копия базы снимается внутри работающего контейнера через VACUUM INTO: это согласованный снимок
# даже во время записи, простой не нужен. После снятия копия проверяется (PRAGMA integrity_check).
# Запускать от root (sudo): файлы в data/ принадлежат пользователю контейнера (uid 1000).
set -euo pipefail

cd "$(dirname "$0")/.."
KEEP="${BACKUP_KEEP:-14}"
SERVICE=vpn-landing
DATA_UID=1000

log() { echo "[$(date '+%F %T')] $*"; }
fail() { echo "[$(date '+%F %T')] ОШИБКА: $*" >&2; exit 1; }

[ -w data ] || fail "нет прав на запись в data/ — запустите через sudo"
docker compose version >/dev/null 2>&1 || fail "docker compose недоступен (нужен root или группа docker)"

backup() {
    umask 077
    mkdir -p backups
    chmod 700 backups
    [ -n "$(docker compose ps -q --status running "$SERVICE" 2>/dev/null)" ] || fail "контейнер $SERVICE не запущен"

    # Временный файл создаётся в data/ внутри контейнера; прошлый неудачный запуск мог его оставить — удаляем
    docker compose exec -T "$SERVICE" node --disable-warning=ExperimentalWarning --input-type=commonjs - <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const src = process.env.DATABASE_PATH || '/app/data/app.db';
const tmp = path.join(path.dirname(src), 'backup.tmp.db');
fs.rmSync(tmp, { force: true });
new DatabaseSync(src).exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
const check = new DatabaseSync(tmp, { readOnly: true }).prepare('PRAGMA integrity_check').get();
if (check.integrity_check !== 'ok') {
    fs.rmSync(tmp, { force: true });
    console.error(`integrity_check: ${check.integrity_check}`);
    process.exit(1);
}
EOF

    local stamp
    stamp="$(date +%F_%H-%M)"
    mv data/backup.tmp.db "backups/app-$stamp.db"
    chmod 600 "backups/app-$stamp.db"
    # .env нужен для восстановления: от APP_SECRET зависят резервные коды 2FA и сессии, в нём же ключи API
    if [ -f .env ]; then
        cp .env "backups/env-$stamp"
        chmod 600 "backups/env-$stamp"
    fi

    # Храним только последние $KEEP копий
    ls -1t backups/app-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
    ls -1t backups/env-* 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
    log "копия: backups/app-$stamp.db ($(du -h "backups/app-$stamp.db" | cut -f1))"
}

restore() {
    local file="${1:-}"
    [ -n "$file" ] || fail "укажите файл: scripts/backup.sh restore backups/app-ГГГГ-ММ-ДД_ЧЧ-ММ.db"
    [ -f "$file" ] || fail "файл $file не найден"

    echo "База data/app.db будет заменена копией $file."
    echo "Текущая база сохранится рядом как data/app.db.before-restore-<время>."
    echo "Оплаты и изменения, сделанные после создания копии, в базе сайта пропадут — сверьте их с Platega и панелью."
    if [ "${2:-}" != "--yes" ]; then
        read -r -p "Продолжить? Введите yes: " answer
        [ "$answer" = "yes" ] || fail "отменено"
    fi

    log "останавливаю контейнер"
    docker compose stop "$SERVICE"

    local stamp
    stamp="$(date +%F_%H-%M-%S)"
    # WAL и SHM обязательно убираем вместе с базой: иначе SQLite применит старый WAL поверх восстановленной копии
    for f in data/app.db data/app.db-wal data/app.db-shm; do
        if [ -e "$f" ]; then mv "$f" "$f.before-restore-$stamp"; fi
    done
    cp "$file" data/app.db
    chown "$DATA_UID:$DATA_UID" data/app.db
    chmod 600 data/app.db

    log "запускаю контейнер"
    docker compose start "$SERVICE"
    log "готово. Если сервер новый — .env должен быть из той же копии (тот же APP_SECRET)"
}

case "${1:-backup}" in
    backup) backup ;;
    restore) shift; restore "$@" ;;
    *) fail "команда: backup | restore <файл>" ;;
esac
