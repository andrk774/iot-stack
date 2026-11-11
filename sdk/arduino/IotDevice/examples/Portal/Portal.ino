// Без настроек в прошивке: всё вводится через портал.
//
// 1. Прошейте. Устройство поднимет Wi-Fi сеть "IoT-XXXX".
// 2. Подключитесь к ней с телефона — откроется страница настройки (или зайдите на http://192.168.4.1).
// 3. Введите Wi-Fi, адрес сервера и claim_token из POST /api/devices.
//
// Сброс настроек: удерживать BOOT (GPIO0) при включении 3 секунды.
// Портал также откроется сам, если Wi-Fi не подключается минуту, токен не принят 3 раза
// или сервер перестал принимать учётку (устройство удалили).
//
// Удалённо (POST /api/devices/<id>/commands):
//   {"property":"cmd","value":"identify"}  — помигать светодиодом 5 секунд
//   {"property":"cmd","value":"reboot"}    — перезагрузить; "portal" — открыть портал; "reset" — сброс
// Обновление прошивки: «Настройки → Прошивки» в панели, затем «Обновить прошивку» на странице устройства.
#include <IotDevice.h>

const int LED_PIN = 2;
const int BUTTON_PIN = 0;  // BOOT

static const char CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
PASTE_CERTIFICATE_HERE
-----END CERTIFICATE-----
)PEM";

IotDevice device("Розетка", "1.0.0");

// persist(): после пропадания питания розетка вернётся в прежнее состояние
IotProperty& power = device.addBool("power").persist().onSet([](IotProperty&, const String& v) {
  digitalWrite(LED_PIN, v == "true" ? HIGH : LOW);
  return true;
});

uint32_t identifyUntil = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  device.setDebug(&Serial);
  device.setCaCert(CA_CERT);
  device.setConfigButton(BUTTON_PIN);
  device.setPortal("setup1234", 300);  // пароль точки доступа (>= 8 символов), таймаут 5 минут

  device.onStateChange([](IotDevice::State s) {
    Serial.printf("состояние: %s\n", IotDevice::stateName(s));
  });

  device.enableStats(60);  // rssi, uptime, free_heap, reset_reason, ip
  device.enableCommands();  // cmd: reboot, portal, reset, identify
  device.onIdentify([] { identifyUntil = millis() + 5000; });
  device.enableOta();  // обновление прошивки из панели
  device.onOtaStart([] {
    Serial.println("обновление прошивки: розетка выключается на время установки");
    digitalWrite(LED_PIN, LOW);
    return true;  // false — отказаться от обновления
  });

  power.setBool(false);  // по умолчанию, если сохранённого значения ещё нет
  if (!device.begin()) Serial.println("Ошибки конфигурации — см. сообщения [iot] ОШИБКА выше");
}

void loop() {
  device.loop();

  // В режиме портала и по команде identify мигаем светодиодом
  const bool identify = identifyUntil && (int32_t)(millis() - identifyUntil) < 0;
  if (device.state() == IotDevice::State::Portal || identify) {
    digitalWrite(LED_PIN, (millis() / 250) % 2 ? HIGH : LOW);
  } else if (identifyUntil) {
    identifyUntil = 0;
    digitalWrite(LED_PIN, power.boolValue() ? HIGH : LOW);  // вернуть состояние розетки
  }
}
