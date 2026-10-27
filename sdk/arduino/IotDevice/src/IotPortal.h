// Портал первичной настройки: точка доступа + веб-форма (Wi-Fi, сервер, claim-токен).
#pragma once

#include "IotPlatform.h"

struct IotConfig {
  String ssid;
  String wifiPass;
  String host;
  uint16_t port = 8883;
  String claimToken;
};

class IotPortal {
 public:
  IotPortal() : _server(80) {}

  // current — значения для подстановки в форму
  void begin(const String& apName, const String& apPassword, const IotConfig& current, const String& deviceName);
  // true, когда пользователь сохранил форму; результат — в saved()
  bool loop();
  void end();
  bool active() const { return _active; }
  const IotConfig& saved() const { return _saved; }

 private:
  void handleRoot();
  void handleSave();
  void redirectToRoot();

  IotWebServer _server;
  DNSServer _dns;
  IotConfig _current;
  IotConfig _saved;
  String _deviceName;
  bool _active = false;
  bool _done = false;
  bool _routes = false;
};
