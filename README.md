# IoT Stack — самохостинговая платформа по принципам 2Smart

Платформа для своих устройств на одном VPS: веб-панель, привязка устройств, MQTT с TLS и ACL,
история показаний, сценарии автоматизации, мосты для Zigbee/ESPHome/любого MQTT, бэкапы,
SDK для ESP32, ESP8266, Node.js и Python.

```
ESP32/ESP8266/Pi ──mqtts:8883──┐                       ┌── auth/ACL (HTTP) ── backend :8001
мосты (дома) ─────mqtts:8883───┼─► nginx ─► EMQX :1883 ◄┘
браузер ──────────wss /mqtt────┘    │          │  шина dev/<id>/…, bridge/<id>/$state
браузер ──────────https /api ───────┴─► backend :8000 (REST, JWT, мосты, сценарии)
                                         │
              ingest ($share, пачки) ────┼──► PostgreSQL + TimescaleDB ◄── backup (pg_dump → диск/S3)
              scenarios (правила, cron) ─┘         ▲ NOTIFY scenarios_changed
```

| Сервис | Аналог в 2Smart | Что делает |
|---|---|---|
| `emqx` | `2smart-emqx` | MQTT-брокер. Логин и ACL спрашивает у бэкенда по HTTP |
| `postgres` | `2smart-mysql` + `influxdb` | Пользователи, устройства, мосты, сценарии, уведомления; телеметрия в hypertable (сжатие через 7 дней, удаление через 90) |
| `backend` | `client-dashboard-be` | REST API, JWT, привязка устройств, команды, мосты, сценарии, хуки EMQX, миграции БД |
| `ingest` | `time-series-service` | Пишет значения в БД пачками раз в секунду, отслеживает состояние мостов |
| `scenarios` | `scenario-runner` | Правила «если — то», расписания, уведомления |
| `nginx` | `2smart-nginx` | Панель, HTTPS, CSP, rate limit, TLS для MQTT (8883), WebSocket `/mqtt` |
| `web/public` | `2smart-ui` | Веб-панель без сборки: устройства, живые данные, графики, сценарии, мосты |
| `bridge-*` | мосты `zigbee`, `esphome`, `mqtt-adapter` | zigbee2mqtt, ESPHome/Tasmota (MQTT discovery), произвольный MQTT по правилам |
| `backup` | `backup-service` | Ежедневный `pg_dump`, ротация, выгрузка в S3-совместимое хранилище |
| `certbot` | `certbot-bridge` | Сертификат Let's Encrypt и его продление |

Сознательно не повторено из 2Smart: `docker.sock` в контейнерах, самообновление, маркетплейс мостов —
это даёт контейнерам root на хосте. Мосты включаются профилями Compose, обновление — `docker compose pull/build`.

## Установка на VPS

Нужны Ubuntu/Debian, 2 ГБ RAM (лучше 4) и Docker с Compose v2.

```bash
curl -fsSL https://get.docker.com | sh
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 8883/tcp && sudo ufw enable

scp -r iot-stack user@vps:~/ && ssh user@vps
cd ~/iot-stack && ./setup.sh
```

`setup.sh` спросит домен:
- **есть домен** (A-запись указывает на VPS) — сертификат Let's Encrypt с автопродлением;
- **нет домена** — самоподписанный сертификат на IP на 10 лет; его нужно вшить в прошивки.

Секреты генерируются в `.env` (права 600). При обновлении со старой версии `setup.sh` сам допишет
в `.env` новые переменные. Схема БД обновляется автоматически при старте бэкенда (`backend/migrations`).

Затем откройте `https://<host>/` и зарегистрируйтесь. После этого можно выставить
`ALLOW_REGISTRATION=false` в `.env` и выполнить `docker compose up -d backend`.

EMQX Dashboard открыт только на localhost сервера:
`ssh -L 18083:127.0.0.1:18083 user@vps`, затем `http://localhost:18083` (admin / `EMQX_DASHBOARD_PASSWORD`).

## Веб-панель

- **Устройства** — список с текущими значениями; значения обновляются вживую по MQTT over WSS.
- **Устройство** — плитки строятся из `$meta`: переключатели для `boolean`, поля ввода для чисел и строк
  с учётом `min`/`max`, график за час/сутки/неделю/месяц, перепривязка, удаление.
- **Сценарии** — редактор правил, включение и выключение, ручной запуск, последняя ошибка.
- **Мосты** — создание, токен и готовые строки для `.env`, смена токена.
- **Уведомления** — то, что прислали сценарии.

Панель подписывается на брокер как пользователь `u:<id>` с JWT вместо пароля и может только читать
топики своих устройств. Команды идут через REST, где сервер проверяет `settable`.

Разработка панели без сервера: `node web/dev/mock-server.js` → `http://localhost:8080`
(данные в памяти, мини-брокер MQTT over WebSocket).

## Топики

```
dev/<id>/$state       init | ready | lost | sleeping | alert | disconnected   (retained)
dev/<id>/$meta        {"name":…, "fw":…, "props": {"relay": {"type":"boolean","settable":true}, …}}  (retained)
dev/<id>/<prop>       значение: число, true/false или текст до 256 байт
dev/<id>/<prop>/set   команда (публикуют только бэкенд и сценарии)
bridge/<bid>/$state   состояние моста (LWT); при потере — его устройства помечаются «нет связи»
```

| Кто подключается | Логин | Права |
|---|---|---|
| устройство | `d<16 hex>` = client id | публикует своё поддерево, подписан на свои `…/set` |
| мост | `b<16 hex>` = client id | то же для устройств, которые он зарегистрировал |
| веб-панель | `u:<uuid>`, пароль = JWT, client id `web-<uuid>-<случайное>` | только подписка на свои устройства |
| `backend`, `ingest`, `scenarios` | из `.env` | superuser |

Отзыв доступа действует сразу. При перепривязке или удалении устройства, смене токена или удалении моста
бэкенд меняет пароль в БД и разрывает уже открытую сессию через REST API EMQX (`DELETE /api/v5/clients/<id>`).
Ключ API (`EMQX_API_KEY`/`EMQX_API_SECRET`) генерирует `setup.sh` и кладёт в `data/emqx/api_keys.conf`.

Плохое сообщение не останавливает запись: значения и `$meta` с нулевым байтом отбрасываются ещё в ingest,
а если PostgreSQL всё же отклонит строку, ingest находит её делением пачки пополам и выбрасывает только её
(счётчик `rejected` в логе). Пачка целиком возвращается в буфер только при ошибке связи с БД.

## Сценарии

Запуск:
- изменение свойства: `>`, `≥`, `<`, `≤`, `=`, `≠` срабатывают на переходе «не выполнено → выполнено»;
  `изменилось` — на каждое новое значение;
- переход устройства в состояние (`нет связи`, `тревога`, …);
- расписание cron в своём часовом поясе (`0 7 * * 1-5`);
- только вручную.

Дополнительные условия проверяются по последним известным значениям. Действия выполняются по порядку:
установить свойство, уведомить (`{device}`, `{property}`, `{value}`, `{scenario}` в тексте), пауза до часа.
Защита от зацикливания: пока сценарий выполняется, повторно он не запускается; не больше 30 запусков в минуту;
настраиваемый интервал «не запускать повторно».

## Уведомления

Действие сценария «Уведомить» всегда пишет в ленту панели, а в **Настройки → Куда присылать уведомления**
подключаются внешние каналы. У каждого канала свой порог: все, «внимание и тревога» или только тревога.

- **Telegram, платформенный бот.** Создайте бота у @BotFather и впишите токен в `.env` (`TELEGRAM_BOT_TOKEN`),
  перезапустите `backend`. В панели кнопка «Подключить Telegram» откроет бота со ссылкой `?start=<код>`
  (действует 15 минут). Бот работает через long polling: вебхук и открытые порты не нужны. `/stop` в чате отключает его.
- **Telegram, свой бот:** токен бота и id чата прямо в панели, без настройки сервера.
- **Вебхук:** POST с JSON `{id, level, message, scenario_id, scenario_name, created_at}` на https-адрес.
  Подпись: `X-Iot-Signature: sha256=HMAC_SHA256(secret, "<X-Iot-Timestamp>.<тело>")`, секрет показывается один раз.
  Адреса внутренних сетей (10/8, 192.168/16, 127/8, docker-сеть и т. п.) запрещены — проверка идёт после DNS,
  редиректы не выполняются.
- **Push в браузер** — см. «Приложение на телефон (PWA)».

Рассылка идёт сразу после записи в ленту (NOTIFY `notification_new`), при сбое — одна повторная попытка.
Если бот заблокирован в чате или браузер отозвал подписку, канал выключается, причина видна в списке.
Если бэкенд был выключен больше часа, накопившиеся уведомления остаются только в ленте.
Если `api.telegram.org` с VPS недоступен, укажите зеркало Bot API в `TELEGRAM_API_URL`.

## Мосты

1. В панели: **Мосты → Добавить мост**, выберите тип. Панель покажет `BRIDGE_ID` и токен (один раз).
2. Запустите мост там, где виден внешний брокер:
   - **дома** рядом с zigbee2mqtt/ESPHome — `bridges/home/` (mosquitto + zigbee2mqtt + мосты; к VPS ходят по https и mqtts,
     наружу из дома ничего открывать не нужно):
     ```bash
     cd bridges/home && cp .env.example .env   # PUBLIC_HOST и выданные ID/токены
     docker compose --profile zigbee up -d
     ```
   - **на VPS**, если внешний брокер доступен оттуда: впишите `ZIGBEE_BRIDGE_ID`/`…_TOKEN`/`…_MQTT_URL` в `.env`
     и `docker compose --profile zigbee up -d` (так же `esphome`, `generic`).
3. Устройства появятся в панели сами, с типами и единицами из zigbee2mqtt или discovery.

| Тип | Откуда устройства | Что поддерживается |
|---|---|---|
| `zigbee2mqtt` | `<base>/bridge/devices` | binary, numeric (с диапазоном), enum, text; свойства внутри light/switch/climate/cover/lock; доступность |
| `esphome` | MQTT discovery (`homeassistant/…/config`) | sensor, binary_sensor, switch, number, select, light (вкл/выкл и яркость в JSON-схеме); доступность. Нужен компонент `mqtt:` в ESPHome, пример — `bridges/home/esphome-example.yaml`. Подходит и для Tasmota |
| `generic` | правила в настройках моста | топик → свойство, ключ в JSON, `payload_on/off`, топик команды |

Ограничения: ESPHome native API (порт 6053) не используется — только MQTT. В zigbee2mqtt не поддерживаются
составные свойства (цвет XY, расписания термостатов).

## Бэкапы

Сервис `backup` каждый день в `BACKUP_TIME` делает `pg_dump` в `./data/backups`, проверяет файл и хранит
`BACKUP_KEEP_DAYS` последних дней. Если заданы `S3_*`, копия уходит в S3-совместимое хранилище
и там хранится `S3_KEEP_DAYS` дней.

```bash
docker compose exec backup backup.sh now     # бэкап сейчас
docker compose exec backup backup.sh list    # что есть локально и в S3

docker compose stop backend ingest scenarios
docker compose exec backup restore.sh iot-2026-10-23T0330.dump      # или s3://bucket/iot-backups/…
docker compose start backend ingest scenarios
```

`.env` в бэкап не входит — храните его копию отдельно: без него не прочитать учётки сервисов.

## SDK для устройств

| SDK | Где | Для чего |
|---|---|---|
| `sdk/arduino/IotDevice` | Arduino IDE / PlatformIO | ESP32 и ESP8266: привязка, портал настройки Wi-Fi и токена, MQTT over TLS, свойства. Для установки по ссылке — отдельный репозиторий [andrk774/IotDevice](https://github.com/andrk774/IotDevice) |
| `sdk/node` | Node.js 18+ | Raspberry Pi и любой Linux |
| `sdk/python` | Python 3.9+, paho-mqtt 2 | Raspberry Pi и любой Linux |

Во всех трёх одинаково: объявить свойства, повесить обработчик команд, `start()`/`begin()`.
Учётка выдаётся по одноразовому claim-токену из **Устройства → Добавить устройство** и сохраняется на устройстве.

## API

```bash
H=https://<host>   # для самоподписанного добавляйте -k
TOKEN=$(curl -s $H/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"long-password"}' | jq -r .token)
A="authorization: Bearer $TOKEN"

curl -s $H/api/devices -H "$A"
curl -s $H/api/devices -H "$A" -H 'content-type: application/json' -d '{"name":"Кухня"}'      # -> claim_token
curl -s $H/api/devices/<id>/commands -H "$A" -H 'content-type: application/json' -d '{"property":"relay","value":true}'
curl -s "$H/api/devices/<id>/telemetry?property=temperature&bucket=1h" -H "$A"
curl -s $H/api/scenarios -H "$A"
curl -s $H/api/bridges -H "$A"
curl -s "$H/api/notifications?unread=true" -H "$A"
```

| Метод | Путь | |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | JWT |
| GET | `/api/me` | |
| GET, POST | `/api/devices` | список; создать → `claim_token` |
| GET, PUT, DELETE | `/api/devices/:id` | PUT — переименовать |
| POST | `/api/devices/:id/claim` | новый токен привязки (старая учётка перестаёт работать) |
| POST | `/api/devices/:id/commands` | `{property, value}` |
| GET | `/api/devices/:id/telemetry` | `property`, `from`, `to`, `bucket` (`30s`…`1d`), `limit` |
| POST | `/api/provision` | вызывает устройство: `{claim_token}` → MQTT-учётка |
| GET, POST | `/api/scenarios` | |
| GET, PUT, DELETE | `/api/scenarios/:id` | |
| POST | `/api/scenarios/:id/run` | ручной запуск |
| GET | `/api/notifications` | `unread=true`, `limit` |
| POST | `/api/notifications/read` | `{ids?}` — все или выбранные |
| GET, POST | `/api/bridges` | создать → `token` (один раз) |
| GET, PUT, DELETE | `/api/bridges/:id` | удаление забирает устройства моста и их историю |
| POST | `/api/bridges/:id/token` | новый токен |
| GET | `/api/bridge/self`, `/api/bridge/devices` | для моста: `Authorization: Bridge <id>:<token>` |
| POST | `/api/bridge/devices` | мост регистрирует устройство `{key, name}` |
| GET, POST | `/api/channels` | каналы уведомлений: `{type: webhook, url}`, `{type: telegram, bot_token, chat_id}`, `{type: webpush, subscription}` |
| POST | `/api/channels/telegram-link` | ссылка на платформенного бота `t.me/<бот>?start=<код>` |
| PUT, DELETE | `/api/channels/:id` | `{name?, min_level?, enabled?}` |
| POST | `/api/channels/:id/test` | отправить тестовое сообщение |

## Эксплуатация

```bash
docker compose ps
docker compose logs -f backend ingest scenarios emqx
docker compose pull && docker compose build && docker compose up -d     # обновление
```

## Разработка и тесты

```bash
devtools/test-all.sh                                          # всё без БД
PG_TEST_URL=postgres://iot@127.0.0.1:5432/postgres devtools/test-all.sh   # плюс реальный PostgreSQL
```

На Windows запускайте из Git Bash. Наборы, для которых нет инструментов, помечаются пропущенными, а не упавшими:
`sdk/python` нужен Python 3.9+ (заглушка Microsoft Store не подходит), `sdk/arduino` — `g++` и `make`
(например, из MSYS2: `pacman -S mingw-w64-ucrt-x86_64-gcc make`). Проверка прав файла учётки (0600)
на Windows не выполняется — там их нет. Интеграционный PostgreSQL удобно поднять так:
`docker run -d -p 5432:5432 -e POSTGRES_USER=iot -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16`.

Что проверяется: ACL и хуки EMQX, все маршруты API на настоящем PostgreSQL 16 (TimescaleDB-функции заменены
заглушкой), миграции, ingest, движок сценариев и cron с часовыми поясами, адаптеры мостов на реальных форматах
zigbee2mqtt и ESPHome, MQTT-кодек панели, Node- и Python-SDK с подменённым транспортом, Python-SDK против
настоящего paho-mqtt, Arduino-SDK под ESP32 и ESP8266 с заглушками ядра и настоящим PubSubClient, ротация бэкапов
и `pg_dump`, валидность `docker-compose.yml`. Панель проверялась в headless Chromium на демо-сервере
с той же политикой CSP, что в продакшене.

Что не проверялось здесь: запуск контейнеров (Docker-демона не было), конфигурации nginx и EMQX на живых
образах, сборка прошивок настоящим тулчейном, работа с реальными zigbee2mqtt/ESPHome и S3.
Первый запуск на VPS — это и есть интеграционный тест: пришлите `docker compose logs`, если что-то не поднимется.

## Ограничения

- Без ключа API EMQX (старый `.env` без `./setup.sh`) отзыв доступа не разрывает открытые сессии — бэкенд пишет об этом при старте.
- JWT веб-панели не отзывается до истечения срока (`JWT_TTL_SEC`); смена пароля пока не предусмотрена.
- ingest подтверждает сообщения до записи в БД: при падении в момент сброса можно потерять до секунды данных.
- Устройство моста, удалённое в панели, появится снова после перезапуска моста, если оно всё ещё есть в zigbee2mqtt или ESPHome.
- Нет OTA-обновлений прошивок и мобильного приложения.

## Лицензия

MIT — см. [LICENSE](LICENSE).
