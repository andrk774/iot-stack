#!/usr/bin/env bash
# Проверка ротации и бэкапа на ПК: bash backup/test.sh [PG_URL]
set -euo pipefail
cd "$(dirname "$0")"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; fail=1; fi; }

names=$'iot-2026-10-10T0330.dump\niot-2026-10-16T0330.dump\niot-2026-10-17T0330.dump\niot-2026-10-23T0330.dump\nnotes.txt\niot-bad.dump'
got="$(./backup.sh test-expired 7 2026-10-23 <<<"$names" | tr '\n' ' ')"
check "keep 7 days" "$got" "iot-2026-10-10T0330.dump iot-2026-10-16T0330.dump "
got="$(./backup.sh test-expired 30 2026-10-23 <<<"$names" | tr '\n' ' ')"
check "keep 30 days" "$got" ""

if [ -n "${1:-}" ]; then
  dir="$(mktemp -d)"
  touch "$dir/iot-2020-01-01T0330.dump" "$dir/keep-me.txt"
  BACKUP_DIR="$dir" PGDATABASE="$(sed -E 's#.*/##' <<<"$1")" PGHOST=127.0.0.1 PGPORT="$(sed -E 's#.*:([0-9]+)/.*#\1#' <<<"$1")" PGUSER=iot ./backup.sh now >/dev/null
  check "old dump rotated" "$(ls "$dir" | grep -c 2020 || true)" "0"
  check "foreign file kept" "$(ls "$dir" | grep -c keep-me || true)" "1"
  check "new dump present" "$(ls "$dir" | grep -cE '^iot-.*\.dump$')" "1"
  rm -rf "$dir"
fi
exit $fail
