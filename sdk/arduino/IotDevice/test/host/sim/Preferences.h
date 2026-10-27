#pragma once
#include "Arduino.h"
#include "Sim.h"
class Preferences {
 public:
  bool begin(const char* name, bool readOnly = false, const char* partition_label = NULL) { (void)name; (void)readOnly; (void)partition_label; return true; }
  void end() {}
  bool clear() { sim.nvs.clear(); return true; }
  bool isKey(const char* key) { return sim.nvs.count(key) > 0; }
  size_t putString(const char* key, const char* value) { sim.nvs[key] = value; return strlen(value); }
  size_t putString(const char* key, String value) { sim.nvs[key] = value.c_str(); return value.length(); }
  size_t putUShort(const char* key, uint16_t value) { sim.nvs[key] = std::to_string(value); return 2; }
  uint16_t getUShort(const char* key, uint16_t defaultValue = 0) {
    auto it = sim.nvs.find(key);
    if (it == sim.nvs.end()) { sim.nvsMissingReads++; return defaultValue; }
    return (uint16_t)atoi(it->second.c_str());
  }
  String getString(const char* key, String defaultValue = String()) {
    auto it = sim.nvs.find(key);
    if (it == sim.nvs.end()) { sim.nvsMissingReads++; return defaultValue; }
    return String(it->second.c_str());
  }
};
