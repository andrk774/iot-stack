// Протокол платформы без зависимостей от Arduino — тестируется на ПК.
//
//   dev/<id>/$state       init | ready | lost | sleeping | alert   (retained)
//   dev/<id>/$meta        JSON-описание свойств (retained)
//   dev/<id>/<prop>       значение свойства
//   dev/<id>/<prop>/set   команда от сервера
#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace iot {

enum class PropType : uint8_t { Boolean, Integer, Float, String };

const char* typeName(PropType t);

struct PropSpec {
  std::string name;
  PropType type = PropType::String;
  std::string unit;
  bool settable = false;
  bool hasRange = false;
  double min = 0;
  double max = 0;
  int decimals = 2;  // для Float
};

constexpr size_t kMaxValueLen = 256;  // лимит ingest
constexpr size_t kMaxMetaLen = 8192;  // лимит ingest/retainer

bool isValidPropName(const std::string& s);   // ^[a-z][a-z0-9_-]{0,31}$
bool isValidDeviceId(const std::string& s);   // ^d[0-9a-f]{16}$
bool isValidState(const std::string& s);

std::string topic(const std::string& deviceId, const std::string& leaf);
// "dev/<id>/<prop>/set" -> prop
bool parseSetTopic(const std::string& topic, const std::string& deviceId, std::string& prop);

std::string trim(const std::string& s);
std::string toLower(const std::string& s);

bool parseBool(const std::string& raw, bool& out);       // true/false, 1/0, on/off, yes/no
bool parseInt(const std::string& raw, long long& out);   // только десятичные
bool parseFloat(const std::string& raw, double& out);    // без inf/nan/hex

std::string formatInt(long long v);
std::string formatFloat(double v, int decimals);         // "" для inf/nan

// Привести присланное сервером значение к каноническому виду с учётом типа и диапазона.
bool normalizeValue(const PropSpec& spec, const std::string& raw, std::string& out);

std::string jsonEscape(const std::string& s);
std::string htmlEscape(const std::string& s);
std::string buildMeta(const std::string& name, const std::string& fw, const std::vector<PropSpec>& props);
std::string buildProvisionRequest(const std::string& claimToken);
// Достаёт строковое значение по ключу из плоского/вложенного JSON (первое вхождение).
bool jsonGetString(const std::string& json, const std::string& key, std::string& out);

// Настройки "ключ=значение" построчно, с экранированием \\ \n \r (файл настроек на ESP8266)
std::string kvEncode(const std::map<std::string, std::string>& kv);
std::map<std::string, std::string> kvDecode(const std::string& text);

}  // namespace iot
