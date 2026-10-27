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

IotProperty& temperature = device.addFloat("temperature", "°C", 1);
IotProperty& heating = device.addBool("heating");

// Значения вне 5..30 SDK отклонит сам, ещё до вызова обработчика
IotProperty& target = device.addFloat("target", "°C", 1).range(5, 30).onSet(
    [](IotProperty&, const String& v) {
      Serial.printf("новая уставка: %s\n", v.c_str());
      return true;
    });

// Строковое свойство: проверяем допустимые значения сами
IotProperty& mode = device.addString("mode").onSet([](IotProperty&, const String& v) {
  bool ok = v == "off" || v == "heat" || v == "eco";
  if (!ok) Serial.printf("неизвестный режим: %s\n", v.c_str());
  return ok;  // false -> серверу вернётся прежнее значение
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
  if (!device.begin()) Serial.println("Ошибки конфигурации — см. сообщения [iot] ОШИБКА выше");

  target.setFloat(21.0);
  mode.setString("heat");
  heating.setBool(false);
}

void loop() {
  device.loop();

  static uint32_t last = 0;
  if (millis() - last < 15000) return;
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
