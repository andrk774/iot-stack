// Юнит-тесты протокола на ПК:  make -C test/host
#include <cstdio>
#include <string>

#include "IotProtocol.h"

using namespace iot;

static int failures = 0;
#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);       \
      failures++;                                                       \
    }                                                                   \
  } while (0)
#define CHECK_EQ(a, b)                                                                        \
  do {                                                                                        \
    std::string _a = (a), _b = (b);                                                           \
    if (_a != _b) {                                                                           \
      std::printf("FAIL %s:%d  %s\n   got:      %s\n   expected: %s\n", __FILE__, __LINE__, \
                  #a, _a.c_str(), _b.c_str());                                                \
      failures++;                                                                             \
    }                                                                                         \
  } while (0)

static const std::string ID = "d0123456789abcdef";

static void testNames() {
  CHECK(isValidPropName("temperature"));
  CHECK(isValidPropName("relay_1"));
  CHECK(isValidPropName("a-b"));
  CHECK(!isValidPropName(""));
  CHECK(!isValidPropName("Temp"));
  CHECK(!isValidPropName("1st"));
  CHECK(!isValidPropName("a/b"));
  CHECK(!isValidPropName("$state"));
  CHECK(!isValidPropName(std::string(33, 'a')));
  CHECK(isValidPropName(std::string(32, 'a')));

  CHECK(isValidDeviceId(ID));
  CHECK(!isValidDeviceId("d0123456789ABCDEF"));
  CHECK(!isValidDeviceId("x0123456789abcdef"));
  CHECK(!isValidDeviceId("d0123"));

  CHECK(isValidState("ready"));
  CHECK(!isValidState("hacked"));
}

static void testTopics() {
  CHECK_EQ(topic(ID, "temp"), "dev/" + ID + "/temp");
  std::string p;
  CHECK(parseSetTopic("dev/" + ID + "/relay/set", ID, p));
  CHECK_EQ(p, "relay");
  CHECK(!parseSetTopic("dev/" + ID + "/relay", ID, p));
  CHECK(!parseSetTopic("dev/dfedcba9876543210/relay/set", ID, p));
  CHECK(!parseSetTopic("dev/" + ID + "/a/b/set", ID, p));
  CHECK(!parseSetTopic("dev/" + ID + "//set", ID, p));
  CHECK(!parseSetTopic("dev/" + ID + "/Relay/set", ID, p));
}

static void testParsing() {
  bool b = false;
  CHECK(parseBool(" ON ", b) && b);
  CHECK(parseBool("0", b) && !b);
  CHECK(parseBool("false", b) && !b);
  CHECK(!parseBool("maybe", b));

  long long n = 0;
  CHECK(parseInt("42", n) && n == 42);
  CHECK(parseInt(" -7 ", n) && n == -7);
  CHECK(!parseInt("4.2", n));
  CHECK(!parseInt("-", n));
  CHECK(!parseInt("0x10", n));
  CHECK(!parseInt("99999999999999999999", n));

  double d = 0;
  CHECK(parseFloat("21.5", d) && d == 21.5);
  CHECK(parseFloat("-1e3", d) && d == -1000);
  CHECK(!parseFloat("inf", d));
  CHECK(!parseFloat("nan", d));
  CHECK(!parseFloat("0x1p3", d));
  CHECK(!parseFloat("1e999", d));
  CHECK(!parseFloat(".", d));

  CHECK_EQ(formatFloat(21.456, 1), "21.5");
  CHECK_EQ(formatFloat(-0.001, 2), "0.00");
  CHECK_EQ(formatFloat(3, 0), "3");
  CHECK_EQ(formatFloat(1.0 / 0.0, 2), "");
  CHECK_EQ(formatInt(-123), "-123");
}

static void testNormalize() {
  PropSpec relay;
  relay.type = PropType::Boolean;
  std::string out;
  CHECK(normalizeValue(relay, "on", out));
  CHECK_EQ(out, "true");
  CHECK(!normalizeValue(relay, "2", out));

  PropSpec level;
  level.type = PropType::Integer;
  level.hasRange = true;
  level.min = 0;
  level.max = 100;
  CHECK(normalizeValue(level, "100", out));
  CHECK_EQ(out, "100");
  CHECK(!normalizeValue(level, "101", out));
  CHECK(!normalizeValue(level, "50.5", out));

  PropSpec target;
  target.type = PropType::Float;
  target.decimals = 1;
  CHECK(normalizeValue(target, "21.47", out));
  CHECK_EQ(out, "21.5");

  PropSpec text;
  text.type = PropType::String;
  CHECK(normalizeValue(text, "hello", out));
  CHECK(!normalizeValue(text, std::string(300, 'x'), out));
}

static void testJson() {
  CHECK_EQ(jsonEscape("a\"b\\c\nd\x01"), "a\\\"b\\\\c\\nd\\u0001");
  CHECK_EQ(htmlEscape("<a href='x'>&</a>"), "&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;");

  std::vector<PropSpec> props(2);
  props[0].name = "temperature";
  props[0].type = PropType::Float;
  props[0].unit = "°C";
  props[1].name = "level";
  props[1].type = PropType::Integer;
  props[1].settable = true;
  props[1].hasRange = true;
  props[1].min = 0;
  props[1].max = 10.5;
  CHECK_EQ(buildMeta("Кухня \"1\"", "1.0", props),
           "{\"name\":\"Кухня \\\"1\\\"\",\"fw\":\"1.0\",\"props\":{"
           "\"temperature\":{\"type\":\"float\",\"unit\":\"°C\"},"
           "\"level\":{\"type\":\"integer\",\"settable\":true,\"min\":0,\"max\":10.5}}}");
  CHECK_EQ(buildMeta("x", "", {}), "{\"name\":\"x\",\"fw\":\"\",\"props\":{}}");
  CHECK_EQ(buildProvisionRequest("ab\"c"), "{\"claim_token\":\"ab\\\"c\"}");

  // ответ сервера как в backend/src/routes/public.js
  const std::string resp =
      "{\"device_id\":\"d0123456789abcdef\",\"base_topic\":\"dev/d0123456789abcdef\","
      "\"mqtt\":{\"host\":\"iot.test\",\"port\":8883,\"tls\":true,\"client_id\":\"d0123456789abcdef\","
      "\"username\":\"d0123456789abcdef\",\"password\":\"Ab-_09\\/x\"}}";
  std::string v;
  CHECK(jsonGetString(resp, "device_id", v));
  CHECK_EQ(v, ID);
  CHECK(jsonGetString(resp, "password", v));
  CHECK_EQ(v, "Ab-_09/x");
  CHECK(!jsonGetString(resp, "port", v));     // не строка
  CHECK(!jsonGetString(resp, "missing", v));
  CHECK(jsonGetString("{\"a\" : \"x\\u0041\"}", "a", v));
  CHECK_EQ(v, "xA");
  CHECK(!jsonGetString("{\"a\":\"unterminated", "a", v));
}

static void testKv() {
  std::map<std::string, std::string> kv = {
      {"ssid", "Дом = 5G"}, {"wpass", "a\\b\nc\rd"}, {"empty", ""}, {"port", "8883"}};
  const std::string text = kvEncode(kv);
  CHECK(text.find('\r') == std::string::npos);
  CHECK(kvDecode(text) == kv);
  auto m = kvDecode("broken\n=nokey\nk=v\n");
  CHECK(m.size() == 1);
  CHECK_EQ(m["k"], "v");
}

int main() {
  testKv();
  testNames();
  testTopics();
  testParsing();
  testNormalize();
  testJson();
  if (failures) {
    std::printf("%d check(s) failed\n", failures);
    return 1;
  }
  std::printf("all protocol tests passed\n");
  return 0;
}
