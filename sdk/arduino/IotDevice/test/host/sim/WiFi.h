#pragma once
#include "Arduino.h"
#include "Sim.h"
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
  bool setAutoReconnect(bool v) { sim.autoReconnect = v; return true; }
  bool disconnect(bool wifioff = false) { (void)wifioff; sim.wifiDisconnects++; sim.wifiUp = false; return true; }
  wl_status_t begin(const char* ssid, const char* passphrase = NULL, int32_t channel = 0, const uint8_t* bssid = NULL, bool tryConnect = true) {
    (void)passphrase; (void)channel; (void)bssid; (void)tryConnect; sim.wifiBegins++; sim.wifiSsid = ssid ? ssid : ""; return WL_DISCONNECTED;
  }
  wl_status_t status() {
    const bool up = sim.reachableSsid.empty() ? sim.wifiUp : sim.wifiSsid == sim.reachableSsid;
    return up ? WL_CONNECTED : WL_DISCONNECTED;
  }
  IPAddress localIP() { return IPAddress(); }
  int8_t RSSI() { return -60; }
  String macAddress() { return "AA:BB:CC:DD:EE:FF"; }
  bool softAP(const char* ssid, const char* passphrase = NULL, int channel = 1, int ssid_hidden = 0, int max_connection = 4) {
    (void)ssid; (void)channel; (void)ssid_hidden; (void)max_connection;
    sim.softApOn = true; sim.softApPass = passphrase ? passphrase : ""; return true;
  }
  int16_t scanNetworks(bool async = false, bool show_hidden = false, bool passive = false, uint32_t max_ms_per_chan = 300, uint8_t channel = 0, const char* ssid = nullptr, const uint8_t* bssid = nullptr) {
    (void)show_hidden; (void)passive; (void)max_ms_per_chan; (void)channel; (void)ssid; (void)bssid;
    sim.scanStarts++;
    return async ? WIFI_SCAN_RUNNING : (int16_t)sim.scanResults.size();
  }
  int16_t scanComplete() { return sim.scanDone ? (int16_t)sim.scanResults.size() : WIFI_SCAN_RUNNING; }
  void scanDelete() {}
  String SSID(uint8_t i) { return String(sim.scanResults[i].first.c_str()); }
  int32_t RSSI(uint8_t i) { return sim.scanResults[i].second; }
  IPAddress softAPIP() { return IPAddress(0x0104A8C0); }
  bool softAPdisconnect(bool wifioff = false) { (void)wifioff; sim.softApOn = false; return true; }
};
extern WiFiClass WiFi;
