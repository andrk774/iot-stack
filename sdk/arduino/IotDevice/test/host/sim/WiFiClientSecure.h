#pragma once
// TCP-клиент, за которым сидит поддельный MQTT-брокер (MQTT 3.1.1, только то, что шлёт PubSubClient).
#include "Client.h"
#include "Sim.h"
class NetworkClient : public Client {
 public:
  int connect(IPAddress, uint16_t) override { return open(); }
  int connect(const char*, uint16_t) override { return open(); }
  size_t write(uint8_t b) override { return write(&b, 1); }
  size_t write(const uint8_t* buf, size_t size) override;
  int available() override { return _open ? (int)sim.rx.size() : 0; }
  int read() override {
    if (!available()) return -1;
    uint8_t c = (uint8_t)sim.rx[0]; sim.rx.erase(0, 1); return c;
  }
  int read(uint8_t* buf, size_t size) override { size_t n = 0; while (n < size && available()) buf[n++] = (uint8_t)read(); return (int)n; }
  int peek() override { return available() ? (uint8_t)sim.rx[0] : -1; }
  void flush() override {}
  void stop() override { _open = false; }
  uint8_t connected() override { return _open ? 1 : 0; }
  operator bool() override { return _open; }
 private:
  int open() { if (!sim.brokerUp) return 0; _open = true; _in.clear(); sim.rx.clear(); return 1; }
  void handle(uint8_t type, const std::string& body);
  bool _open = false;
  std::string _in;
};
class NetworkClientSecure : public NetworkClient {
 public:
  void setInsecure() {}
  void setCACert(const char* rootCA) { (void)rootCA; }
};
typedef NetworkClientSecure WiFiClientSecure;
