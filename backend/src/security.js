import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

/** Хэш пароля/секрета: scrypt$N$r$p$salt$key */
export async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(secret, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifySecret(secret, stored) {
  if (typeof secret !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, key] = parts;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(secret, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
}

/** Сравнение строк за постоянное время */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newDeviceId = () => 'd' + crypto.randomBytes(8).toString('hex');

// ---------- JWT HS256 (без внешних зависимостей) ----------
const b64json = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const JWT_HEADER = b64json({ alg: 'HS256', typ: 'JWT' });
const hmac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function signJwt(payload, secret, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64json({ ...payload, iat: now, exp: now + ttlSec });
  const data = `${JWT_HEADER}.${body}`;
  return `${data}.${hmac(data, secret)}`;
}

export function verifyJwt(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== JWT_HEADER) return null; // жёстко HS256
  const expected = hmac(`${parts[0]}.${parts[1]}`, secret);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload?.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ---------- TOTP (RFC 6238, SHA-1, 6 цифр, шаг 30 с) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('bad base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function totpCode(secretB32, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = (mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(bin).padStart(6, '0');
}

/**
 * Проверить код с окном ±1 шаг. lastStep — последний принятый шаг (повтор того же кода не проходит).
 * Возвращает принятый шаг или null.
 */
export function verifyTotp(secretB32, code, { now = Date.now(), lastStep = 0, window = 1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const cur = Math.floor(now / 1000 / 30);
  for (let d = -window; d <= window; d++) {
    const step = cur + d;
    if (step <= lastStep) continue;
    const expected = totpCode(secretB32, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(secretB32, account, issuer = 'Домашний IoT') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${q}`;
}

/** 10 одноразовых кодов восстановления вида xxxx-xxxx-xxxx */
export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const s = base32Encode(crypto.randomBytes(8)).toLowerCase().slice(0, 12);
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
  });
}
export const normalizeRecoveryCode = (c) => String(c).toLowerCase().replace(/[^a-z2-7]/g, '');
