#include "IotStorage.h"

#if !defined(ESP32)
#include <LittleFS.h>

#include "IotProtocol.h"

// Последняя строка полностью записанного файла. Основной файл появляется только атомарным
// rename из .tmp, поэтому он всегда целый; маркер нужен, чтобы отличить целый .tmp от оборванного.
static const char kEnd[] = "#end\n";

static bool readAll(const std::string& path, String& out) {
  File f = LittleFS.open(path.c_str(), "r");
  if (!f) return false;
  out = f.readString();
  f.close();
  return true;
}

static bool complete(const String& text) {
  const std::string t = text.c_str();
  const size_t n = sizeof(kEnd) - 1;
  return t.size() >= n && t.compare(t.size() - n, n, kEnd) == 0;
}

bool IotStorage::begin(const char* name, bool) {
  _path = std::string("/") + name + ".cfg";
  if (!LittleFS.begin()) {
    // первый запуск: файловой системы ещё нет
    if (!LittleFS.format() || !LittleFS.begin()) return false;
  }
  _ok = true;
  String text;
  const std::string tmp = _path + ".tmp";
  if (readAll(_path, text)) {
    _kv = iot::kvDecode(text.c_str());  // строка "#end" без '=' декодером пропускается
  } else if (readAll(tmp, text) && complete(text)) {
    // основной файл пропал (так могла оставить прошивка 0.1.x при сбое питания), а .tmp целый
    _kv = iot::kvDecode(text.c_str());
    LittleFS.rename(tmp.c_str(), _path.c_str());
  }
  return true;
}

bool IotStorage::save() {
  if (!_ok) return false;
  const std::string tmp = _path + ".tmp";
  File f = LittleFS.open(tmp.c_str(), "w");
  if (!f) return false;
  const std::string text = iot::kvEncode(_kv) + kEnd;
  size_t n = f.print(text.c_str());
  f.close();
  if (n != text.size()) return false;
  // rename в littlefs заменяет существующий файл атомарно: в любой момент на флеше есть
  // либо старая, либо новая версия. remove() перед ним оставлял окно, когда файла нет вовсе.
  return LittleFS.rename(tmp.c_str(), _path.c_str());
}

bool IotStorage::isKey(const char* key) { return _kv.count(key) > 0; }

String IotStorage::getString(const char* key, String defaultValue) {
  auto it = _kv.find(key);
  return it == _kv.end() ? defaultValue : String(it->second.c_str());
}

size_t IotStorage::putString(const char* key, const String& value) {
  _kv[key] = value.c_str();
  return save() ? value.length() : 0;
}

uint16_t IotStorage::getUShort(const char* key, uint16_t defaultValue) {
  auto it = _kv.find(key);
  if (it == _kv.end()) return defaultValue;
  long long n = 0;
  return iot::parseInt(it->second, n) && n >= 0 && n <= 65535 ? static_cast<uint16_t>(n) : defaultValue;
}

size_t IotStorage::putUShort(const char* key, uint16_t value) {
  _kv[key] = iot::formatInt(value);
  return save() ? 2 : 0;
}

bool IotStorage::clear() {
  _kv.clear();
  if (!_ok) return false;
  LittleFS.remove(_path.c_str());
  return true;
}
#endif
