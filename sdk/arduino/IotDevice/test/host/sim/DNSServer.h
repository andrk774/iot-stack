#pragma once
#include "Arduino.h"
enum class DNSReplyCode : uint16_t { NoError = 0, FormError = 1, ServerFailure = 2, NonExistentDomain = 3 };
class DNSServer {
 public:
  void processNextRequest() {}
  void setErrorReplyCode(const DNSReplyCode& replyCode) { (void)replyCode; }
  bool start(uint16_t port, const String& domainName, const IPAddress& resolvedIP) { (void)port; (void)domainName; (void)resolvedIP; return true; }
  void stop() {}
};
