// Без настроек в прошивке: всё вводится через портал.
//
// 1. Прошейте. Устройство поднимет Wi-Fi сеть "IoT-XXXX".
// 2. Подключитесь к ней с телефона — откроется страница настройки (или зайдите на http://192.168.4.1).
// 3. Введите Wi-Fi, адрес сервера и claim_token из POST /api/devices.
//
// Сброс настроек: удерживать BOOT (GPIO0) при включении 3 секунды.
// Портал также откроется сам, если Wi-Fi не подключается минуту или токен не принят 3 раза.
#include <IotDevice.h>

const int LED_PIN = 2;
const int BUTTON_PIN = 0;  // BOOT

static const char CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
PASTE_CERTIFICATE_HERE
-----END CERTIFICATE-----
)PEM";

IotDevice device("Розетка", "1.0.0");

IotProperty& power = device.addBool("power").onSet([](IotProperty&, const String& v) {
  digitalWrite(LED_PIN, v == "true" ? HIGH : LOW);
  return true;
});
IotProperty& uptime = device.addInt("uptime", "s");

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

  if (!device.begin()) Serial.println("Ошибки конфигурации — см. сообщения [iot] ОШИБКА выше");
  power.setBool(false);
}

void loop() {
  device.loop();

  // В режиме портала мигаем светодиодом
  if (device.state() == IotDevice::State::Portal) {
    digitalWrite(LED_PIN, (millis() / 250) % 2 ? HIGH : LOW);
  }

  static uint32_t last = 0;
  if (device.online() && millis() - last >= 30000) {
    last = millis();
    uptime.setInt(millis() / 1000);
  }
}
