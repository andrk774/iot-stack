#pragma once
#include <cstdint>
class String;
class IPAddress {
 public:
  IPAddress(uint32_t a = 0) : _a(a) {}
  IPAddress(uint8_t a, uint8_t b, uint8_t c, uint8_t d) : _a(a | (b << 8) | (c << 16) | ((uint32_t)d << 24)) {}
  String toString() const;
 private:
  uint32_t _a;
};
