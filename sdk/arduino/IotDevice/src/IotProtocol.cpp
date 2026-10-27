#include "IotProtocol.h"

#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace iot {

const char* typeName(PropType t) {
  switch (t) {
    case PropType::Boolean: return "boolean";
    case PropType::Integer: return "integer";
    case PropType::Float: return "float";
    default: return "string";
  }
}

static bool isLowerAlpha(char c) { return c >= 'a' && c <= 'z'; }
static bool isDigit(char c) { return c >= '0' && c <= '9'; }
static bool isHex(char c) { return isDigit(c) || (c >= 'a' && c <= 'f'); }

bool isValidPropName(const std::string& s) {
  if (s.empty() || s.size() > 32 || !isLowerAlpha(s[0])) return false;
  for (char c : s) {
    if (!(isLowerAlpha(c) || isDigit(c) || c == '_' || c == '-')) return false;
  }
  return true;
}

bool isValidDeviceId(const std::string& s) {
  if (s.size() != 17 || s[0] != 'd') return false;
  for (size_t i = 1; i < s.size(); i++) {
    if (!isHex(s[i])) return false;
  }
  return true;
}

bool isValidState(const std::string& s) {
  return s == "init" || s == "ready" || s == "disconnected" || s == "sleeping" || s == "lost" ||
         s == "alert";
}

std::string topic(const std::string& deviceId, const std::string& leaf) {
  return "dev/" + deviceId + "/" + leaf;
}

bool parseSetTopic(const std::string& t, const std::string& deviceId, std::string& prop) {
  const std::string prefix = "dev/" + deviceId + "/";
  const std::string suffix = "/set";
  if (t.size() <= prefix.size() + suffix.size()) return false;
  if (t.compare(0, prefix.size(), prefix) != 0) return false;
  if (t.compare(t.size() - suffix.size(), suffix.size(), suffix) != 0) return false;
  std::string p = t.substr(prefix.size(), t.size() - prefix.size() - suffix.size());
  if (!isValidPropName(p)) return false;
  prop = p;
  return true;
}

std::string trim(const std::string& s) {
  size_t b = 0, e = s.size();
  while (b < e && (s[b] == ' ' || s[b] == '\t' || s[b] == '\r' || s[b] == '\n')) b++;
  while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\r' || s[e - 1] == '\n')) e--;
  return s.substr(b, e - b);
}

std::string toLower(const std::string& s) {
  std::string r = s;
  for (char& c : r) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return r;
}

bool parseBool(const std::string& raw, bool& out) {
  const std::string v = toLower(trim(raw));
  if (v == "true" || v == "1" || v == "on" || v == "yes") { out = true; return true; }
  if (v == "false" || v == "0" || v == "off" || v == "no") { out = false; return true; }
  return false;
}

bool parseInt(const std::string& raw, long long& out) {
  const std::string v = trim(raw);
  if (v.empty() || v.size() > 20) return false;
  for (size_t i = 0; i < v.size(); i++) {
    char c = v[i];
    if (!(isDigit(c) || (i == 0 && (c == '-' || c == '+')))) return false;
  }
  if (v.size() == 1 && !isDigit(v[0])) return false;
  errno = 0;
  char* end = nullptr;
  long long n = std::strtoll(v.c_str(), &end, 10);
  if (errno == ERANGE || end == nullptr || *end != '\0') return false;
  out = n;
  return true;
}

bool parseFloat(const std::string& raw, double& out) {
  const std::string v = trim(raw);
  if (v.empty() || v.size() > 32) return false;
  bool digit = false;
  for (char c : v) {
    if (isDigit(c)) digit = true;
    else if (!(c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E')) return false;
  }
  if (!digit) return false;
  errno = 0;
  char* end = nullptr;
  double d = std::strtod(v.c_str(), &end);
  if (errno == ERANGE || end == nullptr || *end != '\0' || !std::isfinite(d)) return false;
  out = d;
  return true;
}

std::string formatInt(long long v) {
  char buf[24];
  std::snprintf(buf, sizeof(buf), "%lld", v);
  return buf;
}

std::string formatFloat(double v, int decimals) {
  if (!std::isfinite(v)) return "";
  if (decimals < 0) decimals = 0;
  if (decimals > 6) decimals = 6;
  char buf[40];
  int n = std::snprintf(buf, sizeof(buf), "%.*f", decimals, v);
  if (n <= 0 || n >= static_cast<int>(sizeof(buf))) return "";
  std::string s(buf);
  if (s == "-0" || s.find_first_not_of("-0.") == std::string::npos) {
    // "-0.00" -> "0.00"
    if (!s.empty() && s[0] == '-') s.erase(0, 1);
  }
  return s;
}

static bool inRange(const PropSpec& spec, double v) {
  return !spec.hasRange || (v >= spec.min && v <= spec.max);
}

bool normalizeValue(const PropSpec& spec, const std::string& raw, std::string& out) {
  switch (spec.type) {
    case PropType::Boolean: {
      bool b;
      if (!parseBool(raw, b)) return false;
      out = b ? "true" : "false";
      return true;
    }
    case PropType::Integer: {
      long long n;
      if (!parseInt(raw, n) || !inRange(spec, static_cast<double>(n))) return false;
      out = formatInt(n);
      return true;
    }
    case PropType::Float: {
      double d;
      if (!parseFloat(raw, d) || !inRange(spec, d)) return false;
      out = formatFloat(d, spec.decimals);
      return !out.empty();
    }
    default: {
      if (raw.size() > kMaxValueLen) return false;
      out = raw;
      return true;
    }
  }
}

std::string jsonEscape(const std::string& s) {
  std::string r;
  r.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': r += "\\\""; break;
      case '\\': r += "\\\\"; break;
      case '\n': r += "\\n"; break;
      case '\r': r += "\\r"; break;
      case '\t': r += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          r += buf;
        } else {
          r += static_cast<char>(c);  // UTF-8 проходит как есть
        }
    }
  }
  return r;
}

std::string htmlEscape(const std::string& s) {
  std::string r;
  r.reserve(s.size() + 8);
  for (char c : s) {
    switch (c) {
      case '&': r += "&amp;"; break;
      case '<': r += "&lt;"; break;
      case '>': r += "&gt;"; break;
      case '"': r += "&quot;"; break;
      case '\'': r += "&#39;"; break;
      default: r += c;
    }
  }
  return r;
}

static std::string jsonNumber(double v) {
  std::string s = formatFloat(v, 6);
  if (s.empty()) return "0";
  // убрать хвостовые нули: 10.500000 -> 10.5, 3.000000 -> 3
  if (s.find('.') != std::string::npos) {
    while (!s.empty() && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
  }
  return s;
}

std::string buildMeta(const std::string& name, const std::string& fw, const std::vector<PropSpec>& props) {
  std::string j = "{\"name\":\"" + jsonEscape(name) + "\",\"fw\":\"" + jsonEscape(fw) + "\",\"props\":{";
  bool first = true;
  for (const auto& p : props) {
    if (!first) j += ',';
    first = false;
    j += "\"" + jsonEscape(p.name) + "\":{\"type\":\"" + typeName(p.type) + "\"";
    if (!p.unit.empty()) j += ",\"unit\":\"" + jsonEscape(p.unit) + "\"";
    if (p.settable) j += ",\"settable\":true";
    if (p.hasRange) j += ",\"min\":" + jsonNumber(p.min) + ",\"max\":" + jsonNumber(p.max);
    j += '}';
  }
  j += "}}";
  return j;
}

std::string buildProvisionRequest(const std::string& claimToken) {
  return "{\"claim_token\":\"" + jsonEscape(claimToken) + "\"}";
}

static void skipWs(const std::string& s, size_t& i) {
  while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
}

bool jsonGetString(const std::string& json, const std::string& key, std::string& out) {
  const std::string needle = "\"" + key + "\"";
  size_t pos = 0;
  while ((pos = json.find(needle, pos)) != std::string::npos) {
    size_t i = pos + needle.size();
    skipWs(json, i);
    if (i >= json.size() || json[i] != ':') { pos = i; continue; }
    i++;
    skipWs(json, i);
    if (i >= json.size() || json[i] != '"') return false;  // значение не строка
    i++;
    std::string v;
    while (i < json.size()) {
      char c = json[i++];
      if (c == '"') { out = v; return true; }
      if (c != '\\') { v += c; continue; }
      if (i >= json.size()) return false;
      char e = json[i++];
      switch (e) {
        case '"': v += '"'; break;
        case '\\': v += '\\'; break;
        case '/': v += '/'; break;
        case 'n': v += '\n'; break;
        case 'r': v += '\r'; break;
        case 't': v += '\t'; break;
        case 'u': {
          if (i + 4 > json.size()) return false;
          unsigned code = static_cast<unsigned>(std::strtoul(json.substr(i, 4).c_str(), nullptr, 16));
          i += 4;
          if (code >= 0x80) return false;  // нашим полям хватает ASCII
          v += static_cast<char>(code);
          break;
        }
        default: return false;
      }
    }
    return false;
  }
  return false;
}

std::string kvEncode(const std::map<std::string, std::string>& kv) {
  std::string out;
  for (const auto& [k, v] : kv) {
    out += k;
    out += '=';
    for (char c : v) {
      if (c == '\\') out += "\\\\";
      else if (c == '\n') out += "\\n";
      else if (c == '\r') out += "\\r";
      else out += c;
    }
    out += '\n';
  }
  return out;
}

std::map<std::string, std::string> kvDecode(const std::string& text) {
  std::map<std::string, std::string> kv;
  size_t pos = 0;
  while (pos < text.size()) {
    size_t end = text.find('\n', pos);
    if (end == std::string::npos) end = text.size();
    const std::string line = text.substr(pos, end - pos);
    pos = end + 1;
    const size_t eq = line.find('=');
    if (eq == std::string::npos || eq == 0) continue;
    std::string v;
    for (size_t i = eq + 1; i < line.size(); i++) {
      if (line[i] == '\\' && i + 1 < line.size()) {
        char e = line[++i];
        v += e == 'n' ? '\n' : e == 'r' ? '\r' : e;
      } else {
        v += line[i];
      }
    }
    kv[line.substr(0, eq)] = v;
  }
  return kv;
}

}  // namespace iot
