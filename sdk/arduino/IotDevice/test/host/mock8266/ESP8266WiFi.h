#pragma once
#include "Arduino.h"
typedef enum { WL_IDLE_STATUS = 0, WL_CONNECTED = 3, WL_DISCONNECTED = 6 } wl_status_t;
typedef enum { WIFI_MODE_NULL, WIFI_MODE_STA, WIFI_MODE_AP, WIFI_MODE_APSTA } wifi_mode_t;
#define WIFI_STA WIFI_MODE_STA
#define WIFI_AP_STA WIFI_MODE_APSTA
#define WIFI_SCAN_RUNNING (-1)
#define WIFI_SCAN_FAILED (-2)
class WiFiClass {
 public:
  static bool mode(wifi_mode_t) { return true; }
  void persistent(bool) {}
  bool setAutoReconnect(bool) { return true; }
  bool disconnect(bool wifioff = false) { (void)wifioff; return true; }
  wl_status_t begin(const char* ssid, const char* passphrase = NULL, int32_t channel = 0, const uint8_t* bssid = NULL, bool tryConnect = true) { (void)ssid; (void)passphrase; (void)channel; (void)bssid; (void)tryConnect; return WL_DISCONNECTED; }
  wl_status_t status() { return WL_DISCONNECTED; }
  IPAddress localIP() { return IPAddress(); }
  int8_t RSSI() { return -60; }
  String macAddress() { return "AA:BB:CC:DD:EE:FF"; }
  bool softAP(const char* ssid, const char* passphrase = NULL, int channel = 1, int ssid_hidden = 0, int max_connection = 4) { (void)ssid; (void)passphrase; (void)channel; (void)ssid_hidden; (void)max_connection; return true; }
  int8_t scanNetworks(bool async = false, bool show_hidden = false, uint8_t channel = 0, uint8_t* ssid = NULL) { (void)async; (void)show_hidden; (void)channel; (void)ssid; return WIFI_SCAN_RUNNING; }
  int8_t scanComplete() { return WIFI_SCAN_FAILED; }
  void scanDelete() {}
  String SSID(uint8_t i) { (void)i; return String(); }
  int32_t RSSI(uint8_t i) { (void)i; return 0; }
  IPAddress softAPIP() { return IPAddress(0x0104A8C0); }
  bool softAPdisconnect(bool wifioff = false) { (void)wifioff; return true; }
};
extern WiFiClass WiFi;
