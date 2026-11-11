// IotDevice — SDK для подключения ESP32 к самохостинговой IoT-платформе.
//
//   IotDevice device("Кухня", "1.0.0");
//   IotProperty& temp  = device.addFloat("temperature", "°C", 1);
//   IotProperty& relay = device.addBool("relay").onSet([](IotProperty& p, const String& v) {
//     digitalWrite(RELAY_PIN, v == "true");
//     return true;                      // принять значение и отправить его обратно серверу
//   });
//   setup(): device.setCaCert(CA); device.begin();
//   loop():  device.loop(); temp.setFloat(readTemp());
#pragma once

#include "IotPlatform.h"
#include <PubSubClient.h>

#include <functional>
#include <map>
#include <vector>

#include "IotPortal.h"
#include "IotProtocol.h"
#include "IotStorage.h"

#define IOT_DEVICE_SDK_VERSION "0.4.0"

class IotDevice;

class IotProperty {
 public:
  // Обработчик команды с сервера. value уже приведено к типу свойства
  // ("true"/"false", "42", "21.50", текст). Вернуть true — принять (значение
  // сохранится и уйдёт серверу), false — отклонить (серверу уйдёт прежнее значение).
  using SetHandler = std::function<bool(IotProperty& prop, const String& value)>;

  IotProperty& onSet(SetHandler handler);           // делает свойство settable
  IotProperty& range(double min, double max);       // для Integer/Float, проверяется и сервером через $meta
  IotProperty& unit(const char* unit);
  // Отправлять не чаще раза в ms. Промежуточные значения не теряются: последнее уйдёт,
  // как только интервал истечёт.
  IotProperty& minInterval(uint32_t ms);
  // Отправлять, только если значение отличается от последнего отправленного на delta и больше
  // (для bool/string и delta = 0 — при любом изменении). value() при этом всегда текущее.
  IotProperty& deadband(double delta);
  // Хранить значение во флеше: при старте begin() восстановит его и вызовет onSet,
  // чтобы «железо» (реле, ШИМ) вернулось в прежнее состояние. Начальное значение
  // по умолчанию задавайте до begin() — вызов set*() после begin() перезапишет восстановленное.
  IotProperty& persist();

  void setBool(bool v);
  void setInt(long long v);
  void setFloat(double v);
  void setString(const String& v);

  const String& value() const { return _value; }
  bool hasValue() const { return _hasValue; }
  bool boolValue() const { return _value == "true"; }
  long long intValue() const { return atoll(_value.c_str()); }
  double floatValue() const { return atof(_value.c_str()); }
  const char* name() const { return _spec.name.c_str(); }
  iot::PropType type() const { return _spec.type; }
  // false — имя недопустимо или повторяется: свойство не попадёт в $meta и не будет публиковаться
  bool valid() const { return _valid; }

 private:
  friend class IotDevice;
  IotProperty(IotDevice* dev, const char* name, iot::PropType type);
  // fromServer — подтверждение команды: уходит сразу, без deadband и minInterval
  void store(const std::string& canonical, bool fromServer = false);
  bool worthSending() const;
  void markSent();

  IotDevice* _dev;
  iot::PropSpec _spec;
  SetHandler _handler;
  String _value;
  bool _hasValue = false;
  bool _dirty = false;
  bool _valid = true;
  bool _persist = false;
  uint32_t _minIntervalMs = 0;
  double _deadband = -1;  // < 0 — выключено
  String _sent;           // последнее отправленное серверу
  bool _hasSent = false;
  uint32_t _sentAt = 0;
};

class IotDevice {
 public:
  enum class State : uint8_t { Idle, Portal, WifiConnecting, Provisioning, MqttConnecting, Online };

  explicit IotDevice(const char* name, const char* firmwareVersion = "1.0.0");

  // ---- свойства (вызывать до begin) ----
  IotProperty& addBool(const char* name);
  IotProperty& addInt(const char* name, const char* unit = nullptr);
  IotProperty& addFloat(const char* name, const char* unit = nullptr, int decimals = 2);
  IotProperty& addString(const char* name);
  // Строка из фиксированного набора: команды с другими значениями SDK отклонит сам.
  // В $meta — "type":"string" и "enum":[...]
  IotProperty& addEnum(const char* name, std::initializer_list<const char*> values);

  // ---- настройки (вызывать до begin) ----
  // Значения по умолчанию; то, что сохранено через портал, имеет приоритет.
  void setWiFi(const char* ssid, const char* password);
  // Запасная сеть: если текущая недоступна 20 с, устройство пробует другую
  void setWiFiFallback(const char* ssid, const char* password);
  void setServer(const char* host, uint16_t mqttPort = 8883);
  void setClaimToken(const char* token);
  void setCaCert(const char* pem);          // корневой сертификат сервера (обязателен, если не setInsecure)
  void setInsecure();                       // без проверки сертификата — только для отладки!
  void setConfigButton(int pin, bool activeLow = true);  // удержание 3 с при старте = сброс настроек
  void setPortal(const char* apPassword = nullptr, uint32_t timeoutSec = 300);
  void setDebug(Stream* out);               // например &Serial
  // Служебные свойства rssi (dBm), uptime (s), free_heap (B), reset_reason, ip.
  // rssi/uptime/free_heap отправляются раз в intervalSec, reset_reason и ip — при подключении и изменении.
  void enableStats(uint32_t intervalSec = 60);
  // Служебные команды через settable-свойство cmd: reboot, portal, reset, identify.
  // Отправляются обычной командой: POST /api/devices/<id>/commands {"property":"cmd","value":"reboot"}
  void enableCommands();
  // Обновление прошивки из панели (OTA). Выключено, пока не включите явно.
  // Команда приходит в dev/<id>/$ota/set, ход и итог устройство сообщает в dev/<id>/$ota.
  // Перед перезагрузкой в новую прошивку вызывается onOtaReboot (выключить нагрузку, сохранить состояние).
  void enableOta(bool on = true) { _otaEnabled = on; }
  void onOtaReboot(std::function<void()> cb) { _onOtaReboot = cb; }

  void onStateChange(std::function<void(State)> cb) { _onState = cb; }
  // Команда identify: помигать светодиодом, пискнуть — чтобы найти устройство физически
  void onIdentify(std::function<void()> cb) { _onIdentify = cb; }
  // Перед OTA: вернуть false, чтобы отказаться (например, идёт нагрев). Без обработчика — разрешено.
  void onOtaStart(std::function<bool()> cb) { _onOtaStart = cb; }

  // false — в конфигурации есть ошибки (недопустимые имена свойств, слишком большой $meta).
  // Сами ошибки выводятся через setDebug и доступны в configErrors().
  bool begin();
  void loop();

  // Отправить собственный $state: только "ready", "sleeping" или "alert"
  // (init/lost/disconnected выставляет сам SDK или брокер)
  bool publishState(const char* state);
  void resetConfig();                       // стереть всё из NVS и перезагрузиться
  void startPortal();                       // открыть портал настройки вручную
  // Глубокий сон для батарейных устройств: отправить накопленные значения, $state = sleeping,
  // штатно отключиться и уснуть. 0 — до внешнего пробуждения. На ESP8266 для пробуждения
  // по таймеру GPIO16 соединяют с RST. После пробуждения устройство стартует заново (setup()).
  void deepSleep(uint32_t seconds);
  // Есть значения, которые ещё не ушли на сервер (офлайн, minInterval)
  bool pending() const;

  bool online() const { return _state == State::Online; }
  State state() const { return _state; }
  const String& deviceId() const { return _deviceId; }
  const std::vector<String>& configErrors() const { return _configErrors; }
  static const char* stateName(State s);

 private:
  friend class IotProperty;
  enum class ProvisionResult : uint8_t { Ok, Rejected, Error };

  IotProperty& add(const char* name, iot::PropType type);
  void setState(State s);
  void loadConfig();
  bool needsPortal() const;
  const char* missingConfig() const;
  void enterPortal(const String& reason);
  void connectWiFi();
  void beginWiFi();
  bool timeReady(uint32_t now);
  void saveConfig(const IotConfig& c);
  bool onCommand(const String& cmd);
  void runCommand();
  void handleOtaCommand(const std::string& json);
  void runOta();
  void reportOta(const std::string& job, const char* status, int progress = -1, const String& error = String());
  void reportOtaAfterReboot();
  void goOffline();
  bool afterBegin(const char* what);
  ProvisionResult provision();
  bool connectMqtt();
  void onMqttMessage(char* topic, uint8_t* payload, unsigned int len);
  void publishProperty(IotProperty& p, bool force = false);
  void persistValue(IotProperty& p);
  void restoreValues();
  void updateStats();
  bool publish(const std::string& topic, const String& payload, bool retained);
  void scheduleRetry(uint32_t& backoffMs, uint32_t maxMs);
  void applyTls(WiFiClientSecure& client);
  void saveCredentials();
  std::vector<iot::PropSpec> metaSpecs() const;
  void configError(const char* fmt, ...);
  void log(const char* fmt, ...);

  String _name, _fw;
  std::vector<IotProperty*> _props;
  std::vector<String> _configErrors;  // копятся до begin(): setDebug обычно вызывают позже объявления свойств
  bool _metaOk = true;                // $meta помещается в лимиты сервера и буфер MQTT
  bool _begun = false;
  std::map<std::string, std::string> _persisted;  // то, что лежит во флеше под ключом "pv"

  IotProperty* _statRssi = nullptr;
  IotProperty* _statUptime = nullptr;
  IotProperty* _statHeap = nullptr;
  IotProperty* _statReset = nullptr;
  IotProperty* _statIp = nullptr;
  uint32_t _statsIntervalMs = 0;
  uint32_t _statsAt = 0;
  uint64_t _uptimeMs = 0;             // millis() переполняется через 49 дней, а этот счётчик — нет
  uint32_t _lastTick = 0;

  IotProperty* _cmd = nullptr;
  String _pendingCmd;                 // выполняется в loop(), после того как подтверждение ушло серверу
  std::function<void()> _onIdentify;

  bool _otaEnabled = false;
  bool _otaPending = false;
  iot::OtaRequest _ota;
  String _otaUnsent;                  // отчёт, который не удалось отправить (MQTT был закрыт)
  std::function<bool()> _onOtaStart;
  std::function<void()> _onOtaReboot;

  IotConfig _cfg;            // итоговая конфигурация (NVS поверх значений по умолчанию)
  IotConfig _defaults;
  String _deviceId, _mqttPass, _claimUsed;
  const char* _caCert = nullptr;
  bool _insecure = false;
  int _buttonPin = -1;
  bool _buttonActiveLow = true;
  String _portalPass;
  uint32_t _portalTimeoutMs = 300000;

  IotStorage _prefs;
  WiFiClientSecure _tls;
#if defined(ESP8266)
  BearSSL::X509List* _trust = nullptr;  // должен жить, пока жив TLS-клиент
#endif
  PubSubClient _mqtt;
  IotPortal _portal;
  Stream* _log = nullptr;

  State _state = State::Idle;
  uint32_t _stateSince = 0;
  uint32_t _nextAttempt = 0;
  uint32_t _provisionBackoff = 2000;
  uint32_t _mqttBackoff = 1000;
  uint8_t _provisionRejects = 0;
  uint8_t _authRejects = 0;           // брокер подряд отверг учётку
  bool _everOnline = false;
  bool _timeSynced = false;
  bool _timeRequested = false;
  uint32_t _timeDeadline = 0;
  uint8_t _wifiIdx = 0;               // 0 — основная сеть, 1 — запасная
  uint32_t _wifiAttemptAt = 0;
  std::function<void(State)> _onState;
};
