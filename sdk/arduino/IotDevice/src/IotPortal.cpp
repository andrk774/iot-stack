#include "IotPortal.h"

#include <algorithm>
#include <utility>

#include "IotProtocol.h"

static String esc(const String& s) { return String(iot::htmlEscape(s.c_str()).c_str()); }

static constexpr size_t kMaxNetworks = 20;

void IotPortal::begin(const String& apName, const String& apPassword, const IotConfig& current,
                      const String& deviceName, const IotPortalInfo& info) {
  _current = current;
  _deviceName = deviceName;
  _info = info;
  _done = false;

  WiFi.mode(WIFI_AP_STA);
  // пароль точки доступа WPA2 — минимум 8 символов, иначе открытая сеть
  if (apPassword.length() >= 8) WiFi.softAP(apName.c_str(), apPassword.c_str());
  else WiFi.softAP(apName.c_str());

  _dns.setErrorReplyCode(DNSReplyCode::NoError);
  _dns.start(53, "*", WiFi.softAPIP());  // любой домен -> портал (captive portal)

  if (!_routes) {  // при повторном открытии портала обработчики не дублируем
    _server.on("/", HTTP_GET, [this]() { handleRoot(); });
    _server.on("/save", HTTP_POST, [this]() { handleSave(); });
    _server.onNotFound([this]() { redirectToRoot(); });
    _routes = true;
  }
  _server.begin();
  _active = true;
  startScan();
}

// Асинхронно: синхронный поиск занимает пару секунд, и всё это время портал не отвечал бы
void IotPortal::startScan() {
  if (_scanning) return;
  _scanning = WiFi.scanNetworks(true) == WIFI_SCAN_RUNNING;
}

void IotPortal::collectScan() {
  if (!_scanning) return;
  const int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) return;
  _scanning = false;
  if (n < 0) return;  // ошибка — оставляем прежний список
  std::vector<std::pair<int32_t, String>> found;
  for (int i = 0; i < n; i++) {
    const String ssid = WiFi.SSID(i);
    if (ssid.isEmpty()) continue;  // скрытая сеть
    bool dup = false;
    for (const auto& f : found) {
      if (f.second == ssid) { dup = true; break; }  // одна сеть с нескольких точек доступа
    }
    if (!dup) found.push_back({WiFi.RSSI(i), ssid});
  }
  WiFi.scanDelete();
  std::stable_sort(found.begin(), found.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
  _networks.clear();
  for (const auto& f : found) {
    if (_networks.size() >= kMaxNetworks) break;
    _networks.push_back(f.second);
  }
}

bool IotPortal::loop() {
  if (!_active) return false;
  _dns.processNextRequest();
  _server.handleClient();
  collectScan();
  return _done;
}

void IotPortal::end() {
  if (!_active) return;
  _server.stop();
  _dns.stop();
  if (_scanning) WiFi.scanDelete();
  _scanning = false;
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  _active = false;
}

void IotPortal::redirectToRoot() {
  _server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
  _server.send(302, "text/plain", "");
}

void IotPortal::handleRoot() {
  if (_server.hasArg("scan")) startScan();
  String html;
  html.reserve(4200);
  html += F("<!doctype html><html lang='ru'><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'><title>Настройка</title>"
            "<style>body{font:16px system-ui,sans-serif;max-width:420px;margin:24px auto;padding:0 16px}"
            "label{display:block;margin-top:14px;font-weight:600}"
            "input{width:100%;box-sizing:border-box;padding:10px;margin-top:4px;font-size:16px}"
            "button{margin-top:20px;width:100%;padding:12px;font-size:16px}"
            "small{color:#666}.info{background:#f3f3f3;padding:10px 12px;border-radius:6px;font-size:14px}"
            ".info b{display:inline-block;min-width:96px}.why{color:#a33}"
            "details{margin-top:14px}summary{cursor:pointer}</style></head><body>");
  html += "<h2>" + esc(_deviceName) + "</h2><div class='info'>";
  if (_info.reason.length()) html += "<div class='why'>" + esc(_info.reason) + "</div>";
  html += "<div><b>ID</b> " + (_info.deviceId.length() ? esc(_info.deviceId) : String("не привязано")) + "</div>";
  html += "<div><b>MAC</b> " + esc(_info.mac) + "</div>";
  html += "<div><b>Прошивка</b> " + esc(_info.firmware) + "</div></div>";

  html += F("<form method='post' action='/save'>");
  html += "<label>Wi-Fi сеть</label><input name='ssid' list='nets' required maxlength='32' value='" +
          esc(_current.ssid) + "'>";
  html += F("<datalist id='nets'>");
  for (const auto& n : _networks) html += "<option value='" + esc(n) + "'>";
  html += F("</datalist>");
  if (_scanning) html += F("<small>Идёт поиск сетей… </small>");
  else if (_networks.empty()) html += F("<small>Сети не найдены. </small>");
  html += F("<small><a href='/?scan=1'>Обновить список сетей</a></small>");
  html += F("<label>Пароль Wi-Fi</label><input name='wpass' type='password' maxlength='64' "
            "placeholder='оставьте пустым, чтобы не менять'>"
            "<label style='font-weight:400'><input type='checkbox' name='wopen' value='1' style='width:auto;margin-right:8px'>"
            "Сеть без пароля (сбросить сохранённый)</label>");
  html += F("<details");
  if (_current.ssid2.length()) html += F(" open");
  html += F("><summary>Запасная сеть</summary>");
  html += "<label>Wi-Fi сеть</label><input name='ssid2' list='nets' maxlength='32' placeholder='не задана' value='" +
          esc(_current.ssid2) + "'>";
  html += F("<label>Пароль</label><input name='wpass2' type='password' maxlength='64' "
            "placeholder='пусто — не менять (или сеть без пароля)'>"
            "<small>Если основная сеть недоступна 20 секунд, устройство пробует запасную. "
            "Очистите имя, чтобы удалить её.</small></details>");
  html += "<label>Сервер</label><input name='host' required maxlength='128' placeholder='iot.example.com' value='" +
          esc(_current.host) + "'>";
  html += "<label>MQTT порт</label><input name='port' type='number' min='1' max='65535' value='" +
          String(_current.port) + "'>";
  html += F("<label>Claim-токен</label><input name='claim' maxlength='128' autocomplete='off' "
            "placeholder='из POST /api/devices'>"
            "<small>Нужен для первой привязки или перепривязки. Пусто — оставить текущую привязку.</small>"
            "<button type='submit'>Сохранить и перезагрузить</button></form></body></html>");
  _server.send(200, "text/html; charset=utf-8", html);
}

void IotPortal::handleSave() {
  IotConfig c = _current;
  String ssid = _server.arg("ssid");
  String wpass = _server.arg("wpass");
  String ssid2 = _server.arg("ssid2");
  String wpass2 = _server.arg("wpass2");
  String host = _server.arg("host");
  String claim = _server.arg("claim");
  long port = _server.arg("port").toInt();
  const bool open = _server.hasArg("wopen");
  // SSID не обрезаем: пробелы в начале и в конце допустимы и значимы
  host.trim();
  claim.trim();

  const char* problem = nullptr;
  if (ssid.length() == 0 || ssid.length() > 32) problem = "Имя Wi-Fi сети: от 1 до 32 байт";
  else if (!open && wpass.length() > 0 && wpass.length() < 8) problem = "Пароль Wi-Fi: не короче 8 символов";
  else if (wpass.length() > 64) problem = "Пароль Wi-Fi: не длиннее 64 символов";
  else if (ssid2.length() > 32) problem = "Запасная сеть: имя до 32 байт";
  else if (wpass2.length() > 0 && (wpass2.length() < 8 || wpass2.length() > 64)) problem = "Пароль запасной сети: от 8 до 64 символов";
  else if (host.length() == 0 || host.length() > 128) problem = "Укажите адрес сервера";
  else if (port < 1 || port > 65535) problem = "MQTT порт: от 1 до 65535";
  else if (claim.length() > 128) problem = "Claim-токен слишком длинный";
  if (problem) {
    _server.send(400, "text/plain; charset=utf-8", problem);
    return;
  }
  c.ssid = ssid;
  if (open) c.wifiPass = "";
  else if (wpass.length() > 0) c.wifiPass = wpass;
  // Пароль запасной сети: пусто — оставить прежний, если сеть та же; у новой сети — без пароля
  if (wpass2.length() > 0) c.wifiPass2 = wpass2;
  else if (ssid2 != _current.ssid2) c.wifiPass2 = "";
  c.ssid2 = ssid2;
  if (c.ssid2.isEmpty()) c.wifiPass2 = "";
  c.host = host;
  c.port = static_cast<uint16_t>(port);
  if (claim.length() > 0) c.claimToken = claim;
  _saved = c;

  _server.send(200, "text/html; charset=utf-8",
               F("<!doctype html><meta charset='utf-8'><p style='font:16px system-ui;margin:24px'>"
                 "Сохранено. Устройство перезагружается…</p>"));
  _done = true;
}
