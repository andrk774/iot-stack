// Общий доступ: участники дома, приглашения по ссылке.
import { Router, HttpError, reply } from '../http.js';
import { makeAuth, withTx, lockScope, MEMBER_ROLES } from './common.js';
import { randomToken, sha256 } from '../security.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_RE = /^[A-Za-z0-9_-]{32}$/;
const INVITE_TTL_DAYS = 7;
const MAX_MEMBERS = 30;

const role = (v) => {
  if (!MEMBER_ROLES.includes(v)) throw new HttpError(400, 'validation', { field: 'role', reason: MEMBER_ROLES.join('|') });
  return v;
};

/**
 * Принять приглашение (в транзакции). Возвращает { owner_id, role } или бросает 404/409.
 * Своё приглашение не принимается; повторное — обновляет роль.
 */
export async function acceptInvite(tx, userId, code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw new HttpError(404, 'invite_not_found');
  const { rows } = await tx.query(
    'DELETE FROM home_invites WHERE code_hash = $1 AND expires_at > now() RETURNING owner_id, role', [sha256(code)]);
  const inv = rows[0];
  if (!inv) throw new HttpError(404, 'invite_not_found');
  if (inv.owner_id === userId) throw new HttpError(409, 'invite_own_home');
  await lockScope(tx, 'members', inv.owner_id);
  const { rows: cnt } = await tx.query('SELECT count(*)::int AS n FROM home_members WHERE owner_id = $1', [inv.owner_id]);
  if (cnt[0].n >= MAX_MEMBERS) throw new HttpError(409, 'member_limit_reached');
  await tx.query(
    `INSERT INTO home_members (owner_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (owner_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [inv.owner_id, userId, inv.role]);
  return inv;
}

/** @param {{ db, config, emqx?: {kickUser?: Function} }} deps */
export function homeRoutes({ db, config, emqx = {} }) {
  const r = new Router();
  const auth = makeAuth(config, db);
  // разрыв MQTT-сессий панели: EMQX кеширует решения ACL, после отзыва доступа кеш должен сброситься
  const kickWeb = (userId) => emqx.kickUser?.(`u:${userId}`).catch(() => 0);

  // дома, к которым у меня есть доступ (свой — всегда первый)
  r.get('/api/homes', async ({ req }) => {
    const userId = await auth(req);
    const { rows } = await db.query(
      `SELECT u.id AS owner_id, u.email AS owner_email, 'owner' AS role, 0 AS ord FROM users u WHERE u.id = $1
       UNION ALL
       SELECT m.owner_id, u.email, m.role, 1 FROM home_members m JOIN users u ON u.id = m.owner_id WHERE m.user_id = $1
       ORDER BY ord, owner_email`, [userId]);
    return { homes: rows.map(({ ord, ...h }) => h) };
  });

  // ---------- участники моего дома (управляет только владелец) ----------
  r.get('/api/members', async ({ req }) => {
    const userId = await auth(req);
    const { rows } = await db.query(
      `SELECT m.user_id, u.email, m.role, m.created_at FROM home_members m JOIN users u ON u.id = m.user_id
       WHERE m.owner_id = $1 ORDER BY u.email`, [userId]);
    const { rows: invites } = await db.query(
      'SELECT id, role, created_at, expires_at FROM home_invites WHERE owner_id = $1 AND expires_at > now() ORDER BY created_at DESC',
      [userId]);
    return { members: rows, invites };
  });

  r.put('/api/members/:userId', async ({ req, params, body }) => {
    const userId = await auth(req);
    if (!UUID_RE.test(params.userId)) throw new HttpError(404, 'member_not_found');
    const { rows } = await db.query(
      'UPDATE home_members SET role = $3 WHERE owner_id = $1 AND user_id = $2 RETURNING user_id, role',
      [userId, params.userId, role(body.role)]);
    if (!rows[0]) throw new HttpError(404, 'member_not_found');
    return rows[0];
  });

  // убрать участника (владелец) или выйти из чужого дома (участник: owner = id владельца)
  r.delete('/api/members/:userId', async ({ req, params, query }) => {
    const userId = await auth(req);
    if (!UUID_RE.test(params.userId)) throw new HttpError(404, 'member_not_found');
    let rowCount;
    if (params.userId === userId && query.owner) {
      if (!UUID_RE.test(query.owner)) throw new HttpError(404, 'member_not_found');
      ({ rowCount } = await db.query('DELETE FROM home_members WHERE owner_id = $1 AND user_id = $2', [query.owner, userId]));
    } else {
      ({ rowCount } = await db.query('DELETE FROM home_members WHERE owner_id = $1 AND user_id = $2', [userId, params.userId]));
    }
    if (!rowCount) throw new HttpError(404, 'member_not_found');
    await kickWeb(params.userId);
    return reply(204);
  });

  // ---------- приглашения ----------
  r.post('/api/invites', async ({ req, body }) => {
    const userId = await auth(req);
    const code = randomToken(24); // 32 символа
    const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000);
    await db.query('DELETE FROM home_invites WHERE owner_id = $1 AND expires_at <= now()', [userId]);
    const { rows: cnt } = await db.query('SELECT count(*)::int AS n FROM home_invites WHERE owner_id = $1', [userId]);
    if (cnt[0].n >= 20) throw new HttpError(409, 'invite_limit_reached');
    const { rows } = await db.query(
      'INSERT INTO home_invites (owner_id, code_hash, role, expires_at) VALUES ($1, $2, $3, $4) RETURNING id, role, expires_at',
      [userId, sha256(code), role(body.role), expires]);
    // ссылку показываем один раз: в БД только хэш кода
    return reply(201, { ...rows[0], code, url: `https://${config.publicHost}/#/join/${code}` });
  });

  r.delete('/api/invites/:id', async ({ req, params }) => {
    const userId = await auth(req);
    if (!UUID_RE.test(params.id)) throw new HttpError(404, 'invite_not_found');
    const { rowCount } = await db.query('DELETE FROM home_invites WHERE id = $1 AND owner_id = $2', [params.id, userId]);
    if (!rowCount) throw new HttpError(404, 'invite_not_found');
    return reply(204);
  });

  r.post('/api/invites/accept', async ({ req, body }) => {
    const userId = await auth(req);
    const inv = await withTx(db, (tx) => acceptInvite(tx, userId, body.code));
    const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [inv.owner_id]);
    return { owner_id: inv.owner_id, owner_email: rows[0]?.email, role: inv.role };
  });

  return r;
}
