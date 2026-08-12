#pragma once
#include <Arduino.h>
#define WL_CONNECTED 3
enum WiFiMode { WIFI_OFF, WIFI_STA, WIFI_AP, WIFI_AP_STA };
class IPAddress {
 public:
  String toString() const { return String("0.0.0.0"); }
  operator uint32_t() const { return 0; }  // real Arduino IPAddress has this
};
class WiFiClassStub {
public:
  void mode(int) {}
  bool softAP(const char*) { return true; }
  bool softAP(const char*, const char*) { return true; }
  IPAddress softAPIP() { return IPAddress(); }
  void setHostname(const char*) {}
  void begin(const char*, const char*) {}
  void disconnect(bool = false) {}
  int status() { return WL_CONNECTED; }
  IPAddress localIP() { return IPAddress(); }
};
static WiFiClassStub WiFi;
