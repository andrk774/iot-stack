#pragma once
// Update с записью «во флеш» в sim.updateWritten
#include <functional>
#include "Arduino.h"
#include "Sim.h"
class UpdateClass {
 public:
  using THandlerFunction_Progress = std::function<void(size_t, size_t)>;
  bool begin(size_t size, int command = 0, int ledPin = -1, uint8_t ledOn = LOW, const char* label = NULL) {
    (void)command; (void)ledPin; (void)ledOn; (void)label;
    if (_running || !sim.updateBeginOk) return false;  // как в arduino-esp32: второй begin без end не проходит
    _running = true; _size = size; sim.updateBeginSize = size; sim.updateWritten.clear(); sim.updateEnded = false;
    return true;
  }
  bool setMD5(const char* md5) { sim.updateMd5 = md5; return true; }
  size_t writeStream(Stream& data) {
    if (!_running) return 0;
    size_t n = 0;
    while (data.available() && n < _size) {
      int c = data.read();
      if (c < 0) break;
      sim.updateWritten += (char)c;
      n++;
      if (n % 1024 == 0 || n == _size) {
        if (_progress) { _progress(n, _size); sim.updateProgressCalls++; }
        if (sim.onUpdateChunk) sim.onUpdateChunk();
      }
    }
    return n;
  }
  bool end(bool evenIfRemaining = false) {
    (void)evenIfRemaining;
    bool ok = _running && sim.updateWritten.size() == _size && sim.updateEndOk;
    _running = false;
    sim.updateEnded = true;
    _err = ok ? "" : (sim.updateWritten.size() != _size ? "Not Enough Data" : "MD5 Check Failed");
    return ok;
  }
  const char* errorString() { return _err.c_str(); }
  UpdateClass& onProgress(THandlerFunction_Progress fn) { _progress = fn; return *this; }
 private:
  bool _running = false;
  size_t _size = 0;
  std::string _err;
  THandlerFunction_Progress _progress;
};
extern UpdateClass Update;
