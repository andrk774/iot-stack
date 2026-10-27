// Различия ESP32 и ESP8266 в одном месте.
#pragma once

#include <Arduino.h>

#if defined(ESP8266)
#include <ESP8266HTTPClient.h>
#include <ESP8266WebServer.h>
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>  // BearSSL
using IotWebServer = ESP8266WebServer;
#define IOT_INPUT_PULLDOWN INPUT  // на ESP8266 подтяжка вниз есть только у GPIO16
#elif defined(ESP32)
#include <HTTPClient.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
using IotWebServer = WebServer;
#define IOT_INPUT_PULLDOWN INPUT_PULLDOWN
#else
#error "IotDevice: поддерживаются ESP32 и ESP8266"
#endif

#include <DNSServer.h>
