// Мосты: учётки для сервисов-переводчиков (zigbee2mqtt, ESPHome, произвольный MQTT).
import { Router, HttpError, reply, str } from '../http.js';
import { makeAuth, withTx, lockScope } from './common.js';
import { BRIDGE_ID_RE } from '../acl.js';
import { hashSecret, verifySecret, randomToken, newDeviceId } from '../security.js';
import { DEVICE_COLUMNS } from './public.js';
import crypto from 'node:crypto';

export const BRIDGE_TYPES = ['zigbee2mqtt', 'esphome', 'generic'];
const COLUMNS = `b.id, b.name, b.type, b.config, b.state, b.last_seen, b.created_at,
  (SELECT count(*)::int FROM devices d WHERE d.bridge_id = b.id) AS device_count`;
const TOPIC_RE = /^[^#+\s][^#+\s]{0,199}$/;
const FILTER_RE = /^[^\s]{1,200}$/;
const PROP_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY_RE = /^[\w:.\-]{1,100}$/;

const newBridgeId = () => 'b' + crypto.randomBytes(8).toString('hex');

/** Проверка config под тип моста. Секреты внешнего брокера сюда не кладём — они в окружении контейнера. */
export function validateBridgeConfig(type, config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new HttpError(400, 'validation', { field: 'config', reason: 'объект' });
  }
  const bad = (field, reason) => { throw new HttpError(400, 'validation', { field: `config.${field}`, reason }); };
  if (type === 'zigbee2mqtt') {
    const base = config.base_topic ?? 'zigbee2mqtt';
    if (typeof base !== 'string' || !TOPIC_RE.test(base)) bad('base_topic', 'топик без + и #');
    return { base_topic: base };
  }
  if (type === 'esphome') {
    const prefix = config.discovery_prefix ?? 'homeassistant';
    if (typeof prefix !== 'string' || !TOPIC_RE.test(prefix)) bad('discovery_prefix', 'топик без + и #');
    return { discovery_prefix: prefix };
  }
  // generic: явные правила
  const maps = config.mappings;
  if (!Array.isArray(maps) || maps.length === 0 || maps.length > 200) bad('mappings', 'массив из 1..200 правил');
  return {
    mappings: maps.map((m, i) => {
      const f = `mappings[${i}]`;
      if (!m || typeof m !== 'object') bad(f, 'объект');
      if (typeof m.topic !== 'string' || !FILTER_RE.test(m.topic) || /[+#]/.test(m.topic)) bad(`${f}.topic`, 'точный топик');
      if (typeof m.device_key !== 'string' || !KEY_RE.test(m.device_key)) bad(`${f}.device_key`, 'ключ устройства: буквы, цифры, _-:.');
      if (typeof m.property !== 'string' || !PROP_RE.test(m.property)) bad(`${f}.property`, 'имя свойства');
      const type_ = m.type ?? 'float';
      if (!['boolean', 'integer', 'float', 'string'].includes(type_)) bad(`${f}.type`, 'boolean|integer|float|string');
      const out = { topic: m.topic, device_key: m.device_key, property: m.property, type: type_ };
      if (m.device_name !== undefined) out.device_name = String(m.device_name).slice(0, 64);
      if (m.json_key !== undefined) {
        if (typeof m.json_key !== 'string' || !/^[\w.-]{1,100}$/.test(m.json_key)) bad(`${f}.json_key`, 'ключ, можно через точку');
        out.json_key = m.json_key;
      }
      if (m.unit !== undefined) out.unit = String(m.unit).slice(0, 16);
      if (m.command_topic !== undefined) {
        if (typeof m.command_topic !== 'string' || !TOPIC_RE.test(m.command_topic)) bad(`${f}.command_topic`, 'топик без + и #');
        out.command_topic = m.command_topic;
      }
      for (const k of ['payload_on', 'payload_off']) {
        if (m[k] !== undefined) out[k] = String(m[k]).slice(0, 64);
      }
      return out;
    }),
  };
}

export function bridgeRoutes({ db, config, log = console, emqx = { kick: async () => false } }) {
  const r = new Router();
  const auth = makeAuth(config, db);
  const tokenCache = new Map(); // id -> { token, until } — scrypt на каждый запрос моста слишком дорог

  const own = async (userId, id) => {
    if (!BRIDGE_ID_RE.test(id)) throw new HttpError(404, 'bridge_not_found');
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM bridges b WHERE b.id = $1 AND b.owner_id = $2`, [id, userId]);
    if (!rows[0]) throw new HttpError(404, 'bridge_not_found');
    return rows[0];
  };

  // ---------- управление мостами (пользователь) ----------
  r.get('/api/bridges', async ({ req }) => {
    const userId = await auth(req);
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM bridges b WHERE b.owner_id = $1 ORDER BY b.name`, [userId]);
    return { bridges: rows };
  });

  r.post('/api/bridges', async ({ req, body }) => {
    const userId = await auth(req);
    const name = str(body.name, 'name', { max: 64 });
    if (!BRIDGE_TYPES.includes(body.type)) throw new HttpError(400, 'validation', { field: 'type', reason: BRIDGE_TYPES.join('|') });
    const cfg = validateBridgeConfig(body.type, body.config);
    const token = randomToken(24);
    const hash = await hashSecret(token); // до транзакции: scrypt не должен держать блокировку
    const id = newBridgeId();
    await withTx(db, async (tx) => {
      await lockScope(tx, 'bridges', userId);
      const { rows: cnt } = await tx.query('SELECT count(*)::int AS n FROM bridges WHERE owner_id = $1', [userId]);
      if (cnt[0].n >= 20) throw new HttpError(409, 'bridge_limit_reached');
      await tx.query(
        'INSERT INTO bridges (id, owner_id, name, type, config, mqtt_password_hash) VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
        [id, userId, name, body.type, JSON.stringify(cfg), hash],
      );
    });
    return reply(201, { bridge: await own(userId, id), token });
  });

  r.get('/api/bridges/:id', async ({ req, params }) => own(await auth(req), params.id));

  r.put('/api/bridges/:id', async ({ req, params, body }) => {
    const userId = await auth(req);
    const b = await own(userId, params.id);
    const name = str(body.name ?? b.name, 'name', { max: 64 });
    const cfg = validateBridgeConfig(b.type, body.config ?? b.config);
    await db.query('UPDATE bridges SET name = $2, config = $3::jsonb WHERE id = $1', [b.id, name, JSON.stringify(cfg)]);
    return own(userId, b.id);
  });

  r.post('/api/bridges/:id/token', async ({ req, params }) => {
    const userId = await auth(req);
    const b = await own(userId, params.id);
    const token = randomToken(24);
    await db.query('UPDATE bridges SET mqtt_password_hash = $2 WHERE id = $1', [b.id, await hashSecret(token)]);
    tokenCache.delete(b.id);
    await emqx.kick(b.id); // старый мост переподключится и получит отказ
    return { token };
  });

  r.delete('/api/bridges/:id', async ({ req, params }) => {
    const userId = await auth(req);
    const b = await own(userId, params.id);
    await withTx(db, async (tx) => {
      await tx.query('DELETE FROM telemetry WHERE device_id IN (SELECT id FROM devices WHERE bridge_id = $1)', [b.id]);
      await tx.query('DELETE FROM bridges WHERE id = $1', [b.id]); // устройства удалятся каскадом
    });
    tokenCache.delete(b.id);
    await emqx.kick(b.id);
    return reply(204);
  });

  // ---------- API для самого моста: Authorization: Bridge <id>:<token> ----------
  const bridgeAuth = async (req) => {
    const h = req.headers.authorization || '';
    const m = /^Bridge (b[0-9a-f]{16}):(.{16,128})$/.exec(h);
    if (!m) throw new HttpError(401, 'unauthorized');
    const [, id, token] = m;
    const cached = tokenCache.get(id);
    const { rows } = await db.query('SELECT id, owner_id, name, type, config, mqtt_password_hash FROM bridges WHERE id = $1', [id]);
    const b = rows[0];
    if (!b) throw new HttpError(401, 'unauthorized');
    if (!(cached && cached.token === token && cached.until > Date.now())) {
      if (!(await verifySecret(token, b.mqtt_password_hash))) {
        log.warn?.(`bridge api auth failed for ${id}`);
        throw new HttpError(401, 'unauthorized');
      }
      tokenCache.set(id, { token, until: Date.now() + 60_000 });
    }
    return b;
  };

  r.get('/api/bridge/self', async ({ req }) => {
    const b = await bridgeAuth(req);
    return { id: b.id, name: b.name, type: b.type, config: b.config };
  });

  // Зарегистрировать (или найти) устройство моста по его внешнему ключу
  r.post('/api/bridge/devices', async ({ req, body }) => {
    const b = await bridgeAuth(req);
    const key = str(body.key, 'key', { max: 100, re: KEY_RE });
    const name = str(body.name ?? key, 'name', { max: 64 });
    const { rows: existing } = await db.query(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE bridge_id = $1 AND bridge_key = $2`, [b.id, key],
    );
    if (existing[0]) return existing[0];
    const device = await withTx(db, async (tx) => {
      await lockScope(tx, 'bridge_devices', b.id);
      const { rows: cnt } = await tx.query('SELECT count(*)::int AS n FROM devices WHERE bridge_id = $1', [b.id]);
      if (cnt[0].n >= (config.maxBridgeDevices ?? 300)) throw new HttpError(409, 'device_limit_reached');
      const { rows } = await tx.query(
        `INSERT INTO devices (id, owner_id, name, bridge_id, bridge_key, state)
         VALUES ($1, $2, $3, $4, $5, 'init')
         ON CONFLICT (bridge_id, bridge_key) WHERE bridge_id IS NOT NULL DO UPDATE SET name = devices.name
         RETURNING ${DEVICE_COLUMNS}`,
        [newDeviceId(), b.owner_id, name, b.id, key],
      );
      return rows[0];
    });
    return reply(201, device);
  });

  r.get('/api/bridge/devices', async ({ req }) => {
    const b = await bridgeAuth(req);
    const { rows } = await db.query('SELECT id, bridge_key AS key, name FROM devices WHERE bridge_id = $1', [b.id]);
    return { devices: rows };
  });

  return r;
}
