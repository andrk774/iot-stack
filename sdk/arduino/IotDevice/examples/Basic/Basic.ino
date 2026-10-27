// Минимальный пример: датчик + реле, настройки зашиты в прошивку.
// claim_token берётся из POST /api/devices (действует 30 минут, нужен только для первой привязки).
#include <IotDevice.h>

const int RELAY_PIN = 2;

// Let's Encrypt: ISRG Root X1  ->  curl -s https://letsencrypt.org/certs/isrgrootx1.pem
// Самоподписанный: data/certbot/conf/live/iot/fullchain.pem с сервера
static const char CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
PASTE_CERTIFICATE_HERE
-----END CERTIFICATE-----
)PEM";

IotDevice device("Кухня", "1.0.0");

#if defined(ESP32)
IotProperty& chipTemp = device.addFloat("chip_temp", "°C", 1);  // встроенный датчик есть только у ESP32
#endif
IotProperty& uptime = device.addInt("uptime", "s");
IotProperty& rssi = device.addInt("rssi", "dBm");
IotProperty& relay = device.addBool("relay").onSet([](IotProperty&, const String& v) {
  digitalWrite(RELAY_PIN, v == "true" ? HIGH : LOW);
  return true;  // принять: SDK запомнит значение и отправит его серверу
});

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);

  device.setDebug(&Serial);
  device.setWiFi("your-wifi", "your-password");
  device.setServer("iot.example.com");  // = PUBLIC_HOST из .env
  device.setClaimToken("");             // вставьте claim_token
  device.setCaCert(CA_CERT);
  // портал откроется, если Wi-Fi не подключится за минуту; без пароля точка доступа открытая
  device.setPortal("change-me-1234");  // замените: от 8 символов, латиница и цифры
  if (!device.begin()) Serial.println("Ошибки конфигурации — см. сообщения [iot] ОШИБКА выше");

  relay.setBool(false);  // начальное состояние уйдёт на сервер при подключении
}

void loop() {
  device.loop();

  static uint32_t last = 0;
  if (millis() - last >= 10000) {
    last = millis();
#if defined(ESP32)
    chipTemp.setFloat(temperatureRead());
#endif
    rssi.setInt(WiFi.RSSI());
    uptime.setInt(millis() / 1000);
  }
}
