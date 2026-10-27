#pragma once
#include <functional>
#include "Arduino.h"
#include "Sim.h"
typedef enum { HTTP_ANY, HTTP_GET, HTTP_HEAD, HTTP_POST } HTTPMethod;
class Uri { public: Uri(const char* u) : _u(u) {} std::string _u; };
class RequestHandler {};
class WebServer {
 public:
  typedef std::function<void(void)> THandlerFunction;
  WebServer(int port = 80) { (void)port; }
  virtual ~WebServer() {}
  virtual void begin() { web.begun = true; }
  virtual void handleClient() {}
  void stop() { web.begun = false; }
  RequestHandler& on(const Uri& uri, HTTPMethod method, THandlerFunction fn) { (void)method; web.onCalls++; web.routes[uri._u] = fn; return _h; }
  void onNotFound(THandlerFunction fn) { web.onCalls++; web.notFound = fn; }
  String arg(const String& name) const { auto it = web.args.find(name.c_str()); return it == web.args.end() ? String() : String(it->second.c_str()); }
  bool hasArg(const String& name) const { return web.args.count(name.c_str()) > 0; }
  void send(int code, const char* content_type = NULL, const String& content = String("")) { (void)content_type; web.lastCode = code; web.lastBody = content.c_str(); }
  void sendHeader(const String& name, const String& value, bool first = false) { (void)name; (void)value; (void)first; }
 private:
  RequestHandler _h;
};
