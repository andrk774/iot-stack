// Минимальные заглушки Arduino/ESP32 — только для проверки компиляции SDK на ПК.
// Сигнатуры повторяют arduino-esp32 3.x для используемых функций.
#pragma once
#include <algorithm>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>

using std::max;
using std::min;
typedef bool boolean;
typedef uint8_t byte;

#define LOW 0x0
#define HIGH 0x1
#define INPUT 0x01
#define OUTPUT 0x03
#define INPUT_PULLUP 0x05
#define INPUT_PULLDOWN_16 0x04

class __FlashStringHelper;
#define pgm_read_byte_near(p) (*(const uint8_t*)(p))
#define F(s) (reinterpret_cast<const __FlashStringHelper*>(s))

class String {
 public:
  String() {}
  String(const char* s) : _s(s ? s : "") {}
  String(const __FlashStringHelper* s) : _s(reinterpret_cast<const char*>(s)) {}
  String(char c) : _s(1, c) {}
  String(int v) : _s(std::to_string(v)) {}
  String(unsigned int v) : _s(std::to_string(v)) {}
  String(long v) : _s(std::to_string(v)) {}
  String(unsigned long v) : _s(std::to_string(v)) {}
  String(double v, unsigned int decimals = 2) { char b[40]; snprintf(b, sizeof b, "%.*f", (int)decimals, v); _s = b; }
  const char* c_str() const { return _s.c_str(); }
  unsigned int length() const { return _s.size(); }
  bool isEmpty() const { return _s.empty(); }
  bool reserve(unsigned int n) { _s.reserve(n); return true; }
  void trim() { size_t b = _s.find_first_not_of(" \t\r\n"); size_t e = _s.find_last_not_of(" \t\r\n"); _s = b == std::string::npos ? "" : _s.substr(b, e - b + 1); }
  long toInt() const { return atol(_s.c_str()); }
  void replace(const char* f, const char* r) { size_t p = 0, fl = strlen(f); while ((p = _s.find(f, p)) != std::string::npos) { _s.replace(p, fl, r); p += strlen(r); } }
  String substring(unsigned int from) const { return String(_s.substr(std::min<size_t>(from, _s.size())).c_str()); }
  void toLowerCase() { for (auto& c : _s) c = tolower(c); }
  String& operator+=(const String& o) { _s += o._s; return *this; }
  String& operator+=(const char* o) { _s += o; return *this; }
  String& operator+=(const __FlashStringHelper* o) { _s += reinterpret_cast<const char*>(o); return *this; }
  String& operator+=(char c) { _s += c; return *this; }
  bool operator==(const String& o) const { return _s == o._s; }
  bool operator==(const char* o) const { return _s == o; }
  bool operator!=(const String& o) const { return _s != o._s; }
  bool operator!=(const char* o) const { return _s != o; }
 private:
  std::string _s;
};
inline String operator+(const String& a, const String& b) { String r = a; r += b; return r; }
inline String operator+(const String& a, const char* b) { String r = a; r += b; return r; }
inline String operator+(const char* a, const String& b) { String r(a); r += b; return r; }

class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t) = 0;
  virtual size_t write(const uint8_t* buf, size_t size) { size_t n = 0; while (size--) n += write(*buf++); return n; }
  size_t println(const char* s) { return printf("%s\n", s); }
  size_t printf(const char* fmt, ...) { char b[512]; va_list a; va_start(a, fmt); int n = vsnprintf(b, sizeof b, fmt, a); va_end(a); return write((const uint8_t*)b, n); }
};
class Stream : public Print {
 public:
  virtual int available() = 0;
  virtual int read() = 0;
  virtual int peek() = 0;
};
class HardwareSerial : public Stream {
 public:
  void begin(unsigned long) {}
  size_t write(uint8_t c) override { return fputc(c, stdout) == EOF ? 0 : 1; }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
};
extern HardwareSerial Serial;

unsigned long millis();
void delay(uint32_t ms);
void yield();
void pinMode(uint8_t pin, uint8_t mode);
int digitalRead(uint8_t pin);
void digitalWrite(uint8_t pin, uint8_t val);
long random(long min, long max);

void configTime(long gmtOffset_sec, int daylightOffset_sec, const char* server1, const char* server2 = nullptr, const char* server3 = nullptr);

class EspClass { public: void restart(); };
extern EspClass ESP;

#include "IPAddress.h"
