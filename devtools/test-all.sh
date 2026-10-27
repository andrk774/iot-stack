#!/usr/bin/env bash
# Все тесты проекта одним запуском (Node 22, Python 3, g++, bash).
#   devtools/test-all.sh                       — без PostgreSQL
#   PG_TEST_URL=postgres://iot@127.0.0.1:5432/postgres devtools/test-all.sh   — плюс интеграция с реальной БД
set -uo pipefail
cd "$(dirname "$0")/.."
failed=()
skipped=()

# Python: на Windows python3 может оказаться заглушкой Microsoft Store — проверяем, что он настоящий
PY=""
for c in python3 python "py -3"; do
  if $c -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >/dev/null 2>&1; then PY="$c"; break; fi
done
CXX_BIN=""
for c in g++ c++ clang++; do command -v "$c" >/dev/null 2>&1 && { CXX_BIN="$c"; break; }; done

run() {
  local name="$1"; shift
  printf '%s ... ' "$name"
  if out="$("$@" 2>&1)"; then echo "ok"; else echo "FAIL"; echo "$out" | tail -25; failed+=("$name"); fi
}

run "shared (cron, сценарии)"       bash -c 'cd shared && node --test test/*.test.js'
run "backend"                       bash -c 'cd backend && node --test test/*.test.js'
run "ingest"                        bash -c 'cd ingest && node --test test/*.test.js'
# интеграционные тесты сами пропускаются без PG_TEST_URL; при заданном — бьют в настоящую БД
run "scenarios (движок)"            bash -c 'cd scenarios && node --test test/*.test.js'
run "bridges (адаптеры, ядро)"      bash -c 'cd bridges && node --test test/*.test.js'
run "web (MQTT-кодек, форматы)"     bash -c 'cd web && node --test test/*.test.js'
run "sdk/node"                      bash -c 'cd sdk/node && node --test test/*.test.js'
if [ -n "$PY" ]; then
  run "sdk/python"                  bash -c "cd sdk/python && $PY -m unittest discover -s tests"
else
  echo "sdk/python ... пропущено (нет Python 3.9+)"; skipped+=("sdk/python")
fi
if [ -n "$CXX_BIN" ] && command -v make >/dev/null 2>&1; then
  run "sdk/arduino (ESP32 + ESP8266)" make -s -C sdk/arduino/IotDevice/test/host all CXX="$CXX_BIN"
else
  echo "sdk/arduino ... пропущено (нужны g++ и make)"; skipped+=("sdk/arduino")
fi
run "backup (ротация)"              bash backup/test.sh ${PG_TEST_URL:+"$PG_TEST_URL"}
run "docker compose config"         docker compose --env-file .env.example --profile zigbee --profile esphome --profile generic config --quiet
run "shell syntax"                  bash -c 'bash -n setup.sh && bash -n backup/backup.sh && bash -n backup/restore.sh'
[ -z "${PG_TEST_URL:-}" ] && echo "(интеграция с PostgreSQL пропущена: задайте PG_TEST_URL)"

if [ ${#failed[@]} -gt 0 ]; then echo "Упали: ${failed[*]}"; exit 1; fi
if [ ${#skipped[@]} -gt 0 ]; then echo "Все запущенные проверки прошли; пропущено: ${skipped[*]}"; exit 0; fi
echo "Все проверки прошли"
