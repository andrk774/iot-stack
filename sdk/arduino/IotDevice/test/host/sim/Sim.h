// Управляемое окружение для поведенческих тестов IotDevice на ПК.
#pragma once
#include <functional>
#include <map>
#include <string>
#include <vector>

struct SimPublish {
  std::string topic;
  std::string payload;
  bool retain;
};

struct Sim {
  // время
  unsigned long millis = 0;
  // Wi-Fi
  bool wifiUp = false;
  bool autoReconnect = true;
  int wifiBegins = 0, wifiDisconnects = 0;
  std::string softApPass;
  bool softApOn = false;
  // NVS: переживает «перезагрузку» (новый IotDevice)
  std::map<std::string, std::string> nvs;
  int nvsMissingReads = 0;  // getString/getUShort по отсутствующему ключу (на ESP32 это ошибка в логе)
  // HTTP (provision)
  int httpCode = 200;
  std::string httpBody;
  int httpPosts = 0;
  std::string httpLastBody;
  // брокер
  bool brokerUp = true;
  int connack = 0;  // 0 — принять, 5 — not authorized
  std::vector<SimPublish> published;
  std::vector<std::string> subscribed;
  std::string lastUser, lastPass, lastClientId, willTopic, willPayload;
  int connects = 0, disconnects = 0;
  std::vector<std::string> events;  // порядок: "pub:<topic>", "disconnect"
  std::string rx;                   // байты к устройству
  bool restarted = false;

  void reset() { *this = Sim(); }
  void sendToDevice(const std::string& topic, const std::string& payload);
  const SimPublish* last(const std::string& topic) const {
    for (auto it = published.rbegin(); it != published.rend(); ++it) if (it->topic == topic) return &*it;
    return nullptr;
  }
};
extern Sim sim;

// веб-сервер портала
struct SimWeb {
  int onCalls = 0;
  std::map<std::string, std::function<void()>> routes;
  std::function<void()> notFound;
  std::map<std::string, std::string> args;
  int lastCode = 0;
  std::string lastBody;
  bool begun = false;
};
extern SimWeb web;
