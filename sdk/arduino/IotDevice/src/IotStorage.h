// Хранилище настроек с интерфейсом Preferences: на ESP32 — NVS, на ESP8266 — файл в LittleFS.
#pragma once

#include <Arduino.h>

#if defined(ESP32)
#include <Preferences.h>
using IotStorage = Preferences;
#else
#include <map>
#include <string>

class IotStorage {
 public:
  bool begin(const char* name, bool readOnly = false);
  bool isKey(const char* key);
  String getString(const char* key, String defaultValue = String());
  size_t putString(const char* key, const String& value);
  uint16_t getUShort(const char* key, uint16_t defaultValue = 0);
  size_t putUShort(const char* key, uint16_t value);
  bool clear();

 private:
  bool save();
  std::string _path;
  std::map<std::string, std::string> _kv;
  bool _ok = false;
};
#endif
