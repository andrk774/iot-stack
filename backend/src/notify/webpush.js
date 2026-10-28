// Web Push без внешних библиотек: шифрование aes128gcm (RFC 8291, RFC 8188) и VAPID (RFC 8292).
// Ключи VAPID создаются при первом запуске и хранятся в таблице server_settings.
import crypto from 'node:crypto';
import { postOut } from './net.js';
import { PermanentError } from './dispatcher.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const RECORD_SIZE = 4096;

/** Проверка ключей подписки браузера: p256dh — несжатая точка P-256 (65 байт), auth — 16 байт */
export function checkSubscriptionKeys(p256dh, auth) {
  try {
    const pub = unb64u(p256dh);
    if (pub.length !== 65 || pub[0] !== 0x04 || unb64u(auth).length !== 16) return false;
    const probe = crypto.createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(pub); // бросит, если точка не на кривой
    return true;
  } catch {
    return false;
  }
}

/**
 * Зашифровать сообщение для подписки (RFC 8291). Возвращает тело запроса.
 * asKeys и salt — только для тестов.
 */
export function encryptPayload(plaintext, p256dh, authSecret, { asKeys, salt = crypto.randomBytes(16) } = {}) {
  const uaPublic = unb64u(p256dh);
  const auth = unb64u(authSecret);
  const ecdh = crypto.createECDH('prime256v1');
  if (asKeys) ecdh.setPrivateKey(asKeys.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]); // 0x02 — последняя запись, без дополнения
  if (data.length + 16 > RECORD_SIZE) throw new Error('payload too large');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** Расшифровка (сторона браузера) — для тестов */
export function decryptPayload(body, uaPrivateKey, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivateKey);
  const uaPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, unb64u(authSecret), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 0x02) throw new Error('bad padding delimiter');
  return plain.subarray(0, end).toString('utf8');
}

/** VAPID JWT (ES256) для origin push-сервиса */
export function vapidAuthorization(endpoint, keys, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const data = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: keys.privateKeyObject, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${keys.publicKey}`;
}

export function generateVapidKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([0x04]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey: b64u(raw) };
}

const LEVEL_TITLE = { info: 'ℹ️', warning: '⚠️', alert: '🚨' };

export function notificationPayload(n) {
  return JSON.stringify({
    title: `${LEVEL_TITLE[n.level] || ''} ${n.scenario_name || 'Домашний IoT'}`.trim(),
    body: String(n.message).slice(0, 1000),
    level: n.level,
    tag: n.id ? `n${n.id}` : 'test',
    url: '/#/notifications',
  });
}

/**
 * @param {{ db, subject: string, allowPrivate?: boolean, post?: Function, log? }} opts
 */
export async function createWebPush({ db, subject, allowPrivate = false, post = postOut, log = console }) {
  let { rows } = await db.query("SELECT value FROM server_settings WHERE key = 'vapid'");
  if (!rows[0]) {
    const k = generateVapidKeys();
    await db.query(
      "INSERT INTO server_settings (key, value) VALUES ('vapid', $1::jsonb) ON CONFLICT (key) DO NOTHING",
      [JSON.stringify({ private_pem: k.privatePem, public_key: k.publicKey })]);
    ({ rows } = await db.query("SELECT value FROM server_settings WHERE key = 'vapid'"));
    log.log?.('web push: созданы ключи VAPID');
  }
  const keys = {
    publicKey: rows[0].value.public_key,
    privateKeyObject: crypto.createPrivateKey(rows[0].value.private_pem),
  };

  async function send(cfg, n) {
    const body = encryptPayload(notificationPayload(n), cfg.p256dh, cfg.auth);
    const res = await post(cfg.endpoint, {
      body,
      allowPrivate,
      headers: {
        authorization: vapidAuthorization(cfg.endpoint, keys, subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: '86400',
        urgency: n.level === 'alert' ? 'high' : 'normal',
      },
    });
    if (res.status === 404 || res.status === 410) throw new PermanentError(`подписка браузера больше не действует (HTTP ${res.status})`);
    if (res.status < 200 || res.status >= 300) throw new Error(`push-сервис ответил HTTP ${res.status}`);
  }

  return { publicKey: keys.publicKey, send, checkKeys: checkSubscriptionKeys };
}
