#pragma once
// arduino-esp32 3.x: UpdateClass (только то, что использует SDK)
#include <functional>
#include "Arduino.h"
class UpdateClass {
 public:
  using THandlerFunction_Progress = std::function<void(size_t, size_t)>;
  bool begin(size_t size, int command = 0, int ledPin = -1, uint8_t ledOn = LOW, const char* label = NULL) { (void)size; (void)command; (void)ledPin; (void)ledOn; (void)label; return false; }
  bool setMD5(const char* md5) { (void)md5; return true; }
  size_t writeStream(Stream& data) { (void)data; return 0; }
  bool end(bool evenIfRemaining = false) { (void)evenIfRemaining; return false; }
  const char* errorString() { return "mock"; }
  UpdateClass& onProgress(THandlerFunction_Progress fn) { (void)fn; return *this; }
};
extern UpdateClass Update;
