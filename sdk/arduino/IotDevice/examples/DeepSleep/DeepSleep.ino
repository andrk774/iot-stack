// Датчик на батарейке: проснуться, измерить, отправить, уснуть на 5 минут.
//
// Устройство почти всё время спит, поэтому:
//   - после отправки публикуется $state = sleeping, а не lost: сервер видит, что это плановый сон;
//   - если сеть или сервер недоступны, через 30 секунд всё равно засыпаем, чтобы не разрядить батарею.
// ESP8266: для пробуждения по таймеру соедините GPIO16 (D0) с RST.
#include <IotDevice.h>

const uint32_t SLEEP_SEC = 300;
const uint32_t AWAKE_LIMIT_MS = 30000;

static const char CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
PASTE_CERTIFICATE_HERE
-----END CERTIFICATE-----
)PEM";

IotDevice device("Датчик на балконе", "1.0.0");

IotProperty& temperature = device.addFloat("temperature", "°C", 1);
IotProperty& battery = device.addFloat("battery", "V", 2);

float readTemperature() { return 21.5f; }  // замените на свой датчик
float readBattery() { return 3.9f; }       // например, analogRead через делитель

void setup() {
  Serial.begin(115200);
  device.setDebug(&Serial);
  device.setWiFi("your-wifi", "your-password");
  device.setServer("iot.example.com");
  device.setClaimToken("");
  device.setCaCert(CA_CERT);
  device.setPortal("change-me-1234");

  // Измеряем до подключения: значения уйдут сразу, как только устройство окажется онлайн
  temperature.setFloat(readTemperature());
  battery.setFloat(readBattery());
  device.begin();
}

void loop() {
  device.loop();

  // Онлайн и всё отправлено — спать. В портале не засыпаем: пользователь вводит настройки.
  const bool done = device.online() && !device.pending();
  const bool timeout = millis() > AWAKE_LIMIT_MS && device.state() != IotDevice::State::Portal;
  if (done || timeout) device.deepSleep(SLEEP_SEC);
}
