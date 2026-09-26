#!/usr/bin/env bash
# Резервная копия базы и .env (Docker-установка).
#
#   sudo scripts/backup.sh                    — сделать копию в backups/ (хранятся последние BACKUP_KEEP, по умолчанию 14)
#   sudo scripts/backup.sh restore <файл.db>  — восстановить базу из копии (или <файл.db.age> — из зашифрованной)
#
# Шифрование (рекомендуется, если копии уходят с сервера): публичный ключ age в .env —
# BACKUP_AGE_RECIPIENT=age1... Тогда копии базы и .env сохраняются как *.age, открытые файлы удаляются.
# Приватный ключ на сервере не нужен и не должен там храниться; для восстановления на сервере
# укажите путь к нему: BACKUP_AGE_IDENTITY=/root/age-key.txt sudo -E scripts/backup.sh restore <файл.db.age>
#
# Копия базы снимается внутри работающего контейнера через VACUUM INTO: это согласованный снимок
# даже во время записи, простой не нужен. После снятия копия проверяется (PRAGMA integrity_check).
# Запускать от root (sudo): файлы в data/ принадлежат пользователю контейнера (uid 1000).
set -euo pipefail

KEEP="${BACKUP_KEEP:-14}"
SERVICE=vpn-landing
DATA_UID=1000

log() { echo "[$(date '+%F %T')] $*"; }
fail() { echo "[$(date '+%F %T')] ОШИБКА: $*" >&2; exit 1; }

# Публичный ключ age: из окружения или из .env (для cron удобнее .env)
age_recipient() {
    local r="${BACKUP_AGE_RECIPIENT:-}"
    if [ -z "$r" ] && [ -f .env ]; then
        r="$(grep -E '^BACKUP_AGE_RECIPIENT=' .env | tail -n 1 | cut -d= -f2- | tr -d "\"' \r")"
    fi
    echo "$r"
}

require_age() {
    command -v age >/dev/null 2>&1 || fail "утилита age не установлена: sudo apt install -y age"
}

# Шифрует файл публичным ключом: <файл> → <файл>.age, открытый файл удаляется
encrypt_file() {
    local recipient="$1" file="$2"
    age -r "$recipient" -o "$file.age" "$file" || { rm -f "$file.age"; fail "не удалось зашифровать $file"; }
    chmod 600 "$file.age"
    rm -f "$file"
}

# Расшифровывает <файл>.age приватным ключом из BACKUP_AGE_IDENTITY в файл out
decrypt_file() {
    local file="$1" out="$2"
    local identity="${BACKUP_AGE_IDENTITY:-}"
    [ -n "$identity" ] || fail "копия зашифрована: укажите приватный ключ — BACKUP_AGE_IDENTITY=/путь/к/age-key.txt sudo -E scripts/backup.sh restore $file"
    [ -f "$identity" ] || fail "файл ключа $identity не найден"
    require_age
    age -d -i "$identity" -o "$out" "$file" || { rm -f "$out"; fail "не удалось расшифровать $file — тот ли ключ?"; }
}

preflight() {
    [ -w data ] || fail "нет прав на запись в data/ — запустите через sudo"
    docker compose version >/dev/null 2>&1 || fail "docker compose недоступен (нужен root или группа docker)"
}

backup() {
    umask 077
    local recipient
    recipient="$(age_recipient)"
    [ -z "$recipient" ] || require_age
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
    local db="backups/app-$stamp.db"
    mv data/backup.tmp.db "$db"
    chmod 600 "$db"
    # .env нужен для восстановления: от APP_SECRET зависят резервные коды 2FA и сессии, в нём же ключи API
    if [ -f .env ]; then
        cp .env "backups/env-$stamp"
        chmod 600 "backups/env-$stamp"
    fi
    if [ -n "$recipient" ]; then
        encrypt_file "$recipient" "$db"
        db="$db.age"
        if [ -f "backups/env-$stamp" ]; then encrypt_file "$recipient" "backups/env-$stamp"; fi
    fi

    # Храним только последние $KEEP копий (и открытых, и зашифрованных)
    ls -1t backups/app-*.db backups/app-*.db.age 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
    ls -1t backups/env-* 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
    log "копия: $db ($(du -h "$db" | cut -f1))${recipient:+, зашифрована}"
}

restore() {
    local file="${1:-}"
    [ -n "$file" ] || fail "укажите файл: scripts/backup.sh restore backups/app-ГГГГ-ММ-ДД_ЧЧ-ММ.db"
    [ -f "$file" ] || fail "файл $file не найден"
    local source="$file"
    if [[ "$file" == *.age ]]; then
        # Расшифрованная копия — во временном файле, удаляется при выходе (глобальная переменная: trap срабатывает после функции)
        RESTORE_TMP="$(mktemp data/restore.XXXXXX)"
        trap 'rm -f "$RESTORE_TMP"' EXIT
        source="$RESTORE_TMP"
        decrypt_file "$file" "$source"
    fi

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
    cp "$source" data/app.db
    chown "$DATA_UID:$DATA_UID" data/app.db
    chmod 600 data/app.db

    log "запускаю контейнер"
    docker compose start "$SERVICE"
    log "готово. Если сервер новый — .env должен быть из той же копии (тот же APP_SECRET)"
}

# Функции можно подключить без запуска (source) — так их проверяют тесты
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    cd "$(dirname "$0")/.."
    case "${1:-backup}" in
        backup) preflight; backup ;;
        restore) preflight; shift; restore "$@" ;;
        *) fail "команда: backup | restore <файл>" ;;
    esac
fi
