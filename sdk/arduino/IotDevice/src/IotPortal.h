// Портал первичной настройки: точка доступа + веб-форма (Wi-Fi, сервер, claim-токен).
#pragma once

#include "IotPlatform.h"

#include <vector>

struct IotConfig {
  String ssid;
  String wifiPass;
  String ssid2;      // запасная сеть; пусто — нет
  String wifiPass2;
  String host;
  uint16_t port = 8883;
  String claimToken;
};

// Что показать пользователю на странице портала
struct IotPortalInfo {
  String reason;    // почему открыт портал
  String deviceId;  // пусто — ещё не привязано
  String mac;
  String firmware;
};

class IotPortal {
 public:
  IotPortal() : _server(80) {}

  // current — значения для подстановки в форму
  void begin(const String& apName, const String& apPassword, const IotConfig& current, const String& deviceName,
             const IotPortalInfo& info);
  // true, когда пользователь сохранил форму; результат — в saved()
  bool loop();
  void end();
  bool active() const { return _active; }
  const IotConfig& saved() const { return _saved; }

 private:
  void handleRoot();
  void handleSave();
  void redirectToRoot();
  void startScan();
  void collectScan();

  IotWebServer _server;
  DNSServer _dns;
  IotConfig _current;
  IotConfig _saved;
  String _deviceName;
  IotPortalInfo _info;
  std::vector<String> _networks;  // найденные сети, сильные первыми
  bool _scanning = false;
  bool _active = false;
  bool _done = false;
  bool _routes = false;
};
