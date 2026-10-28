import { HttpError } from '../http.js';
import { DEVICE_ID_RE } from '../acl.js';
import { verifyJwt } from '../security.js';

const TOUCH_MS = 5 * 60 * 1000;

/** Проверить JWT и что его сессия не отозвана. null — недействителен. */
export async function checkSessionToken(db, config, token) {
  const payload = verifyJwt(token, config.jwtSecret);
  if (!payload?.sub || typeof payload.sid !== 'string' || !/^[0-9a-f-]{36}$/.test(payload.sid)) return null;
  const { rows } = await db.query(
    'SELECT last_seen_at FROM sessions WHERE id = $1 AND user_id = $2 AND expires_at > now()', [payload.sid, payload.sub]);
  if (!rows[0]) return null;
  if (Date.now() - new Date(rows[0].last_seen_at).getTime() > TOUCH_MS) {
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [payload.sid]).catch(() => {});
  }
  return { userId: payload.sub, sid: payload.sid };
}

/**
 * Bearer JWT -> id пользователя или 401. Токен действует, пока жива его сессия:
 * выход, «завершить другие сеансы» и смена пароля отзывают его сразу.
 *   const userId = await auth(req);   const { userId, sid } = await auth.session(req);
 */
export function makeAuth(config, db) {
  const session = async (req) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    const s = token ? await checkSessionToken(db, config, token) : null;
    if (!s) throw new HttpError(401, 'unauthorized');
    return s;
  };
  const auth = async (req) => (await session(req)).userId;
  auth.session = session;
  return auth;
}

/** Проверить, что все устройства принадлежат пользователю. Возвращает Map id -> { id, meta } */
export async function assertOwnDevices(db, userId, ids) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  if (!unique.every((id) => DEVICE_ID_RE.test(id))) throw new HttpError(400, 'validation', { field: 'device_id', reason: 'format' });
  const { rows } = await db.query('SELECT id, meta FROM devices WHERE owner_id = $1 AND id = ANY($2::text[])', [userId, unique]);
  if (rows.length !== unique.length) {
    const found = new Set(rows.map((r) => r.id));
    throw new HttpError(400, 'device_not_found', { device_id: unique.find((id) => !found.has(id)) });
  }
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Выполнить fn(client) в транзакции. Для проверок лимитов вызывайте внутри lockScope,
 * иначе параллельные запросы увидят одно и то же count(*) и вместе превысят лимит.
 */
export async function withTx(db, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Сериализовать транзакции по ключу (например, «устройства пользователя X») до COMMIT */
export function lockScope(client, scope, id) {
  return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${scope}:${id}`]);
}
