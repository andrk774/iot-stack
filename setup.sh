#!/usr/bin/env bash
# Первичная установка на VPS: генерирует .env, сертификат, поднимает стек.
# Повторный запуск безопасен: существующий .env и сертификаты не трогаются.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "ОШИБКА: $*" >&2; exit 1; }

command -v docker >/dev/null || die "Docker не установлен. Установка: curl -fsSL https://get.docker.com | sh"
docker compose version >/dev/null 2>&1 || die "Нужен Docker Compose v2 (docker compose)"
command -v openssl >/dev/null || die "Нужен openssl"

gen() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-40; }
is_ip() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; }

# ---------- .env ----------
if [ ! -f .env ]; then
  read -rp "Домен для сервера (пусто = работать по IP с самоподписанным сертификатом): " DOMAIN
  if [ -n "$DOMAIN" ]; then
    read -rp "Email для Let's Encrypt: " LE_EMAIL
    [ -n "$LE_EMAIL" ] || die "Email обязателен для Let's Encrypt"
    TLS_MODE=letsencrypt
    PUBLIC_HOST="$DOMAIN"
  else
    PUBLIC_HOST="$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
    is_ip "$PUBLIC_HOST" || die "Не удалось определить публичный IP, впишите его в .env вручную"
    TLS_MODE=selfsigned
    LE_EMAIL=""
  fi

  sed \
    -e "s|^PUBLIC_HOST=.*|PUBLIC_HOST=${PUBLIC_HOST}|" \
    -e "s|^TLS_MODE=.*|TLS_MODE=${TLS_MODE}|" \
    -e "s|^LE_EMAIL=.*|LE_EMAIL=${LE_EMAIL}|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(gen)|" \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$(gen)$(gen)|" \
    -e "s|^MQTT_BACKEND_PASSWORD=.*|MQTT_BACKEND_PASSWORD=$(gen)|" \
    -e "s|^MQTT_INGEST_PASSWORD=.*|MQTT_INGEST_PASSWORD=$(gen)|" \
    -e "s|^MQTT_SCENARIOS_PASSWORD=.*|MQTT_SCENARIOS_PASSWORD=$(gen)|" \
    -e "s|^EMQX_COOKIE=.*|EMQX_COOKIE=$(gen)|" \
    -e "s|^EMQX_DASHBOARD_PASSWORD=.*|EMQX_DASHBOARD_PASSWORD=$(gen)|" \
    -e "s|^EMQX_API_SECRET=.*|EMQX_API_SECRET=$(gen)|" \
    .env.example > .env
  chmod 600 .env
  echo "Создан .env (секреты сгенерированы)"
fi

# Обновление со старой версии: дописать в .env переменные, которых в нём ещё нет
SECRETS=" POSTGRES_PASSWORD JWT_SECRET MQTT_BACKEND_PASSWORD MQTT_INGEST_PASSWORD MQTT_SCENARIOS_PASSWORD EMQX_COOKIE EMQX_DASHBOARD_PASSWORD EMQX_API_SECRET "
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z0-9_]+)= ]] || continue
  key="${BASH_REMATCH[1]}"
  grep -q "^${key}=" .env && continue
  if [[ "$SECRETS" == *" $key "* ]]; then echo "${key}=$(gen)" >> .env; else echo "$line" >> .env; fi
  echo "В .env добавлено: $key"
done < .env.example

set -a; . ./.env; set +a

# ---------- ключ REST API EMQX (файл bootstrap, читается EMQX при старте) ----------
mkdir -p ./data/emqx
[ -d ./data/emqx/api_keys.conf ] && rmdir ./data/emqx/api_keys.conf  # Docker создаёт каталог, если файла не было
printf '%s:%s\n' "${EMQX_API_KEY:-iot-backend}" "$EMQX_API_SECRET" > ./data/emqx/api_keys.conf
chmod 644 ./data/emqx/api_keys.conf  # EMQX в контейнере работает не от root

# ---------- сертификат ----------
CONF=./data/certbot/conf
LIVE="$CONF/live/iot"
mkdir -p "$LIVE" ./data/certbot/www

make_selfsigned() { # $1=host $2=days
  local san
  if is_ip "$1"; then san="IP:$1"; else san="DNS:$1"; fi
  openssl req -x509 -nodes -newkey rsa:2048 -days "$2" \
    -keyout "$LIVE/privkey.pem" -out "$LIVE/fullchain.pem" \
    -subj "/CN=$1" -addext "subjectAltName=$san" 2>/dev/null
}

if [ ! -f "$LIVE/fullchain.pem" ]; then
  if [ "$TLS_MODE" = "selfsigned" ]; then
    make_selfsigned "$PUBLIC_HOST" 3650
    echo "Создан самоподписанный сертификат на 10 лет для $PUBLIC_HOST"
  else
    make_selfsigned "$PUBLIC_HOST" 1
    touch "$LIVE/.dummy"
    echo "Создан временный сертификат (заменится на Let's Encrypt)"
  fi
fi

# ---------- запуск ----------
docker compose build
docker compose up -d
echo "Ждём, пока nginx поднимется..."
for _ in $(seq 1 60); do
  if docker compose exec -T nginx nginx -t >/dev/null 2>&1; then break; fi
  sleep 3
done

# ---------- Let's Encrypt ----------
if [ "$TLS_MODE" = "letsencrypt" ] && [ -f "$LIVE/.dummy" ]; then
  echo "Запрашиваем сертификат Let's Encrypt для $PUBLIC_HOST ..."
  rm -rf "$CONF/live/iot" "$CONF/archive/iot" "$CONF/renewal/iot.conf"
  if docker compose run --rm --entrypoint certbot certbot certonly \
       --webroot -w /var/www/certbot --cert-name iot -d "$PUBLIC_HOST" \
       --email "$LE_EMAIL" --agree-tos --no-eff-email --non-interactive; then
    docker compose exec -T nginx nginx -s reload
    echo "Сертификат Let's Encrypt установлен"
  else
    mkdir -p "$LIVE"; make_selfsigned "$PUBLIC_HOST" 1; touch "$LIVE/.dummy"
    docker compose exec -T nginx nginx -s reload || true
    die "certbot не смог получить сертификат. Проверьте, что A-запись $PUBLIC_HOST указывает на этот VPS и порт 80 открыт, затем запустите ./setup.sh ещё раз"
  fi
fi

cat <<EOF

Готово.
  API:            https://${PUBLIC_HOST}/api/health
  MQTT (TLS):     ${PUBLIC_HOST}:8883
  EMQX dashboard: ssh -L 18083:127.0.0.1:18083 <user>@<vps>, затем http://localhost:18083
                  логин admin, пароль — EMQX_DASHBOARD_PASSWORD в .env
  Панель:         https://${PUBLIC_HOST}/  (первый зарегистрированный — ваш аккаунт)
Статус:  docker compose ps
Логи:    docker compose logs -f backend ingest scenarios
Бэкап сейчас: docker compose exec backup backup.sh now
EOF
