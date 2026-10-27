import { HttpError } from '../http.js';
import { DEVICE_ID_RE } from '../acl.js';
import { verifyJwt } from '../security.js';

/** Bearer JWT -> id пользователя или 401 */
export function makeAuth(config) {
  return (req) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    const payload = verifyJwt(token, config.jwtSecret);
    if (!payload?.sub) throw new HttpError(401, 'unauthorized');
    return payload.sub;
  };
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
