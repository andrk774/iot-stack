#pragma once
// BearSSL-вариант ESP8266: нет setCACert, есть setTrustAnchors(X509List*)
#include "Client.h"
class WiFiClient : public Client {
 public:
  int connect(IPAddress, uint16_t) override { return 0; }
  int connect(const char*, uint16_t) override { return 0; }
  size_t write(uint8_t) override { return 1; }
  size_t write(const uint8_t*, size_t s) override { return s; }
  int available() override { return 0; }
  int read() override { return -1; }
  int read(uint8_t*, size_t) override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
  void stop() override {}
  uint8_t connected() override { return 0; }
  operator bool() override { return false; }
};
namespace BearSSL {
class X509List {
 public:
  explicit X509List(const char* pem) { (void)pem; }
};
class WiFiClientSecure : public WiFiClient {
 public:
  void setInsecure() {}
  void setTrustAnchors(const X509List* ta) { (void)ta; }
  void setBufferSizes(int recv, int xmit) { (void)recv; (void)xmit; }
};
}  // namespace BearSSL
using namespace BearSSL;
