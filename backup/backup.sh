#!/usr/bin/env bash
# Ежедневный бэкап PostgreSQL с ротацией, опционально — копия в S3-совместимое хранилище.
#
#   backup.sh           — работать по расписанию (BACKUP_TIME, по умолчанию 03:30 по TZ)
#   backup.sh now       — сделать бэкап сейчас и выйти
#   backup.sh list      — показать локальные и удалённые бэкапы
#
# Переменные: PGHOST PGUSER PGDATABASE PGPASSWORD, BACKUP_DIR=/backups, BACKUP_TIME=HH:MM,
# BACKUP_KEEP_DAYS=7, S3_BUCKET, S3_PREFIX, S3_ENDPOINT, S3_KEEP_DAYS=30, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_TIME="${BACKUP_TIME:-03:30}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
S3_PREFIX="${S3_PREFIX:-iot-backups}"
S3_KEEP_DAYS="${S3_KEEP_DAYS:-30}"

log() { echo "[backup $(date '+%F %T')] $*"; }

s3() {
  local args=()
  [ -n "${S3_ENDPOINT:-}" ] && args+=(--endpoint-url "$S3_ENDPOINT")
  aws "${args[@]}" s3 "$@"
}

s3_enabled() { [ -n "${S3_BUCKET:-}" ]; }

# Имя файла -> дата YYYY-MM-DD (iot-2026-10-23T0330.dump)
file_date() { sed -nE 's/^iot-([0-9]{4}-[0-9]{2}-[0-9]{2})T[0-9]{4}\.dump$/\1/p' <<<"$1"; }

# Список имён файлов -> те, что старше keep_days относительно today (оба YYYY-MM-DD)
expired() {
  local keep_days="$1" today="$2" name d cutoff
  # хранить ровно keep_days последних дней, включая сегодняшний
  cutoff="$(date -d "$today -$((keep_days - 1)) days" +%F)"
  while read -r name; do
    [ -z "$name" ] && continue
    d="$(file_date "$name")"
    [ -z "$d" ] && continue          # чужие файлы не трогаем
    [[ "$d" < "$cutoff" ]] && echo "$name"
  done
}

run_backup() {
  mkdir -p "$BACKUP_DIR"
  local name tmp
  name="iot-$(date +%Y-%m-%dT%H%M).dump"
  tmp="$BACKUP_DIR/.$name.partial"
  log "dump -> $name"
  pg_dump --format=custom --compress=6 --no-owner --file="$tmp"
  pg_restore --list "$tmp" >/dev/null   # файл читается — значит не битый
  mv "$tmp" "$BACKUP_DIR/$name"
  log "ok, $(du -h "$BACKUP_DIR/$name" | cut -f1)"

  local today
  today="$(date +%F)"
  ls -1 "$BACKUP_DIR" | expired "$BACKUP_KEEP_DAYS" "$today" | while read -r old; do
    log "rotate local: $old"
    rm -f "$BACKUP_DIR/$old"
  done

  if s3_enabled; then
    log "upload s3://$S3_BUCKET/$S3_PREFIX/$name"
    s3 cp --only-show-errors "$BACKUP_DIR/$name" "s3://$S3_BUCKET/$S3_PREFIX/$name"
    s3 ls "s3://$S3_BUCKET/$S3_PREFIX/" | awk '{print $4}' | expired "$S3_KEEP_DAYS" "$today" | while read -r old; do
      log "rotate s3: $old"
      s3 rm --only-show-errors "s3://$S3_BUCKET/$S3_PREFIX/$old"
    done
  fi
}

seconds_until() { # HH:MM -> секунд до ближайшего такого времени
  local target now next
  now="$(date +%s)"
  target="$(date -d "today $1" +%s)"
  if [ "$target" -le "$now" ]; then next="$(date -d "tomorrow $1" +%s)"; else next="$target"; fi
  echo $((next - now))
}

case "${1:-schedule}" in
  now)
    run_backup
    ;;
  list)
    echo "Локальные ($BACKUP_DIR):"
    ls -lh "$BACKUP_DIR" 2>/dev/null | grep -E 'iot-.*\.dump$' || echo "  нет"
    if s3_enabled; then echo "S3 (s3://$S3_BUCKET/$S3_PREFIX/):"; s3 ls "s3://$S3_BUCKET/$S3_PREFIX/" || true; fi
    ;;
  schedule)
    [[ "$BACKUP_TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { log "BACKUP_TIME должен быть HH:MM"; exit 1; }
    log "по расписанию каждый день в $BACKUP_TIME ($(date +%Z)), хранить ${BACKUP_KEEP_DAYS} дн.$(s3_enabled && echo ", S3 ${S3_KEEP_DAYS} дн." || true)"
    trap 'exit 0' TERM INT
    while :; do
      wait_s="$(seconds_until "$BACKUP_TIME")"
      log "следующий запуск через $((wait_s / 60)) мин"
      sleep "$wait_s" & wait $!
      run_backup || log "ОШИБКА бэкапа, следующая попытка завтра"
      sleep 61 & wait $!   # не запуститься дважды в ту же минуту
    done
    ;;
  test-expired) # для тестов: stdin — имена, $2 — keep, $3 — today
    expired "$2" "$3"
    ;;
  *)
    echo "usage: backup.sh [schedule|now|list]" >&2
    exit 2
    ;;
esac
