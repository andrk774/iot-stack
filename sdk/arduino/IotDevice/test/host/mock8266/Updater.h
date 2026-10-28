#pragma once
// ESP8266 core: UpdaterClass (только то, что использует SDK)
#include <functional>
#include "Arduino.h"
class UpdaterClass {
 public:
  using THandlerFunction_Progress = std::function<void(size_t, size_t)>;
  bool begin(size_t size, int command = 0, int ledPin = -1, uint8_t ledOn = LOW) { (void)size; (void)command; (void)ledPin; (void)ledOn; return false; }
  bool setMD5(const char* expected_md5) { (void)expected_md5; return true; }
  size_t writeStream(Stream& data) { (void)data; return 0; }
  bool end(bool evenIfRemaining = false) { (void)evenIfRemaining; return false; }
  String getErrorString() const { return String("mock"); }
  UpdaterClass& onProgress(THandlerFunction_Progress fn) { (void)fn; return *this; }
};
extern UpdaterClass Update;
