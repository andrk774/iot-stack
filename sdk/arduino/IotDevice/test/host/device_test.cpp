// Поведенческие тесты IotDevice: настоящий код SDK и настоящий PubSubClient против симулятора
// (время, Wi-Fi, NVS, HTTP, поддельный MQTT-брокер, веб-сервер портала). make device
#include <cstdio>
#include <string>

#include "IotDevice.h"
#include "Sim.h"

static int failures = 0;
#define CHECK(cond)                                                                 \
  do {                                                                              \
    if (!(cond)) {                                                                  \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);                   \
      failures++;                                                                   \
    }                                                                               \
  } while (0)

static const std::string ID = "d0123456789abcdef";
static const std::string T = "dev/" + ID + "/";

struct LogCapture : public Stream {
  std::string text;
  size_t write(uint8_t c) override { text += (char)c; return 1; }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  bool has(const std::string& s) const { return text.find(s) != std::string::npos; }
};

static void freshWorld() {
  sim.reset();
  web = SimWeb();
}

// настроенное и привязанное устройство (формат 0.2: учётка одной записью)
static void provisionedNvs() {
  sim.nvs["ssid"] = "home";
  sim.nvs["wpass"] = "password1";
  sim.nvs["host"] = "iot.test";
  sim.nvs["port"] = "8883";
  sim.nvs["cred"] = ID + "\nmqtt-pass\n";
}

static void run(IotDevice& dev, int steps = 300) {
  for (int i = 0; i < steps; i++) {
    dev.loop();
    sim.millis += 10;
  }
}

static bool contains(const std::string& s, const std::string& sub) { return s.find(sub) != std::string::npos; }

// 1. Недопустимые и повторяющиеся свойства: ошибки видны, в $meta и в MQTT не попадают
static void testInvalidProperties() {
  freshWorld();
  provisionedNvs();
  IotDevice dev("Тест", "1.0");
  IotProperty& bad = dev.addFloat("Temp/#1");
  IotProperty& t = dev.addFloat("t", "°C", 1);
  IotProperty& dup = dev.addInt("t");
  LogCapture log;
  dev.setDebug(&log);  // как в скетчах: уже после объявления свойств
  dev.setInsecure();

  CHECK(!dev.begin());
  CHECK(dev.configErrors().size() == 2);
  CHECK(log.has("ОШИБКА: свойство 'Temp/#1'"));
  CHECK(log.has("объявлено дважды"));
  CHECK(!bad.valid() && t.valid() && !dup.valid());

  bad.setFloat(1);
  t.setFloat(21.44);
  dup.setInt(5);
  sim.wifiUp = true;
  run(dev);
  CHECK(dev.online());
  const SimPublish* meta = sim.last(T + "$meta");
  CHECK(meta && contains(meta->payload, "\"t\":{\"type\":\"float\""));
  CHECK(meta && !contains(meta->payload, "Temp") && !contains(meta->payload, "integer"));
  for (const auto& p : sim.published) {
    CHECK(p.topic.find_first_of("+#") == std::string::npos);
    CHECK(!contains(p.topic, "Temp"));
  }
  CHECK(sim.last(T + "t") && sim.last(T + "t")->payload == "21.4");
  dup.setInt(7);  // дубль не должен перетереть значение t
  run(dev, 10);
  CHECK(sim.last(T + "t")->payload == "21.4");
}

// 2. startPortal: сначала retained "disconnected", потом DISCONNECT; STA молчит, пока открыт портал
static void testStartPortal() {
  freshWorld();
  provisionedNvs();
  IotDevice dev("Тест", "1.0");
  dev.addBool("relay");
  dev.setInsecure();
  dev.setPortal("password1", 1);
  CHECK(dev.begin());
  sim.wifiUp = true;
  run(dev);
  CHECK(dev.online());

  sim.events.clear();
  dev.startPortal();
  CHECK(sim.events.size() == 2 && sim.events[0] == "pub:" + T + "$state" && sim.events[1] == "disconnect");
  const SimPublish* st = sim.last(T + "$state");
  CHECK(st && st->payload == "disconnected" && st->retain);
  CHECK(dev.state() == IotDevice::State::Portal);
  CHECK(sim.softApOn && sim.softApPass == "password1");
  CHECK(sim.wifiDisconnects >= 1 && !sim.autoReconnect);

  // таймаут портала (1 с): STA снова подключается, устройство возвращается в сеть
  run(dev, 150);
  CHECK(!sim.softApOn && sim.autoReconnect);
  sim.wifiUp = true;
  run(dev);
  CHECK(dev.online());
  CHECK(sim.last(T + "$state")->payload == "ready");
}

// 3. Учётка одной записью; при первой загрузке NVS не спрашивают об отсутствующих ключах
static void testCredentials() {
  freshWorld();
  sim.nvs["ssid"] = "home";
  sim.nvs["host"] = "iot.test";
  sim.httpBody = "{\"device_id\":\"" + ID + "\",\"mqtt\":{\"username\":\"" + ID + "\",\"password\":\"p4ss\"}}";
  {
    IotDevice dev("Тест", "1.0");
    dev.setClaimToken("claim-token-123456");
    dev.setInsecure();
    dev.begin();
    CHECK(sim.nvsMissingReads == 0);
    sim.wifiUp = true;
    run(dev);
    CHECK(dev.online());
    CHECK(sim.httpPosts == 1 && contains(sim.httpLastBody, "claim-token-123456"));
    CHECK(sim.nvs.count("cred") == 1 && sim.nvs["cred"] == ID + "\np4ss\nclaim-token-123456");
    CHECK(sim.nvs.count("id") == 0 && sim.nvs.count("mpass") == 0 && sim.nvs.count("claimUsed") == 0);
    CHECK(sim.lastUser == ID && sim.lastPass == "p4ss" && sim.lastClientId == ID);
    CHECK(sim.willTopic == T + "$state" && sim.willPayload == "lost");
  }
  {  // «перезагрузка» с тем же токеном в прошивке: повторной привязки нет
    sim.published.clear();
    IotDevice dev("Тест", "1.0");
    dev.setClaimToken("claim-token-123456");
    dev.setInsecure();
    dev.begin();
    run(dev);
    CHECK(dev.online() && sim.httpPosts == 1);
  }
  {  // учётка в формате 0.1.x (три записи) читается
    freshWorld();
    sim.nvs["ssid"] = "home";
    sim.nvs["host"] = "iot.test";
    sim.nvs["id"] = ID;
    sim.nvs["mpass"] = "old-pass";
    IotDevice dev("Тест", "1.0");
    dev.setInsecure();
    dev.begin();
    CHECK(sim.nvsMissingReads == 0);
    sim.wifiUp = true;
    run(dev);
    CHECK(dev.online() && sim.lastPass == "old-pass" && sim.httpPosts == 0);
  }
}

// 4. publishState принимает только ready/sleeping/alert
static void testPublishState() {
  freshWorld();
  provisionedNvs();
  IotDevice dev("Тест", "1.0");
  dev.setInsecure();
  dev.begin();
  sim.wifiUp = true;
  run(dev);
  CHECK(dev.publishState("sleeping"));
  CHECK(sim.last(T + "$state")->payload == "sleeping");
  CHECK(!dev.publishState("lost") && !dev.publishState("init") && !dev.publishState("disconnected"));
  CHECK(!dev.publishState(nullptr));
  CHECK(sim.last(T + "$state")->payload == "sleeping");
}

// 5. Портал: обработчики один раз, SSID с пробелами, сброс пароля Wi-Fi, проверки формы
static void testPortalForm() {
  freshWorld();
  sim.nvs["wpass"] = "old-password";  // сервер не задан — портал откроется, а пароль есть что сбрасывать
  IotDevice dev("Тест", "1.0");
  dev.setPortal("short");  // меньше 8 символов — ошибка конфигурации
  CHECK(!dev.begin());
  CHECK(dev.state() == IotDevice::State::Portal);
  CHECK(sim.softApOn && sim.softApPass.empty());
  CHECK(web.onCalls == 3);

  web.args = {{"ssid", "x"}, {"wpass", "123"}, {"host", "iot.test"}, {"port", "8883"}};
  web.routes["/save"]();
  CHECK(web.lastCode == 400 && contains(web.lastBody, "не короче 8"));

  web.args = {{"ssid", " Дача 5G "}, {"wpass", ""}, {"wopen", "1"}, {"host", " iot.test "}, {"port", "8883"}, {"claim", "tok-123"}};
  web.routes["/save"]();
  CHECK(web.lastCode == 200);
  run(dev, 5);
  CHECK(sim.restarted);
  CHECK(sim.nvs["ssid"] == " Дача 5G ");
  CHECK(sim.nvs["wpass"].empty());
  CHECK(sim.nvs["host"] == "iot.test");
  CHECK(sim.nvs["claim"] == "tok-123");
}

static void testPortalReopen() {
  freshWorld();
  provisionedNvs();
  sim.nvs["wpass"] = "old-password";
  IotDevice dev("Тест", "1.0");
  dev.setInsecure();
  dev.setPortal("password1", 1);
  dev.begin();
  sim.wifiUp = true;
  run(dev);
  dev.startPortal();
  run(dev, 150);  // таймаут, портал закрыт
  sim.wifiUp = true;
  run(dev);
  dev.startPortal();  // второй раз
  CHECK(web.onCalls == 3);
  // пустой пароль без флажка — пароль не меняется
  web.args = {{"ssid", "home"}, {"wpass", ""}, {"host", "iot.test"}, {"port", "8883"}};
  web.routes["/save"]();
  run(dev, 5);
  CHECK(sim.nvs["wpass"] == "old-password");
}

// 6. $meta больше 8 КБ: ошибка видна, $meta не отправляется, устройство всё равно в сети
static void testMetaTooLarge() {
  freshWorld();
  provisionedNvs();
  IotDevice dev("Тест", "1.0");
  static char names[80][32];
  for (int i = 0; i < 80; i++) {
    std::snprintf(names[i], sizeof(names[i]), "sensor_with_long_name_%02d", i);
    dev.addFloat(names[i], "очень длинная единица измерения", 2).range(-1000, 1000);
  }
  dev.setInsecure();
  LogCapture log;
  dev.setDebug(&log);
  CHECK(!dev.begin());
  CHECK(log.has("$meta") && log.has("больше 8192"));
  sim.wifiUp = true;
  run(dev);
  CHECK(dev.online());
  CHECK(sim.last(T + "$meta") == nullptr);
}

// 7. Команды: приведение типа, диапазон, отказ обработчика
static void testCommands() {
  freshWorld();
  provisionedNvs();
  IotDevice dev("Тест", "1.0");
  int calls = 0;
  IotProperty& level = dev.addInt("level").range(0, 100).onSet([&](IotProperty&, const String& v) {
    calls++;
    return v != "13";
  });
  level.setInt(50);
  dev.setInsecure();
  dev.begin();
  sim.wifiUp = true;
  run(dev);
  CHECK(sim.subscribed.size() == 1 && sim.subscribed[0] == T + "+/set");
  sim.sendToDevice(T + "level/set", "70");
  run(dev, 3);
  CHECK(calls == 1 && sim.last(T + "level")->payload == "70");
  sim.sendToDevice(T + "level/set", "150");  // вне диапазона — до обработчика не доходит
  run(dev, 3);
  CHECK(calls == 1 && sim.last(T + "level")->payload == "70");
  sim.sendToDevice(T + "level/set", "13");  // обработчик отказал — серверу уходит прежнее
  run(dev, 3);
  CHECK(calls == 2 && sim.last(T + "level")->payload == "70" && level.value() == "70");
}

int main() {
  testInvalidProperties();
  testStartPortal();
  testCredentials();
  testPublishState();
  testPortalForm();
  testPortalReopen();
  testMetaTooLarge();
  testCommands();
  if (failures) {
    std::printf("%d check(s) failed\n", failures);
    return 1;
  }
  std::printf("all device behaviour tests passed\n");
  return 0;
}
