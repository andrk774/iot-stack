#include "IotDevice.h"

#include <algorithm>
#include <math.h>
#include <stdarg.h>
#include <string.h>
#include <time.h>

namespace {
constexpr uint32_t kWifiPortalAfterMs = 60000;   // нет Wi-Fi с момента загрузки -> портал
constexpr uint32_t kWifiSwitchMs = 20000;        // столько ждём сеть, прежде чем попробовать запасную
constexpr uint32_t kMaxBackoffMs = 60000;
constexpr uint8_t kProvisionRejectsToPortal = 3;
constexpr uint8_t kAuthRejectsToPortal = 5;
constexpr uint32_t kTimeWaitMs = 5000;
constexpr time_t kTimeValid = 1700000000;        // ноябрь 2023: раньше — часы ещё не выставлены
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

IotProperty& IotProperty::minInterval(uint32_t ms) {
  _minIntervalMs = ms;
  return *this;
}

IotProperty& IotProperty::deadband(double delta) {
  _deadband = delta < 0 ? 0 : delta;
  return *this;
}

IotProperty& IotProperty::persist() {
  _persist = true;
  return *this;
}

bool IotProperty::worthSending() const {
  if (_deadband < 0 || !_hasSent) return true;
  if (_value == _sent) return false;
  if (_spec.type == iot::PropType::Integer || _spec.type == iot::PropType::Float) {
    // значения уже округлены до decimals; допуск — чтобы 21.6 - 21.4 считалось ровно 0.2
    return fabs(floatValue() - atof(_sent.c_str())) + 1e-9 >= _deadband;
  }
  return true;
}

void IotProperty::markSent() {
  _dirty = false;
  _sent = _value;
  _hasSent = true;
  _sentAt = millis();
}

void IotProperty::store(const std::string& canonical, bool fromServer) {
  _value = S(canonical);
  _hasValue = true;
  _dev->persistValue(*this);
  // Не прошло deadband — и отправлять нечего, в том числе отложенное minInterval:
  // сервер уже знает значение, близкое к текущему.
  _dirty = fromServer || worthSending();
  if (_dirty && _dev->online()) _dev->publishProperty(*this, fromServer);
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
  if (!_spec.enumValues.empty()) {
    std::string canon;
    if (!iot::normalizeValue(_spec, s, canon)) {
      _dev->log("[iot] %s: '%s' нет в списке допустимых значений — пропущено", name(), s.c_str());
      return;
    }
    s = canon;
  }
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

IotProperty& IotDevice::addEnum(const char* name, std::initializer_list<const char*> values) {
  IotProperty& p = add(name, iot::PropType::String);
  for (const char* v : values) {
    const std::string s = v ? v : "";
    if (s.empty() || s.size() > iot::kMaxValueLen || iot::trim(s) != s) {
      p._valid = false;
      configError("свойство '%s': значение enum '%s' пустое, длиннее 256 байт или с пробелами по краям", p.name(),
                  s.c_str());
    }
    p._spec.enumValues.push_back(s);
  }
  if (p._spec.enumValues.empty()) {
    p._valid = false;
    configError("свойство '%s': пустой список значений enum", p.name());
  }
  return p;
}

void IotDevice::setWiFi(const char* ssid, const char* password) {
  _defaults.ssid = ssid ? ssid : "";
  _defaults.wifiPass = password ? password : "";
}

void IotDevice::setWiFiFallback(const char* ssid, const char* password) {
  _defaults.ssid2 = ssid ? ssid : "";
  _defaults.wifiPass2 = password ? password : "";
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

bool IotDevice::afterBegin(const char* what) {
  if (!_begun) return false;
  configError("%s вызван после begin() — служебные свойства не попадут в $meta, игнорируется", what);
  log("[iot] ОШИБКА: %s", _configErrors.back().c_str());
  return true;
}

void IotDevice::enableStats(uint32_t intervalSec) {
  if (afterBegin("enableStats()")) return;
  _statsIntervalMs = (intervalSec ? intervalSec : 1) * 1000UL;
  if (_statRssi) return;
  // Если в скетче уже есть свойство с таким именем, служебное станет дублем и будет
  // проигнорировано (с ошибкой в configErrors), а пользовательское продолжит работать.
  _statRssi = &addInt("rssi", "dBm");
  _statUptime = &addInt("uptime", "s");
  _statHeap = &addInt("free_heap", "B");
  _statReset = &addString("reset_reason").deadband(0);
  _statIp = &addString("ip").deadband(0);
}

void IotDevice::updateStats() {
  if (!_statRssi) return;
  _statsAt = millis();
  _statRssi->setInt(WiFi.RSSI());
  _statUptime->setInt(static_cast<long long>(_uptimeMs / 1000));
  _statHeap->setInt(ESP.getFreeHeap());
  _statReset->setString(iotResetReason());
  _statIp->setString(WiFi.localIP().toString());
}

// ---- служебные команды ----

void IotDevice::enableCommands() {
  if (afterBegin("enableCommands()") || _cmd) return;
  _cmd = &addEnum("cmd", {"reboot", "portal", "reset", "identify"}).onSet([this](IotProperty&, const String& v) {
    return onCommand(v);
  });
}

// Вызывается из обработчика MQTT: значение уже проверено по списку enum
bool IotDevice::onCommand(const String& cmd) {
  if (cmd == "identify") {
    if (!_onIdentify) {
      log("[iot] identify: не задан onIdentify — команда отклонена");
      return false;
    }
    _onIdentify();
    return true;
  }
  // reboot/portal/reset выполняются в loop(): сначала серверу должно уйти подтверждение
  _pendingCmd = cmd;
  return true;
}

void IotDevice::runCommand() {
  const String cmd = _pendingCmd;
  _pendingCmd = "";
  log("[iot] служебная команда: %s", cmd.c_str());
  if (cmd == "portal") {
    startPortal();
    return;
  }
  goOffline();
  delay(100);
  if (cmd == "reset") _prefs.clear();
  ESP.restart();
}

// При штатном DISCONNECT брокер LWT не публикует — без этого на сервере остался бы retained "ready"
void IotDevice::goOffline() {
  if (!_mqtt.connected()) return;
  publish(iot::topic(Std(_deviceId), "$state"), "disconnected", true);
  _mqtt.disconnect();
}

// ---- OTA ----
// Сервер публикует retained-команду dev/<id>/$ota/set — она придёт и после переподключения.
// Чтобы не прошиваться по кругу, id задания запоминается в NVS до скачивания: повторно
// то же задание не выполняется. Итог (done/failed) устройство сообщает после перезагрузки,
// сравнив свою версию с ожидаемой.

void IotDevice::reportOta(const std::string& job, const char* status, int progress, const String& error) {
  const String msg = S(iot::buildOtaStatus(job, status, progress, Std(error)));
  if (!publish(iot::topic(Std(_deviceId), "$ota"), msg, false)) _otaUnsent = msg;
}

void IotDevice::handleOtaCommand(const std::string& json) {
  if (json.empty()) {  // сервер снял команду (отменено или завершено)
    if (_otaPending) log("[iot] OTA: задание отменено");
    _otaPending = false;
    return;
  }
  iot::OtaRequest req;
  if (!iot::parseOtaRequest(json, req)) {
    log("[iot] OTA: некорректная команда");
    return;
  }
  if (_prefs.isKey("otaJob") && Std(_prefs.getString("otaJob")) == req.job) return;  // уже выполнялось
  if (!_otaEnabled) {
    log("[iot] OTA: обновление выключено в прошивке (enableOta)");
    _prefs.putString("otaJob", S(req.job));
    reportOta(req.job, "failed", -1, "OTA выключено в прошивке устройства (enableOta)");
    return;
  }
  if (S(req.version) == _fw) {
    log("[iot] OTA: версия %s уже установлена", _fw.c_str());
    _prefs.putString("otaJob", S(req.job));
    reportOta(req.job, "done", 100);
    return;
  }
  // приложение может отказаться (идёт нагрев, открыт клапан): задание не повторяется, итог — failed
  if (_onOtaStart && !_onOtaStart()) {
    log("[iot] OTA: отклонено устройством (onOtaStart)");
    _prefs.putString("otaJob", S(req.job));
    reportOta(req.job, "failed", -1, "отклонено устройством (onOtaStart)");
    return;
  }
  log("[iot] OTA: задание на версию %s (%lld байт)", req.version.c_str(), req.size);
  _ota = req;
  _otaPending = true;  // выполняем из loop(), не из обработчика MQTT
}

void IotDevice::reportOtaAfterReboot() {
  if (!_prefs.isKey("otaVer")) return;
  const String want = _prefs.getString("otaVer");
  const std::string job = _prefs.isKey("otaJob") ? Std(_prefs.getString("otaJob")) : std::string();
  _prefs.remove("otaVer");
  if (job.empty()) return;
  if (want == _fw) {
    log("[iot] OTA: работает новая прошивка %s", _fw.c_str());
    reportOta(job, "done", 100);
  } else {
    reportOta(job, "failed", -1, "после перезагрузки версия " + _fw + ", ожидалась " + want + " (загрузчик откатил прошивку?)");
  }
}

void IotDevice::runOta() {
  _otaPending = false;
  const iot::OtaRequest req = _ota;
  // сначала запоминаем задание: если новая прошивка не загрузится, повторять его не будем
  _prefs.putString("otaJob", S(req.job));
  reportOta(req.job, "downloading", 0);

  auto fail = [&](const String& why) {
    log("[iot] OTA: ошибка: %s", why.c_str());
    reportOta(req.job, "failed", -1, why);
  };

#if defined(ESP8266)
  // на ESP8266 памяти на два TLS-соединения не хватает: MQTT закрываем, вернётся сам после ошибки
  _mqtt.disconnect();
  _tls.stop();
#endif

  WiFiClientSecure client;
  applyTls(client);
  HTTPClient http;
#if defined(ESP32)
  http.setConnectTimeout(8000);
#endif
  http.setTimeout(15000);
  const String url = "https://" + _cfg.host + S(req.path);
  if (!http.begin(client, url)) { fail("не удалось начать HTTP-запрос"); return; }
  const int code = http.GET();
  if (code != 200) {
    http.end();
    fail(code < 0 ? String("сеть/TLS, код ") + String(code) : String("HTTP ") + String(code));
    return;
  }
  const int len = http.getSize();
  if (len != static_cast<int>(req.size)) {
    http.end();
    fail(String("размер ") + String(len) + ", ожидался " + String(static_cast<long>(req.size)));
    return;
  }
  if (!Update.begin(static_cast<size_t>(req.size))) {
    http.end();
    fail("нет места под прошивку: " + IOT_UPDATE_ERROR());
    return;
  }
  Update.setMD5(req.md5.c_str());
  int lastStep = 0;
  Update.onProgress([&](size_t done, size_t total) {
    const int pct = total ? static_cast<int>(done * 100 / total) : 0;
    if (pct / 10 > lastStep && _mqtt.connected()) {
      lastStep = pct / 10;
      reportOta(req.job, "downloading", pct);
      _mqtt.loop();
    }
  });
  const size_t written = Update.writeStream(*http.getStreamPtr());
  http.end();
  Update.onProgress(nullptr);  // лямбда ссылается на локальные переменные
  const bool ended = Update.end();  // вызываем всегда: при недописанном образе это сбрасывает Update
  if (written != static_cast<size_t>(req.size) || !ended) {
    fail(String("запись прошивки: ") + IOT_UPDATE_ERROR() + " (записано " + String(static_cast<unsigned long>(written)) + ")");
    return;
  }
  _prefs.putString("otaVer", S(req.version));
  log("[iot] OTA: прошивка %s записана, перезагрузка", req.version.c_str());
  reportOta(req.job, "rebooting", 100);
  if (_mqtt.connected()) {
    publish(iot::topic(Std(_deviceId), "$state"), "disconnected", true);
    _mqtt.disconnect();
  }
  _otaUnsent = "";
  if (_onOtaReboot) _onOtaReboot();
  delay(200);
  ESP.restart();
}

// ---- глубокий сон ----

bool IotDevice::pending() const {
  for (auto* p : _props) {
    if (p->_valid && p->_hasValue && p->_dirty) return true;
  }
  return false;
}

void IotDevice::deepSleep(uint32_t seconds) {
  if (_mqtt.connected()) {
    for (auto* p : _props) {
      if (p->_dirty) publishProperty(*p, true);  // minInterval не ждём: устройство сейчас уснёт
    }
    publish(iot::topic(Std(_deviceId), "$state"), "sleeping", true);
    _mqtt.disconnect();  // штатно: LWT "lost" не сработает, на сервере останется sleeping
  }
  log("[iot] глубокий сон: %u с", (unsigned)seconds);
  _portal.end();
  WiFi.disconnect(true);
  delay(10);
  iotDeepSleep(static_cast<uint64_t>(seconds) * 1000000ULL);
}

void IotDevice::persistValue(IotProperty& p) {
  // до begin() set*() задаёт значение по умолчанию, а не сохранённое
  if (!_begun || !p._persist || !p._valid) return;
  auto it = _persisted.find(p._spec.name);
  if (it != _persisted.end() && it->second == Std(p._value)) return;  // флеш не трогаем без нужды
  _persisted[p._spec.name] = Std(p._value);
  if (_prefs.putString("pv", S(iot::kvEncode(_persisted))) == 0) {
    log("[iot] %s: не удалось сохранить значение во флеш", p.name());
  }
}

void IotDevice::restoreValues() {
  std::map<std::string, std::string> stored;
  if (_prefs.isKey("pv")) stored = iot::kvDecode(Std(_prefs.getString("pv")));
  _persisted.clear();  // значения свойств, которых больше нет в прошивке, отбросятся при следующей записи
  for (auto* p : _props) {
    if (!p->_persist || !p->_valid) continue;
    auto it = stored.find(p->_spec.name);
    if (it == stored.end()) continue;
    _persisted[it->first] = it->second;
    std::string canon;
    if (!iot::normalizeValue(p->_spec, it->second, canon)) {
      log("[iot] %s: сохранённое значение '%s' не подходит (тип или диапазон изменились) — пропущено",
          p->name(), it->second.c_str());
      continue;
    }
    if (p->_handler && !p->_handler(*p, S(canon))) {
      log("[iot] %s: обработчик отклонил сохранённое значение '%s'", p->name(), canon.c_str());
      continue;
    }
    p->_value = S(canon);
    p->_hasValue = true;
    p->_dirty = true;
    log("[iot] %s = %s (восстановлено)", p->name(), canon.c_str());
  }
}

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
  if (s == State::WifiConnecting) _wifiAttemptAt = _stateSince;
  log("[iot] state -> %s", stateName(s));
  if (_onState) _onState(s);
}

void IotDevice::loadConfig() {
  _cfg = _defaults;
  // Настройки портала — одной записью "cfg" (как и учётка): пять отдельных записей при пропадании
  // питания могли оставить смесь старых и новых значений. Отдельные ключи версий до 0.4 тоже читаем.
  std::map<std::string, std::string> kv;
  if (_prefs.isKey("cfg")) {
    kv = iot::kvDecode(Std(_prefs.getString("cfg")));
  } else {
    for (const char* k : {"ssid", "wpass", "host", "claim"}) {
      if (_prefs.isKey(k)) kv[k] = Std(_prefs.getString(k));
    }
    if (_prefs.isKey("port")) kv["port"] = iot::formatInt(_prefs.getUShort("port", _cfg.port));
  }
  auto get = [&kv](const char* key, String& dst) {
    auto it = kv.find(key);
    if (it != kv.end()) dst = S(it->second);
  };
  get("ssid", _cfg.ssid);
  get("wpass", _cfg.wifiPass);
  get("ssid2", _cfg.ssid2);
  get("wpass2", _cfg.wifiPass2);
  get("host", _cfg.host);
  get("claim", _cfg.claimToken);
  long long port = 0;
  if (kv.count("port") && iot::parseInt(kv["port"], port) && port >= 1 && port <= 65535) {
    _cfg.port = static_cast<uint16_t>(port);
  }

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

void IotDevice::saveConfig(const IotConfig& c) {
  const std::map<std::string, std::string> kv = {
      {"ssid", Std(c.ssid)}, {"wpass", Std(c.wifiPass)}, {"ssid2", Std(c.ssid2)},  {"wpass2", Std(c.wifiPass2)},
      {"host", Std(c.host)}, {"port", iot::formatInt(c.port)}, {"claim", Std(c.claimToken)}};
  if (_prefs.putString("cfg", S(iot::kvEncode(kv))) == 0) log("[iot] ОШИБКА: настройки не сохранились во флеш");
}

bool IotDevice::needsPortal() const { return missingConfig() != nullptr; }

const char* IotDevice::missingConfig() const {
  if (_cfg.ssid.isEmpty()) return "Не задана Wi-Fi сеть";
  if (_cfg.host.isEmpty()) return "Не задан адрес сервера";
  if (_deviceId.isEmpty() && _cfg.claimToken.isEmpty()) return "Устройство не привязано: нужен claim-токен";
  return nullptr;
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
  restoreValues();
  _begun = true;
  _lastTick = millis();
  _uptimeMs = _lastTick;

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

  if (const char* why = missingConfig()) enterPortal(why);
  else connectWiFi();
  return _configErrors.empty();
}

void IotDevice::connectWiFi() {
  _wifiIdx = 0;
  WiFi.setAutoReconnect(true);
  beginWiFi();
  setState(State::WifiConnecting);
}

void IotDevice::beginWiFi() {
  const String& ssid = _wifiIdx ? _cfg.ssid2 : _cfg.ssid;
  const String& pass = _wifiIdx ? _cfg.wifiPass2 : _cfg.wifiPass;
  log("[iot] Wi-Fi: подключение к '%s'%s", ssid.c_str(), _wifiIdx ? " (запасная сеть)" : "");
  if (WiFi.status() != WL_CONNECTED) WiFi.disconnect();  // прервать попытки к предыдущей сети
  WiFi.begin(ssid.c_str(), pass.c_str());
  _wifiAttemptAt = millis();
}

void IotDevice::enterPortal(const String& reason) {
  if (_portal.active()) return;
  String mac = WiFi.macAddress();
  IotPortalInfo info;
  info.reason = reason;
  info.deviceId = _deviceId;
  info.mac = mac;
  info.firmware = _fw + " (SDK " IOT_DEVICE_SDK_VERSION ")";
  mac.replace(":", "");
  String ap = "IoT-" + mac.substring(mac.length() >= 4 ? mac.length() - 4 : 0);
  log("[iot] портал настройки: %s. Сеть '%s', http://192.168.4.1", reason.c_str(), ap.c_str());
  if (_portalPass.length() < 8) {
    log("[iot] ВНИМАНИЕ: точка доступа открытая — пароль Wi-Fi и токен уйдут открытым текстом. Задайте setPortal(\"пароль\")");
  }
  // Попытки подключения STA гоняют радио по каналам, и точка доступа «прыгает» вслед —
  // телефон отваливается. Пока открыт портал, STA молчит; подключение запустит connectWiFi().
  WiFi.setAutoReconnect(false);
  WiFi.disconnect();
  _portal.begin(ap, _portalPass, _cfg, _name, info);
  setState(State::Portal);
}

void IotDevice::startPortal() {
  goOffline();
  enterPortal("Портал открыт вручную");
}

void IotDevice::resetConfig() {
  _prefs.clear();
  delay(100);
  ESP.restart();
}

// NTP без блокировки: ждём до 5 с, но loop() всё это время возвращает управление скетчу
bool IotDevice::timeReady(uint32_t now) {
  if (_timeSynced) return true;
  if (!_timeRequested) {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    _timeRequested = true;
    _timeDeadline = now + kTimeWaitMs;
  }
  const bool ok = time(nullptr) >= kTimeValid;
  if (!ok && before(now, _timeDeadline)) return false;
  _timeSynced = ok;
  _timeRequested = false;  // не получилось — попробуем при следующем подключении к Wi-Fi
  log("[iot] время %s", ok ? "синхронизировано" : "не получено (проверка сертификата может не пройти)");
  return true;
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
  updateStats();  // состояние ещё не Online — значения только запоминаются и уходят ниже
  // После (пере)подключения сервер получает все текущие значения, без deadband и minInterval
  for (auto* p : _props) {
    if (!p->_valid || !p->_hasValue) continue;
    ok = ok && publish(iot::topic(id, p->_spec.name), p->_value, false);
    if (ok) p->markSent();
  }
  ok = ok && publish(willTopic, "ready", true);
  if (!ok) {
    log("[iot] MQTT: не удалось отправить начальные сообщения");
    _mqtt.disconnect();
    return false;
  }
  log("[iot] MQTT: онлайн, топики dev/%s/...", id.c_str());
  reportOtaAfterReboot();
  if (!_otaUnsent.isEmpty() && publish(iot::topic(id, "$ota"), _otaUnsent, false)) _otaUnsent = "";
  return true;
}

bool IotDevice::publish(const std::string& topic, const String& payload, bool retained) {
  if (!_mqtt.connected()) return false;
  return _mqtt.publish(topic.c_str(), payload.c_str(), retained);
}

void IotDevice::publishProperty(IotProperty& p, bool force) {
  if (!p._valid || !p._hasValue) return;
  // рано — свойство остаётся _dirty, и loop() отправит его, когда интервал истечёт
  if (!force && p._minIntervalMs && p._hasSent && millis() - p._sentAt < p._minIntervalMs) return;
  if (publish(iot::topic(Std(_deviceId), p._spec.name), p._value, false)) p.markSent();
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
  std::string raw(reinterpret_cast<const char*>(payload), len);
  if (iot::isOtaSetTopic(topic, Std(_deviceId))) {
    handleOtaCommand(raw);
    return;
  }
  std::string prop;
  if (!iot::parseSetTopic(topic, Std(_deviceId), prop)) return;

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
    if (p->_hasValue) publishProperty(*p, true);
    return;
  }

  log("[iot] команда %s = %s", prop.c_str(), canon.c_str());
  if (p->_handler(*p, S(canon))) p->store(canon, true);
  else if (p->_hasValue) publishProperty(*p, true);
}

void IotDevice::loop() {
  const uint32_t now = millis();
  const bool wifiUp = WiFi.status() == WL_CONNECTED;
  _uptimeMs += now - _lastTick;
  _lastTick = now;

  switch (_state) {
    case State::Idle:
      return;

    case State::Portal:
      if (_portal.loop()) {
        saveConfig(_portal.saved());
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
      if (!wifiUp) {
        if (!_cfg.ssid2.isEmpty() && now - _wifiAttemptAt > kWifiSwitchMs) {
          _wifiIdx ^= 1;
          beginWiFi();
        }
        if (!_everOnline && now - _stateSince > kWifiPortalAfterMs) {
          String why = "Не удаётся подключиться к Wi-Fi '" + _cfg.ssid + "'";
          if (!_cfg.ssid2.isEmpty()) why += " и '" + _cfg.ssid2 + "'";
          enterPortal(why);
        }
        return;
      }
      if (!timeReady(now)) return;
      log("[iot] Wi-Fi: %s, RSSI %d", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      _nextAttempt = millis();
      setState(_deviceId.isEmpty() ? State::Provisioning : State::MqttConnecting);
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
        _provisionRejects = 0;
        enterPortal("Сервер 3 раза отклонил claim-токен: он просрочен или уже использован. Введите новый");
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
        _authRejects = 0;
        _everOnline = true;
        setState(State::Online);
        return;
      }
      // Брокер раз за разом отвергает учётку — устройство удалили или перепривязали. Сама учётка
      // не стирается (вдруг это сбой сервера), но портал откроется: новый токен вводится там.
      if ((_mqtt.state() == MQTT_CONNECT_BAD_CREDENTIALS || _mqtt.state() == MQTT_CONNECT_UNAUTHORIZED) &&
          ++_authRejects >= kAuthRejectsToPortal) {
        _authRejects = 0;
        _mqttBackoff = 1000;
        enterPortal("Сервер отклоняет учётку устройства: его удалили или перепривязали. Введите новый claim-токен");
        return;
      }
      scheduleRetry(_mqttBackoff, kMaxBackoffMs);
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
      if (_pendingCmd.length()) {
        runCommand();
        return;
      }
      if (_otaPending) {
        runOta();
        return;
      }
      if (_statRssi && now - _statsAt >= _statsIntervalMs) updateStats();
      for (auto* p : _props) {
        if (p->_dirty) publishProperty(*p);
      }
      return;
  }
}
