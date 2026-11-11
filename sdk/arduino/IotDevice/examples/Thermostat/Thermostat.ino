// Термостат: настраиваемая уставка с диапазоном, режим строкой, отказ от команды.
//
// Команды через API:
//   POST /api/devices/<id>/commands {"property":"target","value":22.5}
//   POST /api/devices/<id>/commands {"property":"mode","value":"heat"}
#include <IotDevice.h>

const int HEATER_PIN = 4;

static const char CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
PASTE_CERTIFICATE_HERE
-----END CERTIFICATE-----
)PEM";

IotDevice device("Термостат", "1.2.0");

// Датчик читаем часто (регулятору нужна свежая температура), а на сервер отправляем
// только изменения от 0.2 °C и не чаще раза в 10 секунд
IotProperty& temperature = device.addFloat("temperature", "°C", 1).deadband(0.2).minInterval(10000);
IotProperty& heating = device.addBool("heating");

// Значения вне 5..30 SDK отклонит сам, ещё до вызова обработчика.
// persist(): уставка и режим переживут перезагрузку
IotProperty& target = device.addFloat("target", "°C", 1).range(5, 30).persist().onSet(
    [](IotProperty&, const String& v) {
      Serial.printf("новая уставка: %s\n", v.c_str());
      return true;
    });

// Режим из фиксированного списка: другие значения SDK отклонит сам, ещё до обработчика
IotProperty& mode = device.addEnum("mode", {"off", "heat", "eco"}).persist().onSet([](IotProperty&, const String& v) {
  Serial.printf("режим: %s\n", v.c_str());
  return true;
});

float readTemperature() {
  // замените на свой датчик (DS18B20, BME280, ...)
  return 20.0f + (millis() / 1000 % 60) / 10.0f;
}

void setup() {
  Serial.begin(115200);
  pinMode(HEATER_PIN, OUTPUT);

  device.setDebug(&Serial);
  device.setWiFi("your-wifi", "your-password");
  device.setServer("iot.example.com");
  device.setClaimToken("");
  device.setCaCert(CA_CERT);
  // портал откроется, если Wi-Fi не подключится за минуту; без пароля точка доступа открытая
  device.setPortal("change-me-1234");  // замените: от 8 символов, латиница и цифры

  // значения по умолчанию — до begin(): begin() заменит их сохранёнными, если такие есть
  target.setFloat(21.0);
  mode.setString("heat");
  heating.setBool(false);
  if (!device.begin()) Serial.println("Ошибки конфигурации — см. сообщения [iot] ОШИБКА выше");
}

void loop() {
  device.loop();

  static uint32_t last = 0;
  if (millis() - last < 2000) return;
  last = millis();

  float t = readTemperature();
  temperature.setFloat(t);

  // гистерезис 0.3 °C
  bool on = heating.boolValue();
  if (mode.value() == "off") on = false;
  else if (t < target.floatValue() - 0.3) on = true;
  else if (t > target.floatValue() + 0.3) on = false;

  if (on != heating.boolValue()) {
    digitalWrite(HEATER_PIN, on ? HIGH : LOW);
    heating.setBool(on);
  }
}
