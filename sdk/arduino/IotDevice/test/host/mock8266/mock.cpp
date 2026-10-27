#include "Arduino.h"
#include "ESP8266WiFi.h"
#include "LittleFS.h"
HardwareSerial Serial;
WiFiClass WiFi;
EspClass ESP;
String IPAddress::toString() const { return String("192.168.4.1"); }
unsigned long millis() { return 0; }
void delay(uint32_t) {}
void yield() {}
void pinMode(uint8_t, uint8_t) {}
int digitalRead(uint8_t) { return HIGH; }
void digitalWrite(uint8_t, uint8_t) {}
long random(long a, long) { return a; }
FS LittleFS;
void configTime(long, int, const char*, const char*, const char*) {}
void EspClass::restart() {}
