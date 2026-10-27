#include "Arduino.h"
#include "WiFi.h"
#include "WiFiClientSecure.h"
#include "Sim.h"

Sim sim;
SimWeb web;
HardwareSerial Serial;
WiFiClass WiFi;
EspClass ESP;
String IPAddress::toString() const { return String("192.168.4.1"); }
unsigned long millis() { return sim.millis; }
void delay(uint32_t ms) { sim.millis += ms; }
void yield() { sim.millis += 1; }
void pinMode(uint8_t, uint8_t) {}
int digitalRead(uint8_t) { return HIGH; }
void digitalWrite(uint8_t, uint8_t) {}
long random(long a, long) { return a; }
float temperatureRead() { return 40.0f; }
void configTime(long, int, const char*, const char*, const char*) {}
void EspClass::restart() { sim.restarted = true; }

static std::string u16str(const std::string& b, size_t& i) {
  size_t n = ((uint8_t)b[i] << 8) | (uint8_t)b[i + 1];
  std::string s = b.substr(i + 2, n);
  i += 2 + n;
  return s;
}

static std::string packet(uint8_t header, const std::string& body) {
  std::string out(1, (char)header);
  size_t n = body.size();
  do { uint8_t d = n % 128; n /= 128; if (n) d |= 0x80; out += (char)d; } while (n);
  return out + body;
}

void Sim::sendToDevice(const std::string& topic, const std::string& payload) {
  std::string body;
  body += (char)(topic.size() >> 8);
  body += (char)(topic.size() & 0xff);
  body += topic + payload;
  rx += packet(0x30, body);
}

size_t NetworkClient::write(const uint8_t* buf, size_t size) {
  if (!_open) return 0;
  _in.append((const char*)buf, size);
  for (;;) {  // разбираем все целые пакеты
    if (_in.size() < 2) break;
    size_t len = 0, mul = 1, i = 1;
    bool done = false;
    for (; i < _in.size() && i < 5; i++) {
      len += ((uint8_t)_in[i] & 0x7f) * mul;
      mul *= 128;
      if (!((uint8_t)_in[i] & 0x80)) { done = true; i++; break; }
    }
    if (!done || _in.size() < i + len) break;
    uint8_t h = (uint8_t)_in[0];
    std::string body = _in.substr(i, len);
    _in.erase(0, i + len);
    handle(h, body);
  }
  return size;
}

void NetworkClient::handle(uint8_t h, const std::string& b) {
  uint8_t type = h >> 4;
  if (type == 1) {  // CONNECT
    size_t i = 0;
    u16str(b, i);            // "MQTT"
    i += 1;                  // level
    uint8_t flags = (uint8_t)b[i++];
    i += 2;                  // keepalive
    sim.lastClientId = u16str(b, i);
    if (flags & 0x04) { sim.willTopic = u16str(b, i); sim.willPayload = u16str(b, i); }
    if (flags & 0x80) sim.lastUser = u16str(b, i);
    if (flags & 0x40) sim.lastPass = u16str(b, i);
    sim.connects++;
    sim.rx += std::string("\x20\x02\x00", 3) + (char)sim.connack;
    if (sim.connack != 0) _open = false;
  } else if (type == 3) {  // PUBLISH
    size_t i = 0;
    std::string topic = u16str(b, i);
    if ((h >> 1) & 3) i += 2;  // packet id
    sim.published.push_back({topic, b.substr(i), (h & 1) != 0});
    sim.events.push_back("pub:" + topic);
  } else if (type == 8) {  // SUBSCRIBE
    size_t i = 2;
    std::string id = b.substr(0, 2);
    while (i < b.size()) { sim.subscribed.push_back(u16str(b, i)); i++; }
    sim.rx += packet(0x90, id + std::string("\x01", 1));
  } else if (type == 12) {  // PINGREQ
    sim.rx += std::string("\xd0\x00", 2);
  } else if (type == 14) {  // DISCONNECT
    sim.disconnects++;
    sim.events.push_back("disconnect");
    _open = false;
  }
}
