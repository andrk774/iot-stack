import { Router, HttpError, reply, str, RawBody } from '../http.js';
import { DEVICE_ID_RE, PROP_RE } from '../acl.js';
import { hashSecret, randomToken, sha256, newDeviceId } from '../security.js';
import { makeAuth, withTx, lockScope, roleSql, accessSql, requireRole, resolveHome } from './common.js';
import { isSettable } from '../../../shared/scenario.js';

const BUCKET_RE = /^(\d{1,4})(s|m|h|d)$/;
const BUCKET_UNITS = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' };
const MAX_RANGE_MS = 92 * 24 * 3600 * 1000;      // сырые данные хранятся 90 дней
const MAX_HOURLY_RANGE_MS = 731 * 24 * 3600 * 1000; // почасовые агрегаты — 2 года
const CSV_MAX_ROWS = 200_000;
const HOUR_MS = 3600 * 1000;
const UNIT_MS = { s: 1000, m: 60_000, h: HOUR_MS, d: 24 * HOUR_MS };

/**
 * Разобрать from/to/bucket. Шаг от часа (или диапазон длиннее 92 дней) берётся из почасовых агрегатов:
 * так месяц и год строятся быстро и после удаления сырых данных.
 */
export function telemetryQuery(query, now = new Date()) {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 24 * HOUR_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new HttpError(400, 'validation', { field: 'from/to', reason: 'ISO dates, from < to' });
  }
  let bucket = null;
  let interval = null;
  let bucketMs = 0;
  if (query.bucket) {
    const m = BUCKET_RE.exec(query.bucket);
    if (!m || Number(m[1]) === 0) throw new HttpError(400, 'validation', { field: 'bucket', reason: 'e.g. 30s, 5m, 1h, 1d' });
    bucket = query.bucket;
    interval = `${m[1]} ${BUCKET_UNITS[m[2]]}`;
    bucketMs = Number(m[1]) * UNIT_MS[m[2]];
  }
  const span = to - from;
  const hourly = bucket !== null && bucketMs >= HOUR_MS && bucketMs % HOUR_MS === 0;
  if (span > (hourly ? MAX_HOURLY_RANGE_MS : MAX_RANGE_MS)) {
    throw new HttpError(400, 'validation', { field: 'from/to', reason: hourly ? 'range <= 2 years' : 'range <= 92 days (для длиннее — bucket от 1h)' });
  }
  return { from, to, bucket, interval, hourly };
}

export const DEVICE_COLUMNS = `id, owner_id, room_id, name, state, meta, last_values, last_seen, created_at, provisioned_at, bridge_id,
  (mqtt_password_hash IS NOT NULL OR bridge_id IS NOT NULL) AS provisioned`;

const NO_EMQX = { kick: async () => false };

/**
 * @param {{ db: {query: Function, connect: Function}, mqtt: {publish: Function, connected: boolean},
 *           config: object, emqx?: {kick: (clientId: string) => Promise<boolean>} }} deps
 */
export function publicRoutes({ db, mqtt, config, emqx = NO_EMQX }) {
  const r = new Router();
  const auth = makeAuth(config, db);

  /** Устройство, к которому у пользователя есть роль не ниже min (своё или в доме, куда пригласили) */
  const loadDevice = async (userId, id, min) => {
    if (!DEVICE_ID_RE.test(id)) throw new HttpError(404, 'device_not_found');
    const { rows } = await db.query(
      `SELECT ${DEVICE_COLUMNS}, ${roleSql('d.owner_id', '$2')} AS my_role FROM devices d WHERE d.id = $1`, [id, userId],
    );
    requireRole(rows[0]?.my_role, min, 'device_not_found');
    return rows[0];
  };

  async function fetchTelemetry(deviceId, property, q, limit) {
    if (q.hourly) {
      // среднее по часам, взвешенное числом точек; min/max — по часам
      const { rows } = await db.query(
        `SELECT time_bucket($1::interval, bucket) AS t,
                sum(avg * n) / nullif(sum(n), 0) AS avg, min(min) AS min, max(max) AS max, sum(n)::int AS n
         FROM telemetry_hourly
         WHERE device_id = $2 AND property = $3 AND bucket >= $4 AND bucket < $5
         GROUP BY t HAVING sum(n) > 0 ORDER BY t LIMIT $6`,
        [q.interval, deviceId, property, q.from, q.to, limit]);
      return rows;
    }
    if (q.bucket) {
      const { rows } = await db.query(
        `SELECT time_bucket($1::interval, time) AS t,
                avg(value_num) AS avg, min(value_num) AS min, max(value_num) AS max, count(*)::int AS n
         FROM telemetry
         WHERE device_id = $2 AND property = $3 AND time >= $4 AND time < $5
         GROUP BY t ORDER BY t LIMIT $6`,
        [q.interval, deviceId, property, q.from, q.to, limit]);
      return rows;
    }
    const { rows } = await db.query(
      `SELECT time AS t, value_num AS v, value_text AS s
       FROM telemetry
       WHERE device_id = $1 AND property = $2 AND time >= $3 AND time < $4
       ORDER BY time DESC LIMIT $5`,
      [deviceId, property, q.from, q.to, limit]);
    return rows.reverse();
  }

  r.get('/api/health', async () => ({ ok: true, mqtt: Boolean(mqtt.connected) }));

  // ---------- устройства ----------
  r.get('/api/devices', async ({ req }) => {
    const userId = await auth(req);
    const { rows } = await db.query(
      `SELECT ${DEVICE_COLUMNS}, ${roleSql('d.owner_id', '$1')} AS my_role FROM devices d
       WHERE ${accessSql('d.owner_id', '$1')} ORDER BY created_at`, [userId],
    );
    return { devices: rows };
  });

  const newClaim = () => {
    const token = randomToken(24);
    return { token, hash: sha256(token), expiresAt: new Date(Date.now() + config.claimTtlMin * 60_000) };
  };

  r.post('/api/devices', async ({ req, body }) => {
    const userId = await auth(req);
    const name = str(body.name, 'name', { max: 64 });
    const home = await resolveHome(db, userId, body.home, 'admin');
    const claim = newClaim();
    const device = await withTx(db, async (tx) => {
      await lockScope(tx, 'devices', home);
      const { rows: cnt } = await tx.query(
        'SELECT count(*)::int AS n FROM devices WHERE owner_id = $1 AND bridge_id IS NULL', [home],
      );
      if (cnt[0].n >= config.maxDevicesPerUser) throw new HttpError(409, 'device_limit_reached');
      const { rows } = await tx.query(
        `INSERT INTO devices (id, owner_id, name, claim_token_hash, claim_expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${DEVICE_COLUMNS}`,
        [newDeviceId(), home, name, claim.hash, claim.expiresAt],
      );
      return { ...rows[0], my_role: home === userId ? 'owner' : 'admin' };
    });
    return reply(201, { device, claim_token: claim.token, claim_expires_at: claim.expiresAt });
  });

  r.get('/api/devices/:id', async ({ req, params }) => loadDevice(await auth(req), params.id, 'view'));

  r.put('/api/devices/:id', async ({ req, params, body }) => {
    const userId = await auth(req);
    const d = await loadDevice(userId, params.id, 'admin');
    const name = body.name === undefined ? d.name : str(body.name, 'name', { max: 64 });
    // комната: null — без комнаты; иначе комната того же дома
    let roomId = d.room_id;
    if (body.room_id !== undefined) {
      roomId = body.room_id;
      if (roomId !== null) {
        if (typeof roomId !== 'string' || !/^[0-9a-f-]{36}$/.test(roomId)) throw new HttpError(400, 'validation', { field: 'room_id', reason: 'uuid или null' });
        const { rows: rr } = await db.query('SELECT 1 FROM rooms WHERE id = $1 AND owner_id = $2', [roomId, d.owner_id]);
        if (!rr[0]) throw new HttpError(400, 'validation', { field: 'room_id', reason: 'комната другого дома или не существует' });
      }
    }
    const { rows } = await db.query(
      `UPDATE devices SET name = $2, room_id = $3 WHERE id = $1 RETURNING ${DEVICE_COLUMNS}`, [params.id, name, roomId],
    );
    return { ...rows[0], my_role: d.my_role };
  });

  // Новый токен привязки (перепрошивка/смена владельца). Старый MQTT-пароль перестаёт работать,
  // а уже открытая сессия устройства разрывается через REST API EMQX.
  r.post('/api/devices/:id/claim', async ({ req, params }) => {
    const userId = await auth(req);
    const device = await loadDevice(userId, params.id, 'admin');
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
    const userId = await auth(req);
    const device = await loadDevice(userId, params.id, 'admin');
    await withTx(db, async (tx) => {
      await tx.query('DELETE FROM devices WHERE id = $1', [device.id]);
      await tx.query('DELETE FROM telemetry WHERE device_id = $1', [device.id]);
    });
    // у устройства моста своей сессии нет — разрывать нечего
    if (!device.bridge_id) await emqx.kick(device.id);
    return reply(204);
  });

  r.post('/api/devices/:id/commands', async ({ req, params, body }) => {
    const userId = await auth(req);
    const device = await loadDevice(userId, params.id, 'control');
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
    const userId = await auth(req);
    const device = await loadDevice(userId, params.id, 'view');
    const property = str(query.property, 'property', { max: 32, re: PROP_RE });
    const q = telemetryQuery(query);
    const rows = await fetchTelemetry(device.id, property, q, Math.min(Math.max(Number(query.limit) || 1000, 1), 10000));
    return { property, from: q.from, to: q.to, ...(q.bucket ? { bucket: q.bucket, source: q.hourly ? 'hourly' : 'raw' } : {}), points: rows };
  });

  // Выгрузка в CSV: несколько свойств, длинный формат «время, свойство, значение».
  // format=excel — разделитель «;», десятичная запятая и BOM: так файл сразу открывается в русском Excel.
  r.get('/api/devices/:id/telemetry.csv', async ({ req, params, query }) => {
    const userId = await auth(req);
    const device = await loadDevice(userId, params.id, 'view');
    const props = String(query.properties ?? query.property ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!props.length || props.length > 16 || !props.every((x) => PROP_RE.test(x))) {
      throw new HttpError(400, 'validation', { field: 'properties', reason: 'через запятую, до 16' });
    }
    const q = telemetryQuery(query);
    const excel = query.format === 'excel';
    const sep = excel ? ';' : ',';
    const num = (v) => (v === null || v === undefined ? '' : excel ? String(v).replace('.', ',') : String(v));
    const cell = (v) => {
      const t = String(v ?? '');
      return /[",;\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [q.bucket ? ['time', 'property', 'avg', 'min', 'max', 'count'].join(sep) : ['time', 'property', 'value'].join(sep)];
    let total = 0;
    for (const prop of props) {
      const rows = await fetchTelemetry(device.id, prop, q, CSV_MAX_ROWS - total);
      total += rows.length;
      for (const r of rows) {
        const t = new Date(r.t).toISOString();
        lines.push(q.bucket
          ? [t, prop, num(r.avg), num(r.min), num(r.max), r.n].join(sep)
          : [t, prop, r.v !== null && r.v !== undefined ? num(r.v) : cell(r.s)].join(sep));
      }
      if (total >= CSV_MAX_ROWS) break;
    }
    const body = Buffer.from((excel ? '﻿' : '') + lines.join('\r\n') + '\r\n', 'utf8');
    const safeName = `${device.id}_${q.from.toISOString().slice(0, 10)}_${q.to.toISOString().slice(0, 10)}.csv`;
    return new RawBody(body, 'text/csv; charset=utf-8', {
      'content-disposition': `attachment; filename="${safeName}"`,
      ...(total >= CSV_MAX_ROWS ? { 'x-truncated': 'true' } : {}),
    });
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
