import { HttpError } from '../http.js';
import { DEVICE_ID_RE } from '../acl.js';
import { verifyJwt, sha256 } from '../security.js';

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

// ---------- персональные API-токены ----------
export const API_TOKEN_PREFIX = 'iot_';
export const isApiToken = (t) => typeof t === 'string' && t.startsWith(API_TOKEN_PREFIX) && t.length >= 20 && t.length <= 100;

/** API-токен -> { id, owner_id, scope } или null (нет, истёк, отозван) */
export async function findApiToken(db, token) {
  if (!isApiToken(token)) return null;
  const { rows } = await db.query(
    `SELECT id, owner_id, scope, last_used_at FROM api_tokens
     WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > now())`, [sha256(token)]);
  const t = rows[0];
  if (!t) return null;
  // last_used_at — не чаще раза в минуту: опрос раз в секунду не должен писать в БД на каждый запрос
  if (!t.last_used_at || Date.now() - new Date(t.last_used_at).getTime() > 60_000) {
    db.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [t.id]).catch(() => {});
  }
  return t;
}

/**
 * Bearer JWT -> id пользователя или 401. Токен действует, пока жива его сессия:
 * выход, «завершить другие сеансы» и смена пароля отзывают его сразу.
 *   const userId = await auth(req);   const { userId, sid } = await auth.session(req);
 *
 * Вместо JWT можно передать персональный API-токен (iot_…): он действует как его владелец,
 * токен с правом read пропускает только GET. session: true — маршруты только для панели
 * (аккаунт, сеансы, токены, каналы, участники дома): утёкший API-токен не должен давать их менять.
 * auth.session() API-токен не принимает никогда — у него нет сеанса.
 */
export function makeAuth(config, db, { session: sessionOnly = false } = {}) {
  const bearer = (req) => {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
  };
  const session = async (req) => {
    const token = bearer(req);
    if (isApiToken(token)) throw new HttpError(403, 'session_required');
    const s = token ? await checkSessionToken(db, config, token) : null;
    if (!s) throw new HttpError(401, 'unauthorized');
    return s;
  };
  const auth = async (req) => {
    const token = bearer(req);
    if (!isApiToken(token)) return (await session(req)).userId;
    if (sessionOnly) throw new HttpError(403, 'session_required');
    const t = await findApiToken(db, token);
    if (!t) throw new HttpError(401, 'unauthorized');
    if (t.scope !== 'write' && req.method !== 'GET') throw new HttpError(403, 'token_read_only');
    return t.owner_id;
  };
  auth.session = session;
  return auth;
}

// ---------- общий доступ («дом» владельца) ----------
export const ROLE_RANK = { view: 1, control: 2, admin: 3, owner: 4 };
export const MEMBER_ROLES = ['view', 'control', 'admin'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** SQL: роль пользователя (параметр u) в доме, которому принадлежит строка (колонка ownerCol); NULL — нет доступа */
// ownerCol обязательно с алиасом таблицы (d.owner_id): без него внутри подзапроса owner_id
// означал бы hm.owner_id, и условие было бы истинным для любого дома
const qualified = (col) => {
  if (!/^[a-z]\w*\.\w+$/.test(col)) throw new Error(`access SQL: column must be qualified, got ${col}`);
  return col;
};

export const roleSql = (ownerCol, u) => qualified(ownerCol) &&
  `(CASE WHEN ${ownerCol} = ${u} THEN 'owner' ELSE (SELECT hm.role FROM home_members hm WHERE hm.owner_id = ${ownerCol} AND hm.user_id = ${u}) END)`;

/** SQL-условие: у пользователя u в доме строки роль не ниже min */
export function accessSql(ownerCol, u, min = 'view') {
  qualified(ownerCol);
  const roles = MEMBER_ROLES.filter((r) => ROLE_RANK[r] >= ROLE_RANK[min]);
  const member = roles.length
    ? ` OR EXISTS (SELECT 1 FROM home_members hm WHERE hm.owner_id = ${ownerCol} AND hm.user_id = ${u} AND hm.role IN (${roles.map((r) => `'${r}'`).join(', ')}))`
    : '';
  return `(${ownerCol} = ${u}${member})`;
}

/** Есть доступ (role не NULL), но роли не хватает — 403; доступа нет вовсе — 404 с notFound */
export function requireRole(role, min, notFound) {
  if (!role) throw new HttpError(404, notFound);
  if (ROLE_RANK[role] < ROLE_RANK[min]) throw new HttpError(403, 'forbidden', { need: min });
}

/** Роль пользователя в доме владельца ownerId или null */
export async function roleIn(db, userId, ownerId) {
  if (ownerId === userId) return 'owner';
  const { rows } = await db.query('SELECT role FROM home_members WHERE owner_id = $1 AND user_id = $2', [ownerId, userId]);
  return rows[0]?.role ?? null;
}

/**
 * Дом, в котором создаётся ресурс: home из запроса (id владельца) или свой.
 * Возвращает id владельца; нужна роль не ниже min.
 */
export async function resolveHome(db, userId, home, min = 'admin') {
  if (home === undefined || home === null || home === '' || home === userId) return userId;
  if (typeof home !== 'string' || !UUID_RE.test(home)) throw new HttpError(400, 'validation', { field: 'home', reason: 'uuid' });
  requireRole(await roleIn(db, userId, home), min, 'home_not_found');
  return home;
}

/** Проверить, что все устройства принадлежат дому ownerId. Возвращает Map id -> { id, meta } */
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
