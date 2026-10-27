#include "IotDevice.h"

#include <stdarg.h>
#include <string.h>
#include <time.h>

namespace {
constexpr uint32_t kWifiPortalAfterMs = 60000;   // нет Wi-Fi с момента загрузки -> портал
constexpr uint32_t kMaxBackoffMs = 60000;
constexpr uint8_t kProvisionRejectsToPortal = 3;
constexpr const char* kPrefsNs = "iotdev";

inline bool before(uint32_t now, uint32_t deadline) { return static_cast<int32_t>(now - deadline) < 0; }
inline String S(const std::string& s) { return String(s.c_str()); }
inline std::string Std(const String& s) { return std::string(s.c_str()); }
}  // namespace

// =========================== IotProperty ===========================

IotProperty::IotProperty(IotDevice* dev, const char* name, iot::PropType type) : _dev(dev) {
  _spec.name = name ? name : "";
  _spec.type = type;
}

IotProperty& IotProperty::onSet(SetHandler handler) {
  _handler = handler;
  _spec.settable = static_cast<bool>(handler);
  return *this;
}

IotProperty& IotProperty::range(double min, double max) {
  _spec.hasRange = true;
  _spec.min = min;
  _spec.max = max;
  return *this;
}

IotProperty& IotProperty::unit(const char* u) {
  _spec.unit = u ? u : "";
  return *this;
}

void IotProperty::store(const std::string& canonical) {
  _value = S(canonical);
  _hasValue = true;
  _dirty = true;
  if (_dev->online()) _dev->publishProperty(*this);
}

void IotProperty::setBool(bool v) { store(v ? "true" : "false"); }

void IotProperty::setInt(long long v) { store(iot::formatInt(v)); }

void IotProperty::setFloat(double v) {
  std::string s = iot::formatFloat(v, _spec.decimals);
  if (s.empty()) {
    _dev->log("[iot] %s: NaN/Inf пропущено", name());
    return;
  }
  store(s);
}

void IotProperty::setString(const String& v) {
  std::string s = Std(v);
  if (s.size() > iot::kMaxValueLen) s.resize(iot::kMaxValueLen);
  store(s);
}

// =========================== IotDevice ===========================

IotDevice::IotDevice(const char* name, const char* firmwareVersion)
    : _name(name ? name : "IoT device"), _fw(firmwareVersion ? firmwareVersion : ""), _mqtt(_tls) {}

IotProperty& IotDevice::add(const char* name, iot::PropType type) {
  // Свойства обычно объявляют глобально, ещё до setDebug(), поэтому ошибки копятся
  // и выводятся в begin(). Недопустимое свойство остаётся объектом (на него есть ссылка
  // в скетче), но в $meta не попадает и никогда не публикуется: имя с + # / сломало бы MQTT.
  std::string n = name ? name : "";
  auto* p = new IotProperty(this, name, type);
  if (!iot::isValidPropName(n)) {
    p->_valid = false;
    configError("свойство '%s': недопустимое имя (a-z, 0-9, _ -, до 32 символов, с буквы) — игнорируется", n.c_str());
  } else {
    for (auto* q : _props) {
      if (q->_valid && q->_spec.name == n) {
        p->_valid = false;
        configError("свойство '%s' объявлено дважды — второе объявление игнорируется", n.c_str());
        break;
      }
    }
  }
  _props.push_back(p);
  return *p;
}

void IotDevice::configError(const char* fmt, ...) {
  char buf[200];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  _configErrors.push_back(String(buf));
}

std::vector<iot::PropSpec> IotDevice::metaSpecs() const {
  std::vector<iot::PropSpec> specs;
  for (auto* p : _props) {
    if (p->_valid) specs.push_back(p->_spec);
  }
  return specs;
}

IotProperty& IotDevice::addBool(const char* name) { return add(name, iot::PropType::Boolean); }

IotProperty& IotDevice::addInt(const char* name, const char* unit) {
  return add(name, iot::PropType::Integer).unit(unit);
}

IotProperty& IotDevice::addFloat(const char* name, const char* unit, int decimals) {
  IotProperty& p = add(name, iot::PropType::Float).unit(unit);
  p._spec.decimals = decimals;
  return p;
}

IotProperty& IotDevice::addString(const char* name) { return add(name, iot::PropType::String); }

void IotDevice::setWiFi(const char* ssid, const char* password) {
  _defaults.ssid = ssid ? ssid : "";
  _defaults.wifiPass = password ? password : "";
}

void IotDevice::setServer(const char* host, uint16_t mqttPort) {
  _defaults.host = host ? host : "";
  _defaults.port = mqttPort;
}

void IotDevice::setClaimToken(const char* token) { _defaults.claimToken = token ? token : ""; }
void IotDevice::setCaCert(const char* pem) { _caCert = pem; }
void IotDevice::setInsecure() { _insecure = true; }

void IotDevice::applyTls(WiFiClientSecure& client) {
  if (_insecure) {
    client.setInsecure();
    return;
  }
  if (!_caCert) return;
#if defined(ESP8266)
  if (!_trust) _trust = new BearSSL::X509List(_caCert);
  client.setTrustAnchors(_trust);
#else
  client.setCACert(_caCert);
#endif
}

void IotDevice::setConfigButton(int pin, bool activeLow) {
  _buttonPin = pin;
  _buttonActiveLow = activeLow;
}

void IotDevice::setPortal(const char* apPassword, uint32_t timeoutSec) {
  _portalPass = apPassword ? apPassword : "";
  _portalTimeoutMs = timeoutSec * 1000UL;
}

void IotDevice::setDebug(Stream* out) { _log = out; }

void IotDevice::log(const char* fmt, ...) {
  if (!_log) return;
  char buf[256];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  _log->println(buf);
}

const char* IotDevice::stateName(State s) {
  switch (s) {
    case State::Portal: return "portal";
    case State::WifiConnecting: return "wifi";
    case State::Provisioning: return "provisioning";
    case State::MqttConnecting: return "mqtt";
    case State::Online: return "online";
    default: return "idle";
  }
}

void IotDevice::setState(State s) {
  if (s == _state) return;
  _state = s;
  _stateSince = millis();
  log("[iot] state -> %s", stateName(s));
  if (_onState) _onState(s);
}

void IotDevice::loadConfig() {
  _cfg = _defaults;
  if (_prefs.isKey("ssid")) _cfg.ssid = _prefs.getString("ssid");
  if (_prefs.isKey("wpass")) _cfg.wifiPass = _prefs.getString("wpass");
  if (_prefs.isKey("host")) _cfg.host = _prefs.getString("host");
  if (_prefs.isKey("port")) _cfg.port = _prefs.getUShort("port", _cfg.port);
  if (_prefs.isKey("claim")) _cfg.claimToken = _prefs.getString("claim");

  // Учётка хранится одной записью "id\nпароль\nтокен": три отдельные записи могли разойтись
  // при пропадании питания, и устройство теряло привязку. Старый формат (0.1.x) тоже читаем.
  // isKey перед get — иначе на ESP32 при первой загрузке NVS сыплет в лог NOT_FOUND.
  _deviceId = "";
  _mqttPass = "";
  _claimUsed = "";
  if (_prefs.isKey("cred")) {
    const std::string c = Std(_prefs.getString("cred"));
    const size_t a = c.find('\n');
    const size_t b = a == std::string::npos ? std::string::npos : c.find('\n', a + 1);
    if (b != std::string::npos) {
      _deviceId = S(c.substr(0, a));
      _mqttPass = S(c.substr(a + 1, b - a - 1));
      _claimUsed = S(c.substr(b + 1));
    }
  } else if (_prefs.isKey("id") && _prefs.isKey("mpass")) {
    _deviceId = _prefs.getString("id");
    _mqttPass = _prefs.getString("mpass");
    if (_prefs.isKey("claimUsed")) _claimUsed = _prefs.getString("claimUsed");
  }

  if (!iot::isValidDeviceId(Std(_deviceId)) || _mqttPass.isEmpty()) {
    _deviceId = "";
    _mqttPass = "";
  }
  // В прошивке или портале появился новый токен — привязываемся заново
  if (!_cfg.claimToken.isEmpty() && _cfg.claimToken != _claimUsed) {
    if (!_deviceId.isEmpty()) log("[iot] новый claim-токен — устройство будет привязано заново");
    _deviceId = "";
    _mqttPass = "";
  }
}

bool IotDevice::needsPortal() const {
  return _cfg.ssid.isEmpty() || _cfg.host.isEmpty() || (_deviceId.isEmpty() && _cfg.claimToken.isEmpty());
}

bool IotDevice::begin() {
  log("[iot] IotDevice SDK %s, '%s' fw %s", IOT_DEVICE_SDK_VERSION, _name.c_str(), _fw.c_str());
  _prefs.begin(kPrefsNs, false);

  if (_buttonPin >= 0) {
    pinMode(_buttonPin, _buttonActiveLow ? INPUT_PULLUP : IOT_INPUT_PULLDOWN);
    auto pressed = [this]() { return digitalRead(_buttonPin) == (_buttonActiveLow ? LOW : HIGH); };
    uint32_t t0 = millis();
    while (pressed() && millis() - t0 < 3000) delay(10);
    if (pressed()) {
      log("[iot] кнопка удержана — сброс настроек");
      _prefs.clear();
      while (pressed()) delay(10);
    }
  }

  loadConfig();

  if (_insecure) log("[iot] ВНИМАНИЕ: проверка сертификата выключена (setInsecure)");
  else if (!_caCert) log("[iot] ВНИМАНИЕ: не задан setCaCert — TLS-соединение не пройдёт проверку");
  applyTls(_tls);

  if (_portalPass.length() > 0 && _portalPass.length() < 8) {
    configError("пароль портала короче 8 символов — точка доступа будет открытой");
  }

  // $meta: больше 8 КБ сервер отбросит, а не влезший в буфер PubSubClient не уйдёт вовсе
  // и сорвёт подключение. В обоих случаях $meta не отправляем — остальное работает.
  const size_t metaLen = iot::buildMeta(Std(_name), Std(_fw), metaSpecs()).size();
  _metaOk = metaLen <= iot::kMaxMetaLen;
  if (!_metaOk) {
    configError("$meta %u байт больше 8192 — сервер его отбросит, отправляться не будет. Сократите имена/единицы или число свойств",
                (unsigned)metaLen);
  }
  const size_t want = max<size_t>(512, _metaOk ? metaLen + 128 : 512);  // +128: заголовок пакета и топик
  if (!_mqtt.setBufferSize(static_cast<uint16_t>(want))) {
    _metaOk = false;
    configError("не хватило памяти на буфер MQTT %u байт — $meta отправляться не будет", (unsigned)want);
    _mqtt.setBufferSize(512);
  }
  for (const auto& e : _configErrors) log("[iot] ОШИБКА: %s", e.c_str());
  _mqtt.setKeepAlive(60);
  _mqtt.setSocketTimeout(10);
  _mqtt.setCallback([this](char* t, uint8_t* p, unsigned int l) { onMqttMessage(t, p, l); });

  WiFi.persistent(false);  // Wi-Fi храним сами, не в NVS ядра
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  if (needsPortal()) enterPortal();
  else connectWiFi();
  return _configErrors.empty();
}

void IotDevice::connectWiFi() {
  log("[iot] Wi-Fi: подключение к '%s'", _cfg.ssid.c_str());
  WiFi.setAutoReconnect(true);
  WiFi.begin(_cfg.ssid.c_str(), _cfg.wifiPass.c_str());
  setState(State::WifiConnecting);
}

void IotDevice::enterPortal() {
  if (_portal.active()) return;
  String mac = WiFi.macAddress();
  mac.replace(":", "");
  String ap = "IoT-" + mac.substring(mac.length() >= 4 ? mac.length() - 4 : 0);
  log("[iot] портал настройки: сеть '%s', http://192.168.4.1", ap.c_str());
  if (_portalPass.length() < 8) {
    log("[iot] ВНИМАНИЕ: точка доступа открытая — пароль Wi-Fi и токен уйдут открытым текстом. Задайте setPortal(\"пароль\")");
  }
  // Попытки подключения STA гоняют радио по каналам, и точка доступа «прыгает» вслед —
  // телефон отваливается. Пока открыт портал, STA молчит; подключение запустит connectWiFi().
  WiFi.setAutoReconnect(false);
  WiFi.disconnect();
  _portal.begin(ap, _portalPass, _cfg, _name);
  setState(State::Portal);
}

void IotDevice::startPortal() {
  if (_mqtt.connected()) {
    // при штатном DISCONNECT брокер LWT не публикует — иначе на сервере остался бы retained "ready"
    publish(iot::topic(Std(_deviceId), "$state"), "disconnected", true);
    _mqtt.disconnect();
  }
  enterPortal();
}

void IotDevice::resetConfig() {
  _prefs.clear();
  delay(100);
  ESP.restart();
}

void IotDevice::syncTime() {
  if (_timeSynced) return;
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  uint32_t t0 = millis();
  while (time(nullptr) < 1700000000 && millis() - t0 < 5000) delay(100);
  _timeSynced = time(nullptr) >= 1700000000;
  log("[iot] время %s", _timeSynced ? "синхронизировано" : "не получено (проверка сертификата может не пройти)");
}

void IotDevice::scheduleRetry(uint32_t& backoffMs, uint32_t maxMs) {
  _nextAttempt = millis() + backoffMs + static_cast<uint32_t>(random(0, backoffMs / 4 + 1));
  log("[iot] повтор через %u мс", (unsigned)(_nextAttempt - millis()));
  backoffMs = min(backoffMs * 2, maxMs);
}

IotDevice::ProvisionResult IotDevice::provision() {
  if (_cfg.claimToken.isEmpty()) {
    log("[iot] нет claim-токена: создайте устройство через POST /api/devices");
    return ProvisionResult::Rejected;
  }

  WiFiClientSecure client;
  applyTls(client);

  HTTPClient http;
#if defined(ESP32)
  http.setConnectTimeout(8000);
#endif
  http.setTimeout(10000);
  String url = "https://" + _cfg.host + "/api/provision";
  if (!http.begin(client, url)) return ProvisionResult::Error;
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(S(iot::buildProvisionRequest(Std(_cfg.claimToken))));
  String body = code > 0 ? http.getString() : String();
  http.end();

  if (code == 200) {
    std::string id, pass;
    if (!iot::jsonGetString(Std(body), "device_id", id) || !iot::jsonGetString(Std(body), "password", pass) ||
        !iot::isValidDeviceId(id) || pass.empty()) {
      log("[iot] provision: неожиданный ответ сервера");
      return ProvisionResult::Error;
    }
    _deviceId = S(id);
    _mqttPass = S(pass);
    _claimUsed = _cfg.claimToken;
    saveCredentials();
    log("[iot] привязано как %s", _deviceId.c_str());
    return ProvisionResult::Ok;
  }
  if (code == 400 || code == 401) {
    log("[iot] provision: токен отклонён (HTTP %d) — он просрочен или уже использован", code);
    return ProvisionResult::Rejected;
  }
  log("[iot] provision: ошибка (код %d)%s", code, code < 0 ? " — сеть/TLS" : "");
  return ProvisionResult::Error;
}

void IotDevice::saveCredentials() {
  // одной записью: сохраняется целиком или не сохраняется вовсе
  _prefs.putString("cred", _deviceId + "\n" + _mqttPass + "\n" + _claimUsed);
}

bool IotDevice::connectMqtt() {
  const std::string id = Std(_deviceId);
  const std::string willTopic = iot::topic(id, "$state");
  _mqtt.setServer(_cfg.host.c_str(), _cfg.port);

  log("[iot] MQTT: %s:%u", _cfg.host.c_str(), (unsigned)_cfg.port);
  // client id = username = id устройства — сервер требует совпадения
  if (!_mqtt.connect(id.c_str(), id.c_str(), _mqttPass.c_str(), willTopic.c_str(), 1, true, "lost")) {
    int st = _mqtt.state();
    log("[iot] MQTT: отказ, state=%d", st);
    if (st == MQTT_CONNECT_BAD_CREDENTIALS || st == MQTT_CONNECT_UNAUTHORIZED) {
      log("[iot] учётка отклонена: устройство удалено/перепривязано? Нужен новый claim-токен (портал или прошивка)");
    }
    return false;
  }

  bool ok = publish(willTopic, "init", true);
  if (_metaOk) ok = ok && publish(iot::topic(id, "$meta"), S(iot::buildMeta(Std(_name), Std(_fw), metaSpecs())), true);
  ok = ok && _mqtt.subscribe(iot::topic(id, "+/set").c_str(), 1);
  for (auto* p : _props) {
    if (!p->_valid) continue;
    if (p->_hasValue) ok = ok && publish(iot::topic(id, p->_spec.name), p->_value, false);
    if (ok) p->_dirty = false;
  }
  ok = ok && publish(willTopic, "ready", true);
  if (!ok) {
    log("[iot] MQTT: не удалось отправить начальные сообщения");
    _mqtt.disconnect();
    return false;
  }
  log("[iot] MQTT: онлайн, топики dev/%s/...", id.c_str());
  return true;
}

bool IotDevice::publish(const std::string& topic, const String& payload, bool retained) {
  if (!_mqtt.connected()) return false;
  return _mqtt.publish(topic.c_str(), payload.c_str(), retained);
}

void IotDevice::publishProperty(IotProperty& p) {
  if (!p._valid || !p._hasValue) return;
  if (publish(iot::topic(Std(_deviceId), p._spec.name), p._value, false)) p._dirty = false;
}

bool IotDevice::publishState(const char* state) {
  // init/lost/disconnected — служебные: их выставляют SDK и брокер (LWT)
  if (!state || (strcmp(state, "ready") != 0 && strcmp(state, "sleeping") != 0 && strcmp(state, "alert") != 0)) {
    return false;
  }
  return publish(iot::topic(Std(_deviceId), "$state"), state, true);
}

void IotDevice::onMqttMessage(char* topic, uint8_t* payload, unsigned int len) {
  // topic и payload лежат в буфере PubSubClient — копируем до любых publish
  std::string prop;
  if (!iot::parseSetTopic(topic, Std(_deviceId), prop)) return;
  std::string raw(reinterpret_cast<const char*>(payload), len);

  IotProperty* p = nullptr;
  for (auto* x : _props) {
    if (x->_valid && x->_spec.name == prop) { p = x; break; }
  }
  if (!p || !p->_handler) {
    log("[iot] команда для неизвестного/не settable свойства '%s'", prop.c_str());
    return;
  }

  std::string canon;
  if (!iot::normalizeValue(p->_spec, raw, canon)) {
    log("[iot] %s: недопустимое значение '%s'", prop.c_str(), raw.c_str());
    if (p->_hasValue) publishProperty(*p);
    return;
  }

  log("[iot] команда %s = %s", prop.c_str(), canon.c_str());
  if (p->_handler(*p, S(canon))) p->store(canon);
  else if (p->_hasValue) publishProperty(*p);
}

void IotDevice::loop() {
  const uint32_t now = millis();
  const bool wifiUp = WiFi.status() == WL_CONNECTED;

  switch (_state) {
    case State::Idle:
      return;

    case State::Portal:
      if (_portal.loop()) {
        const IotConfig& c = _portal.saved();
        _prefs.putString("ssid", c.ssid);
        _prefs.putString("wpass", c.wifiPass);
        _prefs.putString("host", c.host);
        _prefs.putUShort("port", c.port);
        _prefs.putString("claim", c.claimToken);
        log("[iot] настройки сохранены, перезагрузка");
        uint32_t t0 = millis();
        while (millis() - t0 < 1000) { _portal.loop(); delay(10); }  // дать отдать ответ
        ESP.restart();
      } else if (_portalTimeoutMs && now - _stateSince > _portalTimeoutMs) {
        log("[iot] портал: таймаут");
        if (needsPortal()) ESP.restart();
        _portal.end();
        connectWiFi();
      }
      return;

    case State::WifiConnecting:
      if (wifiUp) {
        log("[iot] Wi-Fi: %s, RSSI %d", WiFi.localIP().toString().c_str(), WiFi.RSSI());
        syncTime();
        _nextAttempt = millis();
        setState(_deviceId.isEmpty() ? State::Provisioning : State::MqttConnecting);
      } else if (!_everOnline && now - _stateSince > kWifiPortalAfterMs) {
        log("[iot] Wi-Fi не подключается — открываю портал");
        enterPortal();
      }
      return;

    case State::Provisioning: {
      if (!wifiUp) { setState(State::WifiConnecting); return; }
      if (before(now, _nextAttempt)) return;
      ProvisionResult r = provision();
      if (r == ProvisionResult::Ok) {
        _provisionRejects = 0;
        _provisionBackoff = 2000;
        _nextAttempt = millis();
        setState(State::MqttConnecting);
      } else if (r == ProvisionResult::Rejected && ++_provisionRejects >= kProvisionRejectsToPortal) {
        log("[iot] токен не принят %u раза — открываю портал", (unsigned)_provisionRejects);
        _provisionRejects = 0;
        enterPortal();
      } else {
        scheduleRetry(_provisionBackoff, kMaxBackoffMs);
      }
      return;
    }

    case State::MqttConnecting:
      if (!wifiUp) { setState(State::WifiConnecting); return; }
      if (before(now, _nextAttempt)) return;
      if (connectMqtt()) {
        _mqttBackoff = 1000;
        _everOnline = true;
        setState(State::Online);
      } else {
        scheduleRetry(_mqttBackoff, kMaxBackoffMs);
      }
      return;

    case State::Online:
      if (!wifiUp) {
        _mqtt.disconnect();
        setState(State::WifiConnecting);
        return;
      }
      if (!_mqtt.loop()) {
        log("[iot] MQTT: соединение потеряно");
        _nextAttempt = millis();
        setState(State::MqttConnecting);
        return;
      }
      for (auto* p : _props) {
        if (p->_dirty) publishProperty(*p);
      }
      return;
  }
}
