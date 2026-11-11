// Персональные API-токены: для скриптов, Home Assistant, Node-RED.
// Токен iot_… передаётся как Authorization: Bearer и действует от имени владельца (см. makeAuth в common.js).
// Управлять токенами можно только из панели (по сеансу), не другим токеном.
import { Router, HttpError, reply, str } from '../http.js';
import { makeAuth, withTx, lockScope, API_TOKEN_PREFIX } from './common.js';
import { randomToken, sha256 } from '../security.js';

const MAX_TOKENS = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLUMNS = 'id, name, hint, scope, created_at, expires_at, last_used_at';

export function tokenRoutes({ db, config, emqx = { kickUser: async () => false } }) {
  const r = new Router();
  const auth = makeAuth(config, db, { session: true });

  r.get('/api/tokens', async ({ req }) => {
    const userId = await auth(req);
    const { rows } = await db.query(
      `SELECT ${COLUMNS}, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM api_tokens WHERE owner_id = $1 ORDER BY created_at DESC`, [userId]);
    return { tokens: rows };
  });

  r.post('/api/tokens', async ({ req, body }) => {
    const userId = await auth(req);
    const name = str(body.name, 'name', { max: 64 });
    if (!['read', 'write'].includes(body.scope)) throw new HttpError(400, 'validation', { field: 'scope', reason: 'read|write' });
    let expiresAt = null;
    if (body.expires_days !== undefined && body.expires_days !== null) {
      if (!Number.isInteger(body.expires_days) || body.expires_days < 1 || body.expires_days > 3650) {
        throw new HttpError(400, 'validation', { field: 'expires_days', reason: '1..3650 или null — бессрочно' });
      }
      expiresAt = new Date(Date.now() + body.expires_days * 86_400_000);
    }
    const token = `${API_TOKEN_PREFIX}${randomToken(30)}`;
    const created = await withTx(db, async (tx) => {
      await lockScope(tx, 'api_tokens', userId);
      const { rows: cnt } = await tx.query('SELECT count(*)::int AS n FROM api_tokens WHERE owner_id = $1', [userId]);
      if (cnt[0].n >= MAX_TOKENS) throw new HttpError(409, 'token_limit_reached');
      const { rows } = await tx.query(
        `INSERT INTO api_tokens (owner_id, name, token_hash, hint, scope, expires_at) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [userId, name, sha256(token), token.slice(-4), body.scope, expiresAt]);
      return rows[0];
    });
    return reply(201, { ...created, token }); // сам токен показывается один раз
  });

  r.delete('/api/tokens/:id', async ({ req, params }) => {
    const userId = await auth(req);
    if (!UUID_RE.test(params.id)) throw new HttpError(404, 'token_not_found');
    const { rowCount } = await db.query('DELETE FROM api_tokens WHERE id = $1 AND owner_id = $2', [params.id, userId]);
    if (!rowCount) throw new HttpError(404, 'token_not_found');
    // MQTT-сессию, открытую этим токеном, не отличить от сессии панели: разрываем все — панель переподключится сама
    await emqx.kickUser(`u:${userId}`);
    return reply(204);
  });

  return r;
}
