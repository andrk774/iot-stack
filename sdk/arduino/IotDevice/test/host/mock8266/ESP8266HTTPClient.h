#pragma once
#include "WiFiClientSecure.h"
// на ESP8266 нет setConnectTimeout
class HTTPClient {
 public:
  bool begin(WiFiClient& client, const String& url) { (void)client; (void)url; return true; }
  void end() {}
  void addHeader(const String& name, const String& value, bool first = false, bool replace = true) { (void)name; (void)value; (void)first; (void)replace; }
  void setTimeout(uint16_t) {}
  int POST(const String& payload) { (void)payload; return -1; }
  String getString() { return String(); }
  int GET() { return -1; }
  int getSize() { return -1; }
  WiFiClient* getStreamPtr() { return &_stream; }
 private:
  WiFiClient _stream;
};
