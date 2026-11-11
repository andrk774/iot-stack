// Поведенческие тесты IotDevice: настоящий код SDK и настоящий PubSubClient против симулятора
// (время, Wi-Fi, NVS, HTTP, поддельный MQTT-брокер, веб-сервер портала). make device
#include <cstdio>
#include <algorithm>
#include <string>
#include <vector>

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
    if (sim.restarted) break;  // на железе после ESP.restart() код дальше не выполняется
    dev.loop();
    sim.millis += 10;
  }
}

static bool contains(const std::string& s, const std::string& sub) { return s.find(sub) != std::string::npos; }

// значение из записи настроек портала "cfg"
static std::string cfg(const std::string& key) {
  auto kv = iot::kvDecode(sim.nvs["cfg"]);
  return kv.count(key) ? kv[key] : std::string("<нет>");
}

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
  CHECK(cfg("ssid") == " Дача 5G ");
  CHECK(cfg("wpass").empty() && sim.nvs.count("cfg") == 1);
  CHECK(cfg("host") == "iot.test");
  CHECK(cfg("claim") == "tok-123");
  CHECK(cfg("port") == "8883");
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
  CHECK(cfg("wpass") == "old-password");
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

static int count(const std::string& topic) {
  int n = 0;
  for (const auto& p : sim.published) n += p.topic == topic;
  return n;
}

// 8. deadband и minInterval: лишнее не уходит, отложенное не теряется, подтверждения команд — сразу
static void testRateLimit() {
  freshWorld();
  provisionedNvs();
  IotDevice dev("Тест", "1.0");
  IotProperty& t = dev.addFloat("t", "°C", 1).deadband(0.2).minInterval(1000);
  IotProperty& door = dev.addBool("door").deadband(0);
  IotProperty& plain = dev.addInt("plain");
  IotProperty& level = dev.addInt("level").minInterval(60000).onSet([](IotProperty&, const String&) { return true; });
  t.setFloat(20.0);
  door.setBool(false);
  level.setInt(1);
  dev.setInsecure();
  dev.begin();
  sim.wifiUp = true;
  run(dev);
  CHECK(dev.online());
  CHECK(count(T + "t") == 1 && count(T + "door") == 1 && count(T + "level") == 1);
  run(dev, 200);  // minInterval после подключения истёк

  t.setFloat(20.1);  // меньше deadband — не отправляется, но value() текущее
  run(dev, 10);
  CHECK(count(T + "t") == 1 && t.value() == "20.1");
  t.setFloat(20.3);  // 0.3 от отправленного 20.0 — сразу
  CHECK(count(T + "t") == 2 && sim.last(T + "t")->payload == "20.3");
  t.setFloat(20.6);  // прошло меньше 1 с — откладывается
  run(dev, 50);
  CHECK(count(T + "t") == 2);
  t.setFloat(20.8);  // отложенное заменяется свежим
  run(dev, 60);
  CHECK(count(T + "t") == 3 && sim.last(T + "t")->payload == "20.8");
  t.setFloat(20.7);  // снова в пределах deadband — и отложенного нет
  run(dev, 200);
  CHECK(count(T + "t") == 3 && t.value() == "20.7");

  door.setBool(false);  // deadband(0): без изменения не отправляем
  door.setBool(true);
  CHECK(count(T + "door") == 2);

  plain.setInt(5);  // без настроек — как раньше, каждый вызов
  plain.setInt(5);
  CHECK(count(T + "plain") == 2);

  sim.sendToDevice(T + "level/set", "7");  // подтверждение команды не ждёт minInterval
  run(dev, 3);
  CHECK(count(T + "level") == 2 && sim.last(T + "level")->payload == "7");
}

// 9. persist: значение переживает перезагрузку, обработчик выставляет «железо», флеш не трётся зря
static void testPersist() {
  freshWorld();
  provisionedNvs();
  std::string hw;  // что обработчик «выставил на пин»
  auto handler = [&](IotProperty&, const String& v) {
    hw = v.c_str();
    return true;
  };
  {
    IotDevice dev("Тест", "1.0");
    IotProperty& relay = dev.addBool("relay").persist().onSet(handler);
    dev.addFloat("target", "°C", 1).range(5, 30).persist().onSet(handler);
    relay.setBool(false);  // значение по умолчанию до begin() — во флеш не пишется
    dev.setInsecure();
    dev.begin();
    CHECK(sim.nvs.count("pv") == 0 && hw.empty());
    sim.wifiUp = true;
    run(dev);
    sim.sendToDevice(T + "relay/set", "on");
    run(dev, 3);
    sim.sendToDevice(T + "target/set", "22.5");
    run(dev, 3);
    CHECK(sim.nvs["pv"] == "relay=true\ntarget=22.5\n");
    const int writes = sim.nvsWrites;
    sim.sendToDevice(T + "relay/set", "true");  // то же значение — флеш не трогаем
    run(dev, 3);
    CHECK(sim.nvsWrites == writes);
  }
  {  // «перезагрузка»; в новой прошивке диапазон target сузили до 5..20
    sim.published.clear();
    hw.clear();
    IotDevice dev("Тест", "1.0");
    IotProperty& relay = dev.addBool("relay").persist().onSet(handler);
    IotProperty& target = dev.addFloat("target", "°C", 1).range(5, 20).persist().onSet(handler);
    relay.setBool(false);
    dev.setInsecure();
    dev.begin();
    CHECK(relay.boolValue() && hw == "true");
    CHECK(!target.hasValue());  // 22.5 вне нового диапазона — не восстановлено
    run(dev);
    CHECK(sim.last(T + "relay") && sim.last(T + "relay")->payload == "true");
    CHECK(sim.last(T + "target") == nullptr);
  }
}

// 10. enableStats: служебные свойства в $meta, периодическая отправка, редкие — только при изменении
static void testStats() {
  freshWorld();
  provisionedNvs();
  IotDevice dev("Тест", "1.0");
  dev.enableStats(60);
  dev.setInsecure();
  CHECK(dev.begin());
  sim.wifiUp = true;
  run(dev);
  CHECK(dev.online());
  const SimPublish* meta = sim.last(T + "$meta");
  CHECK(meta && contains(meta->payload, "\"free_heap\":{\"type\":\"integer\",\"unit\":\"B\"}"));
  CHECK(meta && contains(meta->payload, "\"reset_reason\":{\"type\":\"string\"}"));
  CHECK(sim.last(T + "rssi") && sim.last(T + "rssi")->payload == "-60");
  CHECK(sim.last(T + "free_heap") && sim.last(T + "free_heap")->payload == "150000");
  CHECK(sim.last(T + "reset_reason") && sim.last(T + "reset_reason")->payload == "power_on");
  CHECK(sim.last(T + "ip") && sim.last(T + "ip")->payload == "192.168.4.1");

  const int rssi = count(T + "rssi");
  sim.freeHeap = 120000;
  run(dev, 6100);  // 61 с
  CHECK(count(T + "rssi") == rssi + 1);
  CHECK(sim.last(T + "free_heap")->payload == "120000");
  CHECK(count(T + "reset_reason") == 1 && count(T + "ip") == 1);
  CHECK(sim.last(T + "uptime")->payload == "60");  // первая отправка — при подключении, сразу после старта

  dev.enableStats(10);  // после begin() — ошибка конфигурации
  CHECK(dev.configErrors().size() == 1);
}

// 11. uptime не сбрасывается при переполнении millis() (49 дней)
static void testUptimeWrap() {
  freshWorld();
  provisionedNvs();
  sim.millis = 0xFFFFFFFFUL - 30000;  // за 30 с до переполнения
  IotDevice dev("Тест", "1.0");
  dev.enableStats(60);
  dev.setInsecure();
  dev.begin();
  sim.wifiUp = true;
  run(dev, 6500);  // 65 с: переполнение посередине, вторая отправка статистики — уже после него
  // millis()/1000 дал бы ~35 с; накопительный счётчик продолжает с ~4294937 с
  CHECK(count(T + "uptime") == 2 && std::stoll(sim.last(T + "uptime")->payload) >= 4294990);
}

// 12. Брокер 5 раз подряд отверг учётку — портал с объяснением; сама учётка не стёрта
static void testAuthRejectsOpenPortal() {
  freshWorld();
  provisionedNvs();
  sim.connack = 5;  // not authorized
  IotDevice dev("Тест", "1.0");
  dev.setInsecure();
  dev.begin();
  sim.wifiUp = true;
  run(dev, 1000);  // попытки через 1, 2, 4, 8 с
  CHECK(dev.state() == IotDevice::State::MqttConnecting);
  run(dev, 2500);
  CHECK(dev.state() == IotDevice::State::Portal);
  CHECK(sim.connects == 5);
  CHECK(sim.nvs.count("cred") == 1);
  web.routes["/"]();
  CHECK(contains(web.lastBody, "отклоняет учётку") && contains(web.lastBody, ID));
}

// 13. Настройки из портала — одной записью; старые отдельные ключи читаются
static void testConfigSingleRecord() {
  freshWorld();
  provisionedNvs();  // формат 0.2/0.3: ssid, wpass, host, port отдельными ключами
  sim.nvs["port"] = "1883";
  IotDevice dev("Тест", "1.0");
  dev.setInsecure();
  dev.setPortal("password1");
  dev.begin();
  sim.wifiUp = true;
  run(dev);
  CHECK(dev.online() && sim.lastClientId == ID);
  dev.startPortal();
  web.routes["/"]();
  CHECK(contains(web.lastBody, "value='1883'"));
  const int writes = sim.nvsWrites;
  web.args = {{"ssid", "home2"}, {"wpass", "password2"}, {"host", "iot2.test"}, {"port", "8884"}};
  web.routes["/save"]();
  run(dev, 1);  // один шаг: на плате ESP.restart() не возвращается, а в симуляторе loop() сохранил бы снова
  CHECK(sim.nvsWrites == writes + 1);
  CHECK(cfg("ssid") == "home2" && cfg("wpass") == "password2" && cfg("host") == "iot2.test" && cfg("port") == "8884");
}

// 14. Запасная Wi-Fi сеть: основная недоступна — через 20 с устройство уходит на запасную
static void testWifiFallback() {
  freshWorld();
  provisionedNvs();
  sim.reachableSsid = "backup";
  IotDevice dev("Тест", "1.0");
  dev.setInsecure();
  dev.setWiFiFallback("backup", "password2");
  dev.begin();
  CHECK(sim.wifiSsid == "home");
  run(dev, 1900);
  CHECK(!dev.online() && sim.wifiSsid == "home");
  run(dev, 300);
  CHECK(sim.wifiSsid == "backup");
  run(dev);
  CHECK(dev.online());
}

// 15. Портал: причина, ID/MAC/прошивка, список сетей без дублей и скрытых, запасная сеть
static void testPortalPage() {
  freshWorld();
  sim.scanResults = {{"Home", -70}, {"Office", -50}, {"Home", -80}, {"", -30}};
  sim.scanDone = false;
  IotDevice dev("Тест", "2.1");
  dev.setPortal("password1");
  dev.begin();
  CHECK(dev.state() == IotDevice::State::Portal && sim.scanStarts == 1);
  web.routes["/"]();
  CHECK(contains(web.lastBody, "Не задана Wi-Fi сеть"));
  CHECK(contains(web.lastBody, "AA:BB:CC:DD:EE:FF") && contains(web.lastBody, "2.1 (SDK "));
  CHECK(contains(web.lastBody, "не привязано") && contains(web.lastBody, "Идёт поиск"));
  sim.scanDone = true;
  run(dev, 2);
  web.routes["/"]();
  const std::string& b = web.lastBody;
  CHECK(contains(b, "<option value='Office'><option value='Home'></datalist>"));  // сильные первыми, без дублей
  CHECK(!contains(b, "<option value=''>") && !contains(b, "Идёт поиск"));
  web.args = {{"scan", "1"}};
  web.routes["/"]();
  CHECK(sim.scanStarts == 2);

  web.args = {{"ssid", "Home"}, {"wpass", "password1"}, {"ssid2", "Office"}, {"wpass2", "short"}, {"host", "iot.test"}, {"port", "8883"}};
  web.routes["/save"]();
  CHECK(web.lastCode == 400 && contains(web.lastBody, "запасной"));
  web.args["wpass2"] = "office-pass";
  web.routes["/save"]();
  run(dev, 5);
  CHECK(cfg("ssid2") == "Office" && cfg("wpass2") == "office-pass");
}

// 16. Глубокий сон: отложенное значение уходит сразу, затем sleeping и штатное отключение
static void testDeepSleep() {
  freshWorld();
  provisionedNvs();
  IotDevice dev("Тест", "1.0");
  IotProperty& t = dev.addFloat("t", "°C", 1).minInterval(60000);
  t.setFloat(20);
  dev.setInsecure();
  dev.begin();
  sim.wifiUp = true;
  run(dev);
  CHECK(dev.online() && !dev.pending());
  t.setFloat(25);  // minInterval держит
  CHECK(dev.pending() && sim.last(T + "t")->payload == "20.0");
  sim.events.clear();
  dev.deepSleep(300);
  CHECK(sim.last(T + "t")->payload == "25.0");
  CHECK(sim.events.size() == 3 && sim.events[0] == "pub:" + T + "t" && sim.events[1] == "pub:" + T + "$state" &&
        sim.events[2] == "disconnect");
  CHECK(sim.last(T + "$state")->payload == "sleeping" && sim.last(T + "$state")->retain);
  CHECK(sim.slept && sim.sleepUs == 300000000ULL);
}

// 17. Служебные команды: identify, неизвестная команда, reboot после подтверждения
static void testServiceCommands() {
  freshWorld();
  provisionedNvs();
  IotDevice dev("Тест", "1.0");
  int identified = 0;
  dev.enableCommands();
  dev.setInsecure();
  dev.begin();
  sim.wifiUp = true;
  run(dev);
  const SimPublish* meta = sim.last(T + "$meta");
  CHECK(meta && contains(meta->payload, "\"cmd\":{\"type\":\"string\",\"settable\":true,\"enum\":[\"reboot\",\"portal\",\"reset\",\"identify\"]}"));

  sim.sendToDevice(T + "cmd/set", "identify");  // обработчика нет — отказ
  run(dev, 3);
  CHECK(sim.last(T + "cmd") == nullptr);
  dev.onIdentify([&] { identified++; });
  sim.sendToDevice(T + "cmd/set", "identify");
  run(dev, 3);
  CHECK(identified == 1 && sim.last(T + "cmd")->payload == "identify");
  sim.sendToDevice(T + "cmd/set", "dance");
  run(dev, 3);
  CHECK(sim.last(T + "cmd")->payload == "identify" && !sim.restarted);

  sim.events.clear();
  sim.sendToDevice(T + "cmd/set", "reboot");
  run(dev, 3);
  CHECK(sim.restarted);
  CHECK(sim.events.size() >= 3 && sim.events[0] == "pub:" + T + "cmd" && sim.events[1] == "pub:" + T + "$state" &&
        sim.events[2] == "disconnect");
  CHECK(sim.nvs.count("cred") == 1);  // reboot настройки не трогает
}

// 18. OTA: retained-команда, скачивание, MD5, отчёт после перезагрузки, защита от повторов
static const std::string JOB = "0b8f7c1e-3a2d-4c5b-9e8f-1a2b3c4d5e6f";
static const std::string MD5 = "0123456789abcdef0123456789abcdef";
static std::string otaCmd(const std::string& job, const std::string& version, size_t size, const std::string& path = "/api/ota/tok_123") {
  return "{\"job\":\"" + job + "\",\"path\":\"" + path + "\",\"size\":" + std::to_string(size) +
         ",\"md5\":\"" + MD5 + "\",\"version\":\"" + version + "\"}";
}
static std::vector<std::string> otaReports() {
  std::vector<std::string> r;
  for (const auto& p : sim.published) if (p.topic == T + "$ota") r.push_back(p.payload);
  return r;
}
static bool startsOnline(IotDevice& dev) {
  dev.setInsecure();
  dev.begin();
  sim.wifiUp = true;
  run(dev);
  return dev.online();
}

static void testOta() {
  // выключено в прошивке: отказ один раз, повторная доставка retained-команды — без повторного отказа
  freshWorld();
  provisionedNvs();
  {
    IotDevice dev("Тест", "1.0");
    CHECK(startsOnline(dev));
    sim.sendToDevice(T + "$ota/set", otaCmd(JOB, "2.0", 3000));
    run(dev, 5);
    CHECK(otaReports().size() == 1 && contains(otaReports()[0], "\"failed\"") && contains(otaReports()[0], "enableOta"));
    sim.sendToDevice(T + "$ota/set", otaCmd(JOB, "2.0", 3000));
    run(dev, 5);
    CHECK(otaReports().size() == 1 && sim.httpGets == 0);
  }

  // успешное обновление
  freshWorld();
  provisionedNvs();
  sim.otaBody = std::string(3000, '\xe9');
  {
    IotDevice dev("Тест", "1.0");
    int rebootCb = 0;
    dev.enableOta();
    dev.onOtaReboot([&]() { rebootCb++; });
    CHECK(startsOnline(dev));
    sim.sendToDevice(T + "$ota/set", otaCmd(JOB, "2.0", 3000, "https://evil.example/x.bin"));  // чужой адрес — игнор
    run(dev, 5);
    CHECK(sim.httpGets == 0 && otaReports().empty());
    sim.sendToDevice(T + "$ota/set", otaCmd(JOB, "2.0", 3000));
    run(dev, 5);
    CHECK(sim.httpGets == 1 && sim.httpLastUrl == "https://iot.test/api/ota/tok_123");
    CHECK(sim.updateBeginSize == 3000 && sim.updateMd5 == MD5 && sim.updateWritten == sim.otaBody);
    auto r = otaReports();
    CHECK(r.size() >= 3 && contains(r.front(), "\"downloading\",\"progress\":0") && contains(r.back(), "\"rebooting\""));
    CHECK(sim.updateProgressCalls >= 2);
    CHECK(sim.nvs["otaVer"] == "2.0" && sim.nvs["otaJob"] == JOB);
    CHECK(sim.restarted && rebootCb == 1);
    CHECK(sim.last(T + "$state")->payload == "disconnected");
  }
  {  // «перезагрузка» в новую прошивку: отчёт done, retained-команда больше не выполняется
    sim.published.clear();
    sim.restarted = false;
    IotDevice dev("Тест", "2.0");
    dev.enableOta();
    CHECK(startsOnline(dev));
    auto r = otaReports();
    CHECK(r.size() == 1 && contains(r[0], "\"done\"") && contains(r[0], JOB));
    CHECK(sim.nvs.count("otaVer") == 0);
    sim.sendToDevice(T + "$ota/set", otaCmd(JOB, "2.0", 3000));
    run(dev, 5);
    CHECK(sim.httpGets == 1 && otaReports().size() == 1 && !sim.restarted);
  }

  // загрузчик откатил прошивку: после перезагрузки версия старая — failed
  freshWorld();
  provisionedNvs();
  sim.nvs["otaJob"] = JOB;
  sim.nvs["otaVer"] = "2.0";
  {
    IotDevice dev("Тест", "1.0");
    CHECK(startsOnline(dev));
    auto r = otaReports();
    CHECK(r.size() == 1 && contains(r[0], "\"failed\"") && contains(r[0], "ожидалась 2.0"));
  }

  // ошибка MD5: не перезагружается, остаётся в сети, следующее задание выполняется
  freshWorld();
  provisionedNvs();
  sim.otaBody = std::string(2048, 'x');
  sim.updateEndOk = false;
  {
    IotDevice dev("Тест", "1.0");
    dev.enableOta();
    CHECK(startsOnline(dev));
    sim.sendToDevice(T + "$ota/set", otaCmd(JOB, "2.0", 2048));
    run(dev, 5);
    CHECK(!sim.restarted && dev.online() && sim.updateEnded);
    CHECK(contains(otaReports().back(), "MD5 Check Failed"));
    CHECK(sim.nvs.count("otaVer") == 0);
    sim.updateEndOk = true;
    const std::string job2 = "1b8f7c1e-3a2d-4c5b-9e8f-1a2b3c4d5e6f";
    sim.sendToDevice(T + "$ota/set", otaCmd(job2, "2.0", 2048));
    run(dev, 5);
    CHECK(sim.restarted && contains(otaReports().back(), "rebooting"));
  }

  // размер не совпал / HTTP-ошибка / та же версия
  freshWorld();
  provisionedNvs();
  sim.otaBody = std::string(2048, 'x');
  {
    IotDevice dev("Тест", "1.0");
    dev.enableOta();
    CHECK(startsOnline(dev));
    sim.otaSizeOverride = 1000;
    sim.sendToDevice(T + "$ota/set", otaCmd("2b8f7c1e-3a2d-4c5b-9e8f-1a2b3c4d5e6f", "2.0", 2048));
    run(dev, 5);
    CHECK(contains(otaReports().back(), "размер 1000") && sim.updateBeginSize == 0);
    sim.otaSizeOverride = -1;
    sim.otaCode = 404;
    sim.sendToDevice(T + "$ota/set", otaCmd("3b8f7c1e-3a2d-4c5b-9e8f-1a2b3c4d5e6f", "2.0", 2048));
    run(dev, 5);
    CHECK(contains(otaReports().back(), "HTTP 404"));
    const int gets = sim.httpGets;
    sim.sendToDevice(T + "$ota/set", otaCmd("4b8f7c1e-3a2d-4c5b-9e8f-1a2b3c4d5e6f", "1.0", 2048));
    run(dev, 5);
    CHECK(sim.httpGets == gets && contains(otaReports().back(), "\"done\""));
    CHECK(!sim.restarted && dev.online());
  }
}

// 18a. onOtaStart: приложение отказалось — образ не скачивается, итог failed, задание не повторяется
static void testOtaRefused() {
  freshWorld();
  provisionedNvs();
  sim.otaBody = std::string(3000, '\xe9');
  IotDevice dev("Тест", "1.0");
  int asked = 0;
  dev.enableOta();
  dev.onOtaStart([&]() { asked++; return false; });
  CHECK(startsOnline(dev));
  sim.sendToDevice(T + "$ota/set", otaCmd(JOB, "2.0", 3000));
  run(dev, 5);
  CHECK(asked == 1 && sim.httpGets == 0 && !sim.restarted);
  CHECK(otaReports().size() == 1 && contains(otaReports()[0], "\"failed\"") && contains(otaReports()[0], "onOtaStart"));
  sim.sendToDevice(T + "$ota/set", otaCmd(JOB, "2.0", 3000));  // retained пришла снова — уже обработано
  run(dev, 5);
  CHECK(asked == 1 && otaReports().size() == 1);
}

// 19. enum: команды и setString вне списка отклоняются
static void testEnumProperty() {
  freshWorld();
  provisionedNvs();
  IotDevice dev("Тест", "1.0");
  IotProperty& mode = dev.addEnum("mode", {"off", "heat"}).onSet([](IotProperty&, const String&) { return true; });
  IotProperty& bad = dev.addEnum("bad", {});
  mode.setString("off");
  dev.setInsecure();
  CHECK(!dev.begin() && !bad.valid() && dev.configErrors().size() == 1);
  sim.wifiUp = true;
  run(dev);
  sim.sendToDevice(T + "mode/set", "boost");
  run(dev, 3);
  CHECK(mode.value() == "off" && sim.last(T + "mode")->payload == "off");
  sim.sendToDevice(T + "mode/set", "heat");
  run(dev, 3);
  CHECK(mode.value() == "heat");
  mode.setString("turbo");
  CHECK(mode.value() == "heat" && sim.last(T + "mode")->payload == "heat");
}

int main() {
  testAuthRejectsOpenPortal();
  testConfigSingleRecord();
  testWifiFallback();
  testPortalPage();
  testDeepSleep();
  testServiceCommands();
  testOta();
  testOtaRefused();
  testEnumProperty();
  testRateLimit();
  testPersist();
  testStats();
  testUptimeWrap();
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
