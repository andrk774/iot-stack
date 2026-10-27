#pragma once
#include <functional>
#include "Arduino.h"
typedef enum { HTTP_ANY, HTTP_GET, HTTP_HEAD, HTTP_POST } HTTPMethod;
class Uri { public: Uri(const char* u) : _u(u) {} private: String _u; };
class RequestHandler {};
class WebServer {
 public:
  typedef std::function<void(void)> THandlerFunction;
  WebServer(int port = 80) { (void)port; }
  virtual ~WebServer() {}
  virtual void begin() {}
  virtual void handleClient() {}
  void stop() {}
  RequestHandler& on(const Uri& uri, HTTPMethod method, THandlerFunction fn) { (void)uri; (void)method; (void)fn; return _h; }
  void onNotFound(THandlerFunction fn) { (void)fn; }
  String arg(const String& name) const { (void)name; return String(); }
  bool hasArg(const String& name) const { (void)name; return false; }
  void send(int code, const char* content_type = NULL, const String& content = String("")) { (void)code; (void)content_type; (void)content; }
  void sendHeader(const String& name, const String& value, bool first = false) { (void)name; (void)value; (void)first; }
 private:
  RequestHandler _h;
};
