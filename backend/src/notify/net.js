// Исходящие запросы по адресам, которые задал пользователь (вебхуки, web push).
// Бэкенд стоит во внутренней docker-сети рядом с EMQX и PostgreSQL, поэтому адрес проверяется
// после разрешения DNS — и соединение идёт именно на проверенный IP (без DNS rebinding).
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]]) {
  blocked.addSubnet(a, p, 'ipv6');
}

export function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return !blocked.check(mapped[1], 'ipv4');
    return !blocked.check(ip, 'ipv6');
  }
  return false;
}

export class OutboundError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** Проверка URL без сети: https, без логина в URL, IP-адрес не из внутренних сетей */
export function checkUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new OutboundError('bad_url', 'некорректный URL');
  }
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new OutboundError('bad_url', 'нужен https://');
  if (u.username || u.password) throw new OutboundError('bad_url', 'логин и пароль в URL не поддерживаются');
  if (raw.length > 2048) throw new OutboundError('bad_url', 'слишком длинный URL');
  // IP в URL обходит lookup — проверяем сразу
  const literal = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && net.isIP(literal) && !isPublicAddress(literal)) {
    throw new OutboundError('private_address', 'адрес во внутренней сети');
  }
  return u;
}

function guardedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const ok = allowPrivate ? addrs : addrs.filter((a) => isPublicAddress(a.address));
      if (!ok.length) return cb(new OutboundError('private_address', `${hostname} указывает во внутреннюю сеть`));
      if (options.all) return cb(null, ok);
      return cb(null, ok[0].address, ok[0].family);
    });
  };
}

/**
 * POST без редиректов, с таймаутом и ограничением размера ответа.
 * allowPrivate — только для тестов и локальной разработки.
 * @returns {Promise<{status: number, body: string}>}
 */
export function postOut(rawUrl, { headers = {}, body = '', timeoutMs = 10_000, allowPrivate = false, maxResponse = 16 * 1024 } = {}) {
  const u = checkUrl(rawUrl, { allowPrivate });
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'user-agent': 'iot-stack', 'content-length': Buffer.byteLength(body), ...headers },
      lookup: guardedLookup(allowPrivate),
      timeout: timeoutMs,
    }, (res) => {
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size <= maxResponse) chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new OutboundError('timeout', `нет ответа за ${timeoutMs / 1000} с`)));
    req.on('error', (e) => reject(e instanceof OutboundError ? e : new OutboundError('network', e.message)));
    req.end(body);
  });
}
