#pragma once
#include "WiFiClientSecure.h"
class HTTPClient {
 public:
  bool begin(NetworkClient& client, String url) { (void)client; (void)url; return true; }
  void end() {}
  void addHeader(const String& name, const String& value, bool first = false, bool replace = true) { (void)name; (void)value; (void)first; (void)replace; }
  void setConnectTimeout(int32_t) {}
  void setTimeout(uint16_t) {}
  int POST(String payload) { (void)payload; return -1; }
  String getString() { return String(); }
};
