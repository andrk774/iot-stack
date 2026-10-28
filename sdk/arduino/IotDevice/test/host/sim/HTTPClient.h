#pragma once
#include "WiFiClientSecure.h"
// тело ответа GET читается как поток
class SimBodyStream : public NetworkClient {
 public:
  void reset() { _pos = 0; }
  int available() override { return (int)(sim.otaBody.size() - _pos); }
  int read() override { return _pos < sim.otaBody.size() ? (uint8_t)sim.otaBody[_pos++] : -1; }
  int read(uint8_t* buf, size_t size) override { size_t n = 0; while (n < size && available()) buf[n++] = (uint8_t)read(); return (int)n; }
  int peek() override { return _pos < sim.otaBody.size() ? (uint8_t)sim.otaBody[_pos] : -1; }
 private:
  size_t _pos = 0;
};
class HTTPClient {
 public:
  bool begin(NetworkClient& client, String url) { (void)client; _url = url.c_str(); return true; }
  int GET() { sim.httpGets++; sim.httpLastUrl = _url; _body.reset(); return sim.otaCode; }
  int getSize() { return sim.otaSizeOverride >= 0 ? (int)sim.otaSizeOverride : (int)sim.otaBody.size(); }
  NetworkClient* getStreamPtr() { return &_body; }
  void end() {}
  void addHeader(const String& name, const String& value, bool first = false, bool replace = true) { (void)name; (void)value; (void)first; (void)replace; }
  void setConnectTimeout(int32_t) {}
  void setTimeout(uint16_t) {}
  int POST(String payload) { sim.httpPosts++; sim.httpLastBody = payload.c_str(); return sim.httpCode; }
  String getString() { return String(sim.httpBody.c_str()); }
 private:
  std::string _url;
  SimBodyStream _body;
};
