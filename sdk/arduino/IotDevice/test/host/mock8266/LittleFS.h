#pragma once
// FS в памяти — позволяет прогнать IotStorage на ПК
#include <map>
#include <string>
#include <vector>
#include "Arduino.h"
class File : public Stream {
 public:
  File() {}
  File(std::string* data, bool write) : _d(data), _w(write) { if (write) _d->clear(); }
  explicit operator bool() const { return _d != nullptr; }
  size_t write(uint8_t c) override { if (!_d || !_w) return 0; _d->push_back((char)c); return 1; }
  size_t write(const uint8_t* b, size_t n) override { size_t k = 0; while (n--) k += write(*b++); return k; }
  size_t print(const char* s) { return write((const uint8_t*)s, strlen(s)); }
  int available() override { return _d && _pos < _d->size() ? 1 : 0; }
  int read() override { return available() ? (uint8_t)(*_d)[_pos++] : -1; }
  int peek() override { return available() ? (uint8_t)(*_d)[_pos] : -1; }
  String readString() { std::string s = _d ? _d->substr(_pos) : ""; _pos = _d ? _d->size() : 0; return String(s.c_str()); }
  void close() { _d = nullptr; }
 private:
  std::string* _d = nullptr;
  bool _w = false;
  size_t _pos = 0;
};
class FS {
 public:
  bool begin() { return _formatted; }
  bool format() { _formatted = true; files.clear(); return true; }
  File open(const char* path, const char* mode) {
    bool w = mode[0] == 'w';
    if (!w && !files.count(path)) return File();
    return File(&files[path], w);
  }
  bool remove(const char* path) { ops.push_back(std::string("remove:") + path); return files.erase(path) > 0; }
  // как lfs_rename: существующий файл назначения заменяется атомарно
  bool rename(const char* from, const char* to) { ops.push_back(std::string("rename:") + from + "->" + to); auto it = files.find(from); if (it == files.end()) return false; files[to] = it->second; files.erase(from); return true; }
  std::map<std::string, std::string> files;
  std::vector<std::string> ops;
  bool _formatted = false;
};
extern FS LittleFS;
