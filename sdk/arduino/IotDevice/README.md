# IotDevice — SDK для ESP32 и ESP8266

Arduino-библиотека для подключения ESP32 и ESP8266 к IoT Stack. Аналог `2smart-cloud-cpp-sdk`.

Что берёт на себя:
- **Привязку**: обменивает claim-токен на MQTT-учётку и хранит её (ESP32 — NVS, ESP8266 — файл в LittleFS).
  При новом токене привязывается заново.
- **Портал настройки**: точка доступа `IoT-XXXX` с формой для Wi-Fi, сервера и токена. Открывается сам, если чего-то не хватает.
- **MQTT over TLS**: проверка сертификата, NTP, LWT `lost`, переподключение с экспоненциальной задержкой (1 → 60 с).
- **Типизированные свойства**: `bool`, `int`, `float`, `string`. SDK сам собирает `$meta`, приводит и проверяет
  входящие команды, отправляет значения, накопленные офлайн, после переподключения.

Требования: библиотека **PubSubClient** (Nick O'Leary) и одна из плат:
- **ESP32** — Arduino core 3.x;
- **ESP8266** — Arduino core 3.x. TLS идёт через BearSSL и занимает около 20 КБ ОЗУ, поэтому оставьте
  скетчу запас памяти. Файловая система LittleFS нужна для хранения настроек: выберите в Tools → Flash Size
  вариант с FS хотя бы на 64 КБ.

## Установка

Сервер, к которому подключается библиотека: [iot-stack](https://github.com/andrk774/iot-stack).

**Arduino IDE:** скачайте [ZIP этого репозитория](https://github.com/andrk774/IotDevice/archive/refs/heads/main.zip)
и добавьте через Sketch → Include Library → Add .ZIP Library, затем установите PubSubClient через менеджер библиотек.
Примеры появятся в File → Examples → IotDevice.

**PlatformIO:**
```ini
[env:esp32dev]
platform = espressif32
board = esp32dev
framework = arduino
lib_deps =
  knolleary/PubSubClient@^2.8
  https://github.com/andrk774/IotDevice.git

[env:d1_mini]
platform = espressif8266
board = d1_mini
framework = arduino
board_build.filesystem = littlefs
lib_deps =
  knolleary/PubSubClient@^2.8
  https://github.com/andrk774/IotDevice.git
```

Стандартная платформа `espressif32` в PlatformIO ставит Arduino core 2.x, а SDK сверялся с API core 3.x.
На 2.x он, скорее всего, тоже соберётся, но это не проверялось. Для core 3.x в PlatformIO есть
платформа [pioarduino](https://github.com/pioarduino/platform-espressif32).

## Быстрый старт

```cpp
#include <IotDevice.h>

IotDevice device("Кухня", "1.0.0");

IotProperty& temp  = device.addFloat("temperature", "°C", 1);
IotProperty& relay = device.addBool("relay").onSet([](IotProperty&, const String& v) {
  digitalWrite(2, v == "true");
  return true;                       // принять команду
});

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
  device.setDebug(&Serial);
  device.setWiFi("my-wifi", "password");
  device.setServer("iot.example.com");
  device.setClaimToken("...из POST /api/devices...");
  device.setCaCert(CA_CERT);
  device.setPortal("change-me-1234");   // пароль точки доступа настройки
  if (!device.begin()) Serial.println("ошибки конфигурации — см. [iot] ОШИБКА в логе");
}

void loop() {
  device.loop();                     // вызывать постоянно, без длинных delay()
  temp.setFloat(readSensor());       // в своём темпе, например раз в 10 секунд
}
```

## Свойства

| Метод | Тип в `$meta` | Значение на проводе |
|---|---|---|
| `addBool(name)` | `boolean` | `true` / `false` |
| `addInt(name, unit)` | `integer` | `42` |
| `addFloat(name, unit, decimals)` | `float` | `21.5` (округление до `decimals`) |
| `addString(name)` | `string` | текст до 256 байт |

Имя свойства: `a-z`, `0-9`, `_`, `-`, до 32 символов, начинается с буквы. Его же проверяют ACL и ingest на сервере.
Свойство с недопустимым именем или повторным именем SDK не отправляет вовсе — ни в `$meta`, ни значениями:
`begin()` вернёт `false`, ошибки появятся в логе (`setDebug` можно вызвать и после объявления свойств)
и в `device.configErrors()`. Проверить конкретное свойство: `prop.valid()`.

Дополнительно к объявлению можно вызвать:
- `.unit("°C")` — единица измерения;
- `.range(min, max)` — для команд: значения вне диапазона SDK отклоняет сам;
- `.onSet(handler)` — делает свойство управляемым.

Установка значения: `setBool`, `setInt`, `setFloat`, `setString`. Если устройство онлайн, значение уходит сразу.
Если офлайн — после переподключения.
Каждый вызов — это одно сообщение и одна точка в истории. Вызывайте с нужной частотой, а не в каждом `loop()`.

Чтение: `value()` (как строка), `boolValue()`, `intValue()`, `floatValue()`, `hasValue()`.

### Команды

```cpp
device.addInt("brightness", "%").range(0, 100).onSet([](IotProperty& p, const String& v) {
  analogWrite(LED, v.toInt() * 255 / 100);
  return true;
});
```

`v` уже приведено к типу: `"on"`, `"1"`, `"yes"` превращаются в `"true"`, float округляется до `decimals`.
Обработчик возвращает:
- `true` — значение сохраняется и отправляется серверу как подтверждение;
- `false` — серверу уходит прежнее значение, интерфейс «откатится».

Сервер тоже знает о `settable`: бэкенд не отправит команду в свойство, которое в `$meta` не помечено управляемым.

## Настройки

| Метод | Назначение |
|---|---|
| `setWiFi(ssid, pass)` | Wi-Fi по умолчанию |
| `setServer(host, port = 8883)` | `PUBLIC_HOST` сервера; HTTPS для привязки всегда на 443 |
| `setClaimToken(token)` | токен для первой привязки или перепривязки |
| `setCaCert(pem)` | корневой сертификат сервера (см. ниже) |
| `setInsecure()` | без проверки сертификата — **только для отладки** |
| `setConfigButton(pin)` | удержание 3 с при включении стирает настройки (на ESP8266 для кнопки «к питанию» нужна внешняя подтяжка к земле) |
| `setPortal(apPass, timeoutSec)` | пароль точки доступа (от 8 символов) и таймаут портала. **Задайте его:** без пароля сеть открытая, и пароль Wi-Fi с claim-токеном уходят открытым текстом |
| `setDebug(&Serial)` | лог SDK |
| `onStateChange(cb)` | `Portal → WifiConnecting → Provisioning → MqttConnecting → Online` |

Значения, сохранённые через портал, важнее значений из прошивки. Чтобы вернуться к прошитым, сбросьте
настройки кнопкой или вызовите `device.resetConfig()`.

Прочее:
- `device.publishState("sleeping")` — свой `$state`: только `ready`, `sleeping`, `alert`
  (`init`, `lost`, `disconnected` выставляют SDK и брокер);
- `device.startPortal()` — открыть портал вручную, например по долгому нажатию.
  Перед этим SDK публикует `$state = disconnected`: при штатном отключении брокер LWT не шлёт;
- `device.online()`, `device.state()`, `device.deviceId()`.

### Сертификат

- **Let's Encrypt** — вшейте ISRG Root X1: `curl -s https://letsencrypt.org/certs/isrgrootx1.pem`.
  Это корневой сертификат: при продлении сертификата сервера раз в 60–90 дней прошивку менять не нужно.
- **Самоподписанный** — вшейте `data/certbot/conf/live/iot/fullchain.pem` с сервера.

### Когда открывается портал

- нет Wi-Fi, адреса сервера или (нет привязки и нет токена);
- Wi-Fi не подключился за минуту после включения (если устройство ещё ни разу не было онлайн);
- сервер 3 раза подряд отклонил токен — он просрочен или уже использован.

Учётку при отказе брокера SDK **не стирает**: сервер мог быть временно недоступен.
Если устройство удалили или перепривязали, введите новый токен через портал.

Пока портал открыт, подключение к Wi-Fi приостановлено: иначе попытки подключения гоняют радио по каналам,
и телефон отваливается от точки доступа. После таймаута портала подключение возобновляется.

В форме портала пустой пароль означает «не менять»; чтобы перейти на открытую сеть, отметьте
«Сеть без пароля». Имя сети сохраняется как введено, включая пробелы по краям.

### Хранение настроек

Учётка MQTT сохраняется одной записью, поэтому сбой питания не оставит её «наполовину».
На ESP8266 файл настроек записывается во временный и атомарно переименовывается поверх старого:
на флеше всегда есть целая версия. Учётки, сохранённые версией 0.1.x, читаются.

## Перепривязка

1. `POST /api/devices/<id>/claim` — новый токен. Старый пароль сразу перестаёт работать.
2. Передайте токен устройству: через портал (кнопка при включении) или новой прошивкой с `setClaimToken`.
3. SDK заметит, что токен отличается от использованного, и привяжется заново.

## Проверка на ПК

```bash
cd test/host
make test         # юнит-тесты протокола (топики, парсинг, $meta, JSON, файл настроек)
make device       # поведение: SDK и настоящий PubSubClient против симулятора (время, Wi-Fi, NVS, HTTP,
                  # поддельный MQTT-брокер, веб-сервер портала)
make compile      # сборка SDK и всех примеров под ESP32 с заглушками и настоящим PubSubClient
make compile8266  # то же под ESP8266 + проверка хранилища на LittleFS
```

Заглушки повторяют сигнатуры arduino-esp32 3.x и esp8266/Arduino 3.x. Это проверка API, типов и логики SDK,
а не замена сборки под плату: радио, TLS и флеш здесь не настоящие. Нужны `g++` и `make`
(в WSL: `sudo apt install g++ make`).

## Ограничения

- ESP32 и ESP8266 на Arduino core 3.x; другие платы не поддерживаются.
- PubSubClient публикует с QoS 0: при обрыве связи значение может потеряться (команды подписаны с QoS 1).
- Нет OTA-обновлений — следующий логичный шаг.
- Свойства объявляются до `begin()`. Добавленное позже не попадёт в `$meta` до переподключения.

## Лицензия

MIT — см. [LICENSE](LICENSE).
