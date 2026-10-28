// OTA-обновления прошивок.
//   1. Пользователь загружает .bin в библиотеку (POST /api/firmwares, тело — сам файл).
//   2. POST /api/devices/:id/ota — бэкенд создаёт задание с одноразовой ссылкой и публикует
//      retained-команду dev/<id>/$ota/set: устройство получит её и после переподключения.
//   3. Устройство скачивает GET /api/ota/<токен>, проверяет MD5, перезагружается и сообщает
//      результат в dev/<id>/$ota. По итоговому статусу бэкенд снимает retained-команду.
import crypto from 'node:crypto';
import { Router, HttpError, reply, str, RawBody } from '../http.js';
import { DEVICE_ID_RE } from '../acl.js';
import { makeAuth, withTx, lockScope } from './common.js';
import { randomToken, sha256 } from '../security.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;
const MAX_FIRMWARES = 20;
const JOB_TTL_MS = 24 * 3600 * 1000;
const FW_COLUMNS = 'id, name, version, size, md5, sha256, created_at';
const JOB_COLUMNS = 'id, device_id, firmware_id, version, status, progress, error, created_at, updated_at, expires_at';
export const OTA_STATUSES = ['downloading', 'rebooting', 'done', 'failed'];
const FINAL = new Set(['done', 'failed', 'cancelled']);

export const otaTopic = (deviceId) => `dev/${deviceId}/$ota/set`;

/** Образ приложения ESP32/ESP8266 начинается с магического байта 0xE9 */
export function checkFirmwareImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1024) return 'файл слишком маленький для прошивки';
  if (buf[0] !== 0xe9) return 'это не образ прошивки ESP (нет байта 0xE9 в начале). Нужен .bin приложения, не .elf и не merged-образ';
  return null;
}

export function otaRoutes({ db, mqtt, config }) {
  const r = new Router();
  const auth = makeAuth(config, db);
  const maxBytes = config.firmwareMaxBytes || 4 * 1024 * 1024;

  const ownDevice = async (userId, id) => {
    if (!DEVICE_ID_RE.test(id)) throw new HttpError(404, 'device_not_found');
    const { rows } = await db.query(
      `SELECT id, bridge_id, (mqtt_password_hash IS NOT NULL) AS provisioned, meta FROM devices WHERE id = $1 AND owner_id = $2`,
      [id, userId]);
    if (!rows[0]) throw new HttpError(404, 'device_not_found');
    return rows[0];
  };

  // ---------- библиотека прошивок ----------
  r.post('/api/firmwares', async ({ req, body, query }) => {
    const userId = await auth(req);
    const name = str(query.name, 'name', { max: 64 });
    const version = str(query.version, 'version', { max: 32, re: VERSION_RE });
    const bad = checkFirmwareImage(body);
    if (bad) throw new HttpError(400, 'validation', { field: 'file', reason: bad });
    const md5 = crypto.createHash('md5').update(body).digest('hex');
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const fw = await withTx(db, async (tx) => {
      await lockScope(tx, 'firmwares', userId);
      const { rows: cnt } = await tx.query('SELECT count(*)::int AS n FROM firmwares WHERE owner_id = $1', [userId]);
      if (cnt[0].n >= MAX_FIRMWARES) throw new HttpError(409, 'firmware_limit_reached');
      const { rows } = await tx.query(
        `INSERT INTO firmwares (owner_id, name, version, size, md5, sha256, data) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${FW_COLUMNS}`, [userId, name, version, body.length, md5, sha, body]);
      return rows[0];
    });
    return reply(201, fw);
  }, { raw: maxBytes });

  r.get('/api/firmwares', async ({ req }) => {
    const userId = await auth(req);
    const { rows } = await db.query(`SELECT ${FW_COLUMNS} FROM firmwares WHERE owner_id = $1 ORDER BY created_at DESC`, [userId]);
    return { firmwares: rows, max_bytes: maxBytes };
  });

  r.delete('/api/firmwares/:id', async ({ req, params }) => {
    const userId = await auth(req);
    if (!UUID_RE.test(params.id)) throw new HttpError(404, 'firmware_not_found');
    const { rowCount } = await db.query('DELETE FROM firmwares WHERE id = $1 AND owner_id = $2', [params.id, userId]);
    if (!rowCount) throw new HttpError(404, 'firmware_not_found');
    return reply(204);
  });

  // ---------- задания ----------
  r.get('/api/devices/:id/ota', async ({ req, params }) => {
    const userId = await auth(req);
    const d = await ownDevice(userId, params.id);
    const { rows } = await db.query(`SELECT ${JOB_COLUMNS} FROM ota_jobs WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1`, [d.id]);
    return { job: rows[0] || null, current_version: d.meta?.fw ?? null };
  });

  r.post('/api/devices/:id/ota', async ({ req, params, body }) => {
    const userId = await auth(req);
    const d = await ownDevice(userId, params.id);
    if (d.bridge_id) throw new HttpError(409, 'device_managed_by_bridge');
    if (!d.provisioned) throw new HttpError(409, 'device_not_provisioned');
    if (typeof body.firmware_id !== 'string' || !UUID_RE.test(body.firmware_id)) {
      throw new HttpError(400, 'validation', { field: 'firmware_id', reason: 'uuid' });
    }
    if (!mqtt.connected) throw new HttpError(503, 'mqtt_unavailable');
    const { rows: fws } = await db.query(`SELECT ${FW_COLUMNS} FROM firmwares WHERE id = $1 AND owner_id = $2`, [body.firmware_id, userId]);
    const fw = fws[0];
    if (!fw) throw new HttpError(404, 'firmware_not_found');

    const token = randomToken(24); // 32 символа base64url
    const job = await withTx(db, async (tx) => {
      await lockScope(tx, 'ota', d.id);
      await tx.query(
        `UPDATE ota_jobs SET status = 'cancelled', updated_at = now()
         WHERE device_id = $1 AND status IN ('pending', 'downloading')`, [d.id]);
      const { rows } = await tx.query(
        `INSERT INTO ota_jobs (device_id, firmware_id, version, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${JOB_COLUMNS}`,
        [d.id, fw.id, fw.version, sha256(token), new Date(Date.now() + JOB_TTL_MS)]);
      return rows[0];
    });
    const command = { job: job.id, path: `/api/ota/${token}`, size: fw.size, md5: fw.md5, version: fw.version };
    await mqtt.publish(otaTopic(d.id), JSON.stringify(command), { qos: 1, retain: true });
    return reply(202, { job });
  });

  r.delete('/api/devices/:id/ota', async ({ req, params }) => {
    const userId = await auth(req);
    const d = await ownDevice(userId, params.id);
    const { rowCount } = await db.query(
      `UPDATE ota_jobs SET status = 'cancelled', updated_at = now()
       WHERE device_id = $1 AND status IN ('pending', 'downloading')`, [d.id]);
    if (mqtt.connected) await mqtt.publish(otaTopic(d.id), '', { qos: 1, retain: true });
    return { cancelled: rowCount };
  });

  // ---------- скачивание (устройство, без JWT: доступ по токену задания) ----------
  r.get('/api/ota/:token', async ({ params }) => {
    if (!TOKEN_RE.test(params.token)) throw new HttpError(404, 'not_found');
    const { rows } = await db.query(
      `SELECT f.data, f.md5 FROM ota_jobs j JOIN firmwares f ON f.id = j.firmware_id
       WHERE j.token_hash = $1 AND j.expires_at > now() AND j.status IN ('pending', 'downloading')`,
      [sha256(params.token)]);
    if (!rows[0]) throw new HttpError(404, 'not_found');
    return new RawBody(rows[0].data, 'application/octet-stream', { 'x-md5': rows[0].md5 });
  });

  return r;
}

/**
 * Статус от устройства: dev/<id>/$ota = {"job": "<uuid>", "status": "...", "progress": 0..100, "error": "..."}.
 * На итоговом статусе (done/failed) снимает retained-команду. Возвращает обновлённое задание или null.
 */
export async function handleOtaStatus({ db, mqtt, log = console }, deviceId, payload) {
  if (!DEVICE_ID_RE.test(deviceId) || payload.length === 0 || payload.length > 1024) return null;
  let msg;
  try { msg = JSON.parse(payload.toString('utf8')); } catch { return null; }
  if (!msg || typeof msg !== 'object' || !UUID_RE.test(String(msg.job)) || !OTA_STATUSES.includes(msg.status)) return null;
  const progress = Number.isInteger(msg.progress) && msg.progress >= 0 && msg.progress <= 100 ? msg.progress : null;
  const error = typeof msg.error === 'string' ? msg.error.replace(/\u0000/g, '').slice(0, 300) : null;
  // итог не перезаписывается промежуточным статусом, отменённое задание — ничем
  const { rows } = await db.query(
    `UPDATE ota_jobs SET status = $3, progress = coalesce($4, progress), error = $5, updated_at = now()
     WHERE id = $1 AND device_id = $2 AND status NOT IN ('done', 'cancelled')
       AND NOT (status = 'failed' AND $3 <> 'done')
     RETURNING ${JOB_COLUMNS}`,
    [msg.job, deviceId, msg.status, progress, msg.status === 'failed' ? (error || 'ошибка без описания') : null]);
  const job = rows[0] || null;
  if (job && FINAL.has(job.status) && mqtt.connected) {
    // команду снимаем, только если она про это задание (новое могло уже появиться)
    const { rows: latest } = await db.query('SELECT id FROM ota_jobs WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1', [deviceId]);
    if (latest[0]?.id === job.id) {
      await mqtt.publish(otaTopic(deviceId), '', { qos: 1, retain: true }).catch((e) => log.error?.(`ota clear: ${e.message}`));
    }
  }
  return job;
}
