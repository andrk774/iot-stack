// Различия ESP32 и ESP8266 в одном месте.
#pragma once

#include <Arduino.h>

#if defined(ESP8266)
#include <ESP8266HTTPClient.h>
#include <ESP8266WebServer.h>
#include <ESP8266WiFi.h>
#include <Updater.h>           // Update (OTA)
#include <WiFiClientSecure.h>  // BearSSL
extern "C" {
#include <user_interface.h>
}
using IotWebServer = ESP8266WebServer;
#define IOT_UPDATE_ERROR() Update.getErrorString()
#define IOT_INPUT_PULLDOWN INPUT  // на ESP8266 подтяжка вниз есть только у GPIO16

// Причина последней перезагрузки — одинаковые строки на обеих платах
inline const char* iotResetReason() {
  switch (ESP.getResetInfoPtr()->reason) {
    case REASON_DEFAULT_RST: return "power_on";
    case REASON_WDT_RST:
    case REASON_SOFT_WDT_RST: return "watchdog";
    case REASON_EXCEPTION_RST: return "panic";
    case REASON_SOFT_RESTART: return "software";
    case REASON_DEEP_SLEEP_AWAKE: return "deep_sleep";
    case REASON_EXT_SYS_RST: return "external";
    default: return "unknown";
  }
}

// 0 — спать, пока не разбудят извне. Для пробуждения по таймеру GPIO16 соединяют с RST.
inline void iotDeepSleep(uint64_t us) { ESP.deepSleep(us); }
#elif defined(ESP32)
#include <HTTPClient.h>
#include <Update.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_sleep.h>
#include <esp_system.h>

inline void iotDeepSleep(uint64_t us) {
  if (us) esp_sleep_enable_timer_wakeup(us);
  esp_deep_sleep_start();
}
using IotWebServer = WebServer;
#define IOT_INPUT_PULLDOWN INPUT_PULLDOWN
#define IOT_UPDATE_ERROR() String(Update.errorString())

inline const char* iotResetReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_EXT: return "external";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    default: return "unknown";
  }
}
#else
#error "IotDevice: поддерживаются ESP32 и ESP8266"
#endif

#include <DNSServer.h>
