#!/usr/bin/env bash
# Восстановление базы из бэкапа. Сначала остановите сервисы, которые пишут в базу:
#   docker compose stop backend ingest scenarios
#   docker compose exec backup restore.sh iot-2026-10-23T0330.dump      # файл из ./data/backups
#   docker compose exec backup restore.sh s3://bucket/iot-backups/iot-2026-10-23T0330.dump
#   docker compose start backend ingest scenarios
set -euo pipefail

src="${1:-}"
[ -n "$src" ] || { echo "usage: restore.sh <файл в /backups | s3://...>" >&2; exit 2; }

file="$src"
if [[ "$src" == s3://* ]]; then
  file="/tmp/restore.dump"
  args=()
  [ -n "${S3_ENDPOINT:-}" ] && args+=(--endpoint-url "$S3_ENDPOINT")
  aws "${args[@]}" s3 cp --only-show-errors "$src" "$file"
elif [[ "$src" != /* ]]; then
  file="${BACKUP_DIR:-/backups}/$src"
fi
[ -f "$file" ] || { echo "нет файла $file" >&2; exit 1; }
pg_restore --list "$file" >/dev/null

active="$(psql -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name <> 'psql'")"
if [ "$active" != "0" ]; then
  echo "К базе подключено клиентов: $active. Остановите: docker compose stop backend ingest scenarios" >&2
  exit 1
fi

read -r -p "База $PGDATABASE будет перезаписана из $(basename "$file"). Продолжить? [y/N] " ok
[ "$ok" = "y" ] || { echo "отменено"; exit 1; }

# TimescaleDB требует режим восстановления вокруг pg_restore
psql -v ON_ERROR_STOP=1 -c "SELECT timescaledb_pre_restore();"
pg_restore --clean --if-exists --no-owner --dbname="$PGDATABASE" "$file" || echo "pg_restore завершился с предупреждениями — проверьте вывод выше"
psql -v ON_ERROR_STOP=1 -c "SELECT timescaledb_post_restore();"
echo "Готово. Запустите: docker compose start backend ingest scenarios"
