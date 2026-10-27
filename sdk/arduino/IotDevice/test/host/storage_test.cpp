// IotStorage для ESP8266 поверх LittleFS (в памяти): запись, чтение после «перезагрузки», очистка,
// атомарность записи и восстановление после сбоя питания.
#include <cassert>
#include <cstdio>
#include <string>

#include "IotStorage.h"
#include <LittleFS.h>

static bool endsWith(const std::string& s, const std::string& suf) {
  return s.size() >= suf.size() && s.compare(s.size() - suf.size(), suf.size(), suf) == 0;
}

int main() {
  {
    IotStorage s;
    assert(s.begin("iotdev"));
    assert(!s.isKey("ssid"));
    s.putString("ssid", String("Дом\nWiFi"));
    s.putUShort("port", 8883);
    s.putString("mpass", String("p=ss\\word"));
  }
  assert(LittleFS.files.count("/iotdev.cfg") == 1);
  assert(LittleFS.files.count("/iotdev.cfg.tmp") == 0);
  assert(endsWith(LittleFS.files["/iotdev.cfg"], "#end\n"));
  // основной файл ни разу не удалялся: в любой момент на флеше есть целая версия
  for (const auto& op : LittleFS.ops) assert(op != "remove:/iotdev.cfg");
  {
    IotStorage s;  // новая «загрузка»
    assert(s.begin("iotdev"));
    assert(s.isKey("ssid"));
    assert(s.getString("ssid") == "Дом\nWiFi");
    assert(s.getUShort("port", 1) == 8883);
    assert(s.getUShort("missing", 7) == 7);
    assert(s.getString("mpass") == "p=ss\\word");
    assert(s.getString("nope", String("def")) == "def");
    assert(!s.isKey("#end"));
  }

  // сбой питания в прошивке 0.1.x: основной файл удалён, целый .tmp остался — настройки спасаются
  const std::string full = LittleFS.files["/iotdev.cfg"];
  LittleFS.files.erase("/iotdev.cfg");
  LittleFS.files["/iotdev.cfg.tmp"] = full;
  {
    IotStorage s;
    assert(s.begin("iotdev"));
    assert(s.getString("mpass") == "p=ss\\word");
    assert(LittleFS.files.count("/iotdev.cfg") == 1 && LittleFS.files.count("/iotdev.cfg.tmp") == 0);
  }

  // оборванный .tmp (питание пропало во время записи) не используется: пароль мог обрезаться
  LittleFS.files.erase("/iotdev.cfg");
  LittleFS.files["/iotdev.cfg.tmp"] = full.substr(0, full.size() - 12);
  {
    IotStorage s;
    assert(s.begin("iotdev"));
    assert(!s.isKey("ssid") && !s.isKey("mpass"));
  }

  // а при живом основном файле оборванный .tmp просто игнорируется
  LittleFS.files["/iotdev.cfg"] = full;
  {
    IotStorage s;
    assert(s.begin("iotdev"));
    assert(s.getString("mpass") == "p=ss\\word");
    s.clear();
    assert(!s.isKey("ssid"));
  }
  IotStorage s;
  s.begin("iotdev");
  assert(!s.isKey("ssid"));
  std::printf("esp8266 storage test passed\n");
  return 0;
}
