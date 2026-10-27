#pragma once
#include "Arduino.h"
class Preferences {
 public:
  bool begin(const char* name, bool readOnly = false, const char* partition_label = NULL) { (void)name; (void)readOnly; (void)partition_label; return true; }
  void end() {}
  bool clear() { return true; }
  bool isKey(const char* key) { (void)key; return false; }
  size_t putString(const char* key, const char* value) { (void)key; return strlen(value); }
  size_t putString(const char* key, String value) { (void)key; return value.length(); }
  size_t putUShort(const char* key, uint16_t value) { (void)key; (void)value; return 2; }
  uint16_t getUShort(const char* key, uint16_t defaultValue = 0) { (void)key; return defaultValue; }
  String getString(const char* key, String defaultValue = String()) { (void)key; return defaultValue; }
};
