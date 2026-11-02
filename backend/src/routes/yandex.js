// Алиса: OAuth 2.0 для связки аккаунтов и API провайдера умного дома Яндекса (/yandex/v1.0/...).
// Включается, когда в .env заданы YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET (их же вводят в консоли Яндекс Диалогов).
import { Router, HttpError, reply, RawBody } from '../http.js';
import { makeAuth, accessSql, roleSql, ROLE_RANK } from './common.js';
import { randomToken, sha256, safeEqual } from '../security.js';
import { mapDevices, stateOf, actionToCommand } from '../yandex/map.js';
import { isSettable } from '../../../shared/scenario.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_SEC = 24 * 3600;
const UNREACHABLE = new Set(['lost', 'disconnected']);

/** Разрешённые адреса возврата: Яндекс использует https://social.yandex.net/broker/redirect */
export function redirectAllowed(uri, prefixes) {
  if (typeof uri !== 'string' || uri.length > 512) return false;
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return prefixes.some((p) => uri.startsWith(p));
}

/** Устройства пользователя в виде для Яндекса + индекс по id Яндекса */
export async function loadMapped(db, userId, { reportable = false, deviceIds = null } = {}) {
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.meta, d.state, d.last_values, r.name AS room_name, ${roleSql('d.owner_id', '$1')} AS my_role
     FROM devices d LEFT JOIN rooms r ON r.id = d.room_id
     WHERE ${accessSql('d.owner_id', '$1')} ${deviceIds ? 'AND d.id = ANY($2::text[])' : ''}
     ORDER BY d.created_at`, deviceIds ? [userId, deviceIds] : [userId]);
  const mapped = mapDevices(rows, { reportable });
  const byDevice = new Map(rows.map((d) => [d.id, d]));
  return { mapped, index: new Map(mapped.map((m) => [m.yandex.id, m])), byDevice };
}

export function yandexRoutes({ db, mqtt, config, log = console }) {
  const r = new Router();
  const y = config.yandex || {};
  if (!y.clientId || !y.clientSecret) return r; // интеграция выключена
  const auth = makeAuth(config, db);
  const prefixes = y.redirectPrefixes?.length ? y.redirectPrefixes : ['https://social.yandex.net/'];

  const checkClient = (id, secret) => typeof id === 'string' && safeEqual(id, y.clientId) && (secret === undefined || safeEqual(String(secret), y.clientSecret));

  // ---------- OAuth: шаг 1 — Яндекс отправляет пользователя сюда, панель спрашивает согласие ----------
  r.get('/oauth/authorize', async ({ query }) => {
    if (query.response_type !== 'code' || !checkClient(query.client_id) || !redirectAllowed(query.redirect_uri, prefixes)) {
      return reply(400, new RawBody(Buffer.from('Неверный запрос авторизации (client_id или redirect_uri)'), 'text/plain; charset=utf-8'));
    }
    const q = new URLSearchParams({ client_id: query.client_id, redirect_uri: query.redirect_uri, state: query.state ?? '' });
    return reply(302, new RawBody(Buffer.alloc(0), 'text/plain', { location: `/#/oauth?${q}` }));
  });

  // шаг 2 — пользователь вошёл в панель и нажал «Разрешить»
  r.post('/api/oauth/authorize', async ({ req, body }) => {
    const userId = await auth(req);
    if (!checkClient(body.client_id) || !redirectAllowed(body.redirect_uri, prefixes)) throw new HttpError(400, 'invalid_client');
    const code = randomToken(24);
    await db.query('DELETE FROM oauth_codes WHERE expires_at < now()');
    await db.query('INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [sha256(code), userId, body.client_id, body.redirect_uri, new Date(Date.now() + CODE_TTL_MS)]);
    const u = new URL(body.redirect_uri);
    u.searchParams.set('code', code);
    if (typeof body.state === 'string' && body.state) u.searchParams.set('state', body.state.slice(0, 512));
    u.searchParams.set('client_id', body.client_id);
    return { redirect: u.toString() };
  });

  // шаг 3 — Яндекс меняет код на токены (application/x-www-form-urlencoded)
  const issue = async (userId, clientId) => {
    const access = randomToken(32);
    const refresh = randomToken(32);
    await db.query(
      `INSERT INTO oauth_tokens (user_id, client_id, access_hash, refresh_hash, access_expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [userId, clientId, sha256(access), sha256(refresh), ACCESS_TTL_SEC]);
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh };
  };
  const oauthError = (status, error) => reply(status, { error });

  r.post('/oauth/token', async ({ req, body }) => {
    const form = new URLSearchParams(body.toString('utf8'));
    let clientId = form.get('client_id');
    let secret = form.get('client_secret');
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
    if (basic) {
      const [id, sec] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id || '');
      secret = decodeURIComponent(sec || '');
    }
    if (!checkClient(clientId, secret ?? '')) return oauthError(401, 'invalid_client');
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const code = form.get('code') || '';
      const { rows } = await db.query(
        'DELETE FROM oauth_codes WHERE code_hash = $1 AND expires_at > now() RETURNING user_id, client_id, redirect_uri', [sha256(code)]);
      const c = rows[0];
      if (!c || c.client_id !== clientId || (form.get('redirect_uri') && form.get('redirect_uri') !== c.redirect_uri)) return oauthError(400, 'invalid_grant');
      return issue(c.user_id, clientId);
    }
    if (grant === 'refresh_token') {
      // токен обновления одноразовый: выдаём новую пару
      const { rows } = await db.query(
        'DELETE FROM oauth_tokens WHERE refresh_hash = $1 AND client_id = $2 RETURNING user_id', [sha256(form.get('refresh_token') || ''), clientId]);
      if (!rows[0]) return oauthError(400, 'invalid_grant');
      return issue(rows[0].user_id, clientId);
    }
    return oauthError(400, 'unsupported_grant_type');
  }, { raw: 8 * 1024 });

  // связки пользователя (для настроек панели)
  r.get('/api/oauth/links', async ({ req }) => {
    const userId = await auth(req);
    const { rows } = await db.query(
      'SELECT client_id, min(created_at) AS created_at, max(last_used_at) AS last_used_at FROM oauth_tokens WHERE user_id = $1 GROUP BY client_id', [userId]);
    return { links: rows, yandex: { enabled: true } };
  });
  r.delete('/api/oauth/links', async ({ req }) => {
    const userId = await auth(req);
    const { rowCount } = await db.query('DELETE FROM oauth_tokens WHERE user_id = $1', [userId]);
    return { revoked: rowCount };
  });

  // ---------- API провайдера ----------
  const yAuth = async (req) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) throw new HttpError(401, 'unauthorized');
    const { rows } = await db.query(
      `UPDATE oauth_tokens SET last_used_at = now() WHERE access_hash = $1 AND access_expires_at > now() RETURNING user_id`, [sha256(m[1])]);
    if (!rows[0]) throw new HttpError(401, 'unauthorized');
    return rows[0].user_id;
  };
  const rid = (req) => String(req.headers['x-request-id'] || '').slice(0, 100);
  const reportable = Boolean(y.skillId && y.skillToken);

  r.head('/yandex/v1.0', async () => reply(200, new RawBody(Buffer.alloc(0), 'text/plain')));

  r.post('/yandex/v1.0/user/unlink', async ({ req }) => {
    const userId = await yAuth(req);
    await db.query('DELETE FROM oauth_tokens WHERE user_id = $1 AND client_id = $2', [userId, y.clientId]);
    return { request_id: rid(req) };
  });

  r.get('/yandex/v1.0/user/devices', async ({ req }) => {
    const userId = await yAuth(req);
    const { mapped } = await loadMapped(db, userId, { reportable });
    return { request_id: rid(req), payload: { user_id: userId, devices: mapped.map((m) => m.yandex) } };
  });

  r.post('/yandex/v1.0/user/devices/query', async ({ req, body }) => {
    const userId = await yAuth(req);
    const ids = Array.isArray(body.devices) ? body.devices.map((d) => String(d?.id ?? '')).slice(0, 301) : [];
    const { index, byDevice } = await loadMapped(db, userId, { reportable, deviceIds: [...new Set(ids.map((i) => i.split(':')[0]))] });
    return {
      request_id: rid(req),
      payload: {
        devices: ids.map((id) => {
          const m = index.get(id);
          if (!m) return { id, error_code: 'DEVICE_NOT_FOUND' };
          const d = byDevice.get(m.deviceId);
          if (UNREACHABLE.has(d.state)) return { id, error_code: 'DEVICE_UNREACHABLE' };
          return { id, ...stateOf(m, d.last_values) };
        }),
      },
    };
  });

  r.post('/yandex/v1.0/user/devices/action', async ({ req, body }) => {
    const userId = await yAuth(req);
    const list = Array.isArray(body.payload?.devices) ? body.payload.devices.slice(0, 301) : [];
    const ids = list.map((d) => String(d?.id ?? ''));
    const { index, byDevice } = await loadMapped(db, userId, { reportable, deviceIds: [...new Set(ids.map((i) => i.split(':')[0]))] });
    const devices = [];
    for (const item of list) {
      const id = String(item?.id ?? '');
      const m = index.get(id);
      if (!m) { devices.push({ id, action_result: { status: 'ERROR', error_code: 'DEVICE_NOT_FOUND' } }); continue; }
      const d = byDevice.get(m.deviceId);
      if (ROLE_RANK[d.my_role] < ROLE_RANK.control) { devices.push({ id, action_result: { status: 'ERROR', error_code: 'INVALID_ACTION', error_message: 'нет права управления' } }); continue; }
      if (UNREACHABLE.has(d.state)) { devices.push({ id, action_result: { status: 'ERROR', error_code: 'DEVICE_UNREACHABLE' } }); continue; }
      const caps = [];
      for (const cap of Array.isArray(item.capabilities) ? item.capabilities : []) {
        const cmd = actionToCommand(m, cap, d.last_values);
        const result = { type: cap?.type, state: { instance: cap?.state?.instance } };
        if (cmd.error || !isSettable(d.meta, cmd.prop)) {
          result.state.action_result = { status: 'ERROR', error_code: cmd.error || 'INVALID_ACTION' };
        } else if (!mqtt.connected) {
          result.state.action_result = { status: 'ERROR', error_code: 'INTERNAL_ERROR' };
        } else {
          try {
            await mqtt.publish(`dev/${d.id}/${cmd.prop}/set`, String(cmd.value), { qos: 1, retain: false });
            result.state.action_result = { status: 'DONE' };
          } catch (e) {
            log.error?.(`yandex action ${d.id}: ${e.message}`);
            result.state.action_result = { status: 'ERROR', error_code: 'INTERNAL_ERROR' };
          }
        }
        caps.push(result);
      }
      devices.push({ id, capabilities: caps });
    }
    return { request_id: rid(req), payload: { devices } };
  });

  return r;
}

