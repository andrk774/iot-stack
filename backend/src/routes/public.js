import { Router, HttpError, reply, str } from '../http.js';
import { DEVICE_ID_RE, PROP_RE } from '../acl.js';
import {
  hashSecret, verifySecret, signJwt, randomToken, sha256, newDeviceId,
} from '../security.js';
import { makeAuth, withTx, lockScope } from './common.js';
import { isSettable } from '../../../shared/scenario.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUCKET_RE = /^(\d{1,4})(s|m|h|d)$/;
const BUCKET_UNITS = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' };
const MAX_RANGE_MS = 92 * 24 * 3600 * 1000;

// для выравнивания времени ответа, когда пользователь не найден
let dummyHash;
const getDummyHash = () => (dummyHash ??= hashSecret('timing-equalizer'));

export const DEVICE_COLUMNS = `id, name, state, meta, last_values, last_seen, created_at, provisioned_at, bridge_id,
  (mqtt_password_hash IS NOT NULL OR bridge_id IS NOT NULL) AS provisioned`;

const NO_EMQX = { kick: async () => false };

/**
 * @param {{ db: {query: Function, connect: Function}, mqtt: {publish: Function, connected: boolean},
 *           config: object, emqx?: {kick: (clientId: string) => Promise<boolean>} }} deps
 */
export function publicRoutes({ db, mqtt, config, emqx = NO_EMQX }) {
  const r = new Router();
  const auth = makeAuth(config);

  const loadOwnDevice = async (userId, id) => {
    if (!DEVICE_ID_RE.test(id)) throw new HttpError(404, 'device_not_found');
    const { rows } = await db.query(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = $1 AND owner_id = $2`, [id, userId],
    );
    if (!rows[0]) throw new HttpError(404, 'device_not_found');
    return rows[0];
  };

  const issueToken = (user) => ({
    token: signJwt({ sub: user.id }, config.jwtSecret, config.jwtTtlSec),
    user: { id: user.id, email: user.email },
  });

  r.get('/api/health', async () => ({ ok: true, mqtt: Boolean(mqtt.connected) }));

  // ---------- аккаунт ----------
  r.post('/api/auth/register', async ({ body }) => {
    if (!config.allowRegistration) throw new HttpError(403, 'registration_disabled');
    const email = str(body.email, 'email', { max: 254, re: EMAIL_RE }).toLowerCase();
    const password = str(body.password, 'password', { min: 8, max: 128 });
    try {
      const { rows } = await db.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
        [email, await hashSecret(password)],
      );
      return reply(201, issueToken(rows[0]));
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'email_taken');
      throw e;
    }
  });

  r.post('/api/auth/login', async ({ body }) => {
    const email = str(body.email, 'email', { max: 254 }).toLowerCase();
    const password = str(body.password, 'password', { min: 1, max: 128 });
    const { rows } = await db.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
    const user = rows[0];
    const ok = await verifySecret(password, user ? user.password_hash : await getDummyHash());
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials');
    return issueToken(user);
  });

  r.get('/api/me', async ({ req }) => {
    const userId = auth(req);
    const { rows } = await db.query('SELECT id, email, created_at FROM users WHERE id = $1', [userId]);
    if (!rows[0]) throw new HttpError(401, 'unauthorized');
    return rows[0];
  });

  // ---------- устройства ----------
  r.get('/api/devices', async ({ req }) => {
    const userId = auth(req);
    const { rows } = await db.query(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE owner_id = $1 ORDER BY created_at`, [userId],
    );
    return { devices: rows };
  });

  const newClaim = () => {
    const token = randomToken(24);
    return { token, hash: sha256(token), expiresAt: new Date(Date.now() + config.claimTtlMin * 60_000) };
  };

  r.post('/api/devices', async ({ req, body }) => {
    const userId = auth(req);
    const name = str(body.name, 'name', { max: 64 });
    const claim = newClaim();
    const device = await withTx(db, async (tx) => {
      await lockScope(tx, 'devices', userId);
      const { rows: cnt } = await tx.query(
        'SELECT count(*)::int AS n FROM devices WHERE owner_id = $1 AND bridge_id IS NULL', [userId],
      );
      if (cnt[0].n >= config.maxDevicesPerUser) throw new HttpError(409, 'device_limit_reached');
      const { rows } = await tx.query(
        `INSERT INTO devices (id, owner_id, name, claim_token_hash, claim_expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${DEVICE_COLUMNS}`,
        [newDeviceId(), userId, name, claim.hash, claim.expiresAt],
      );
      return rows[0];
    });
    return reply(201, { device, claim_token: claim.token, claim_expires_at: claim.expiresAt });
  });

  r.get('/api/devices/:id', async ({ req, params }) => loadOwnDevice(auth(req), params.id));

  r.put('/api/devices/:id', async ({ req, params, body }) => {
    const userId = auth(req);
    await loadOwnDevice(userId, params.id);
    const name = str(body.name, 'name', { max: 64 });
    const { rows } = await db.query(
      `UPDATE devices SET name = $2 WHERE id = $1 RETURNING ${DEVICE_COLUMNS}`, [params.id, name],
    );
    return rows[0];
  });

  // Новый токен привязки (перепрошивка/смена владельца). Старый MQTT-пароль перестаёт работать,
  // а уже открытая сессия устройства разрывается через REST API EMQX.
  r.post('/api/devices/:id/claim', async ({ req, params }) => {
    const userId = auth(req);
    const device = await loadOwnDevice(userId, params.id);
    if (device.bridge_id) throw new HttpError(409, 'device_managed_by_bridge');
    const claim = newClaim();
    await db.query(
      `UPDATE devices SET claim_token_hash = $2, claim_expires_at = $3, mqtt_password_hash = NULL,
              provisioned_at = NULL, state = 'new'
       WHERE id = $1`,
      [params.id, claim.hash, claim.expiresAt],
    );
    await emqx.kick(device.id);
    return { claim_token: claim.token, claim_expires_at: claim.expiresAt };
  });

  r.delete('/api/devices/:id', async ({ req, params }) => {
    const userId = auth(req);
    const device = await loadOwnDevice(userId, params.id);
    await withTx(db, async (tx) => {
      await tx.query('DELETE FROM devices WHERE id = $1', [device.id]);
      await tx.query('DELETE FROM telemetry WHERE device_id = $1', [device.id]);
    });
    // у устройства моста своей сессии нет — разрывать нечего
    if (!device.bridge_id) await emqx.kick(device.id);
    return reply(204);
  });

  r.post('/api/devices/:id/commands', async ({ req, params, body }) => {
    const userId = auth(req);
    const device = await loadOwnDevice(userId, params.id);
    const property = str(body.property, 'property', { max: 32, re: PROP_RE });
    const { value } = body;
    if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 256) {
      throw new HttpError(400, 'validation', { field: 'value', reason: 'string|number|boolean, <=256 chars' });
    }
    if (!device.provisioned) throw new HttpError(409, 'device_not_provisioned');
    // Если устройство описало свойства в $meta — разрешаем только settable (то же правило у сценариев)
    if (!isSettable(device.meta, property)) throw new HttpError(400, 'property_not_settable');
    if (!mqtt.connected) throw new HttpError(503, 'mqtt_unavailable');
    await mqtt.publish(`dev/${device.id}/${property}/set`, String(value), { qos: 1, retain: false });
    return reply(202, { queued: true });
  });

  r.get('/api/devices/:id/telemetry', async ({ req, params, query }) => {
    const userId = auth(req);
    const device = await loadOwnDevice(userId, params.id);
    const property = str(query.property, 'property', { max: 32, re: PROP_RE });

    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 24 * 3600 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw new HttpError(400, 'validation', { field: 'from/to', reason: 'ISO dates, from < to' });
    }
    if (to - from > MAX_RANGE_MS) throw new HttpError(400, 'validation', { field: 'from/to', reason: 'range <= 92 days' });
    const limit = Math.min(Math.max(Number(query.limit) || 1000, 1), 10000);

    if (query.bucket) {
      const m = BUCKET_RE.exec(query.bucket);
      if (!m || Number(m[1]) === 0) throw new HttpError(400, 'validation', { field: 'bucket', reason: 'e.g. 30s, 5m, 1h, 1d' });
      const interval = `${m[1]} ${BUCKET_UNITS[m[2]]}`;
      const { rows } = await db.query(
        `SELECT time_bucket($1::interval, time) AS t,
                avg(value_num) AS avg, min(value_num) AS min, max(value_num) AS max, count(*)::int AS n
         FROM telemetry
         WHERE device_id = $2 AND property = $3 AND time >= $4 AND time < $5
         GROUP BY t ORDER BY t LIMIT $6`,
        [interval, device.id, property, from, to, limit],
      );
      return { property, from, to, bucket: query.bucket, points: rows };
    }

    const { rows } = await db.query(
      `SELECT time AS t, value_num AS v, value_text AS s
       FROM telemetry
       WHERE device_id = $1 AND property = $2 AND time >= $3 AND time < $4
       ORDER BY time DESC LIMIT $5`,
      [device.id, property, from, to, limit],
    );
    return { property, from, to, points: rows.reverse() };
  });

  // ---------- привязка устройства (вызывает само устройство) ----------
  r.post('/api/provision', async ({ body }) => {
    const token = str(body.claim_token, 'claim_token', { min: 16, max: 128 });
    const hash = sha256(token);
    const { rows } = await db.query(
      'SELECT id FROM devices WHERE claim_token_hash = $1 AND claim_expires_at > now()', [hash],
    );
    if (!rows[0]) throw new HttpError(401, 'invalid_or_expired_claim_token');

    const deviceId = rows[0].id;
    const password = randomToken(24);
    const { rowCount } = await db.query(
      `UPDATE devices SET mqtt_password_hash = $3, claim_token_hash = NULL, claim_expires_at = NULL,
              provisioned_at = now(), state = 'init'
       WHERE id = $1 AND claim_token_hash = $2`,
      [deviceId, hash, await hashSecret(password)],
    );
    if (rowCount !== 1) throw new HttpError(409, 'claim_token_already_used');

    return {
      device_id: deviceId,
      base_topic: `dev/${deviceId}`,
      mqtt: {
        host: config.publicHost,
        port: config.mqttPublicPort,
        tls: true,
        client_id: deviceId,
        username: deviceId,
        password,
      },
    };
  });

  return r;
}
