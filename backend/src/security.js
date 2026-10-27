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
