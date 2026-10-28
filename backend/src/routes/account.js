// Аккаунт: регистрация, вход (с 2FA), сессии, смена пароля.
import { Router, HttpError, reply, str } from '../http.js';
import { makeAuth } from './common.js';
import {
  hashSecret, verifySecret, signJwt, sha256, newTotpSecret, verifyTotp, otpauthUrl,
  newRecoveryCodes, normalizeRecoveryCode,
} from '../security.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SESSIONS = 50;

// для выравнивания времени ответа, когда пользователь не найден
let dummyHash;
const getDummyHash = () => (dummyHash ??= hashSecret('timing-equalizer'));

const clientInfo = (req) => ({
  ua: String(req.headers['user-agent'] || '').slice(0, 200) || null,
  ip: String(req.headers['x-real-ip'] || req.socket?.remoteAddress || '').slice(0, 64) || null,
});

/**
 * @param {{ db, config, emqx?: {kickUser?: (username: string) => Promise<number>} }} deps
 */
export function accountRoutes({ db, config, emqx = {} }) {
  const r = new Router();
  const auth = makeAuth(config, db);
  const kickWeb = (userId) => emqx.kickUser?.(`u:${userId}`).catch(() => 0);

  async function newSession(user, req) {
    const { ua, ip } = clientInfo(req);
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()', [user.id]);
    // защита от раздувания: самые старые сессии сверх лимита удаляются
    await db.query(
      `DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE user_id = $1 ORDER BY last_seen_at DESC OFFSET $2)`,
      [user.id, MAX_SESSIONS - 1]);
    const { rows } = await db.query(
      `INSERT INTO sessions (user_id, expires_at, user_agent, ip) VALUES ($1, now() + make_interval(secs => $2), $3, $4)
       RETURNING id`, [user.id, config.jwtTtlSec, ua, ip]);
    return {
      token: signJwt({ sub: user.id, sid: rows[0].id }, config.jwtSecret, config.jwtTtlSec),
      user: { id: user.id, email: user.email },
    };
  }

  r.post('/api/auth/register', async ({ req, body }) => {
    if (!config.allowRegistration) throw new HttpError(403, 'registration_disabled');
    const email = str(body.email, 'email', { max: 254, re: EMAIL_RE }).toLowerCase();
    const password = str(body.password, 'password', { min: 8, max: 128 });
    let user;
    try {
      const { rows } = await db.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email', [email, await hashSecret(password)]);
      user = rows[0];
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'email_taken');
      throw e;
    }
    return reply(201, await newSession(user, req));
  });

  /** Проверка второго фактора: код из приложения или одноразовый код восстановления */
  async function checkSecondFactor(user, code) {
    if (typeof code !== 'string' || !code.trim()) return false;
    const c = code.trim().replace(/\s/g, '');
    if (/^\d{6}$/.test(c)) {
      const step = verifyTotp(user.totp_secret, c, { lastStep: Number(user.totp_last_step) });
      if (step === null) return false;
      // условие в WHERE: два одновременных входа с одним кодом не пройдут оба
      const { rowCount } = await db.query(
        'UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2', [user.id, step]);
      return rowCount === 1;
    }
    const hash = sha256(normalizeRecoveryCode(c));
    const { rowCount } = await db.query(
      'UPDATE users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1 AND $2 = ANY(recovery_codes)',
      [user.id, hash]);
    return rowCount === 1;
  }

  r.post('/api/auth/login', async ({ req, body }) => {
    const email = str(body.email, 'email', { max: 254 }).toLowerCase();
    const password = str(body.password, 'password', { min: 1, max: 128 });
    const { rows } = await db.query(
      'SELECT id, email, password_hash, totp_secret, totp_last_step FROM users WHERE email = $1', [email]);
    const user = rows[0];
    const ok = await verifySecret(password, user ? user.password_hash : await getDummyHash());
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials');
    if (user.totp_secret) {
      if (body.code === undefined || body.code === '') throw new HttpError(401, 'totp_required');
      if (!(await checkSecondFactor(user, body.code))) throw new HttpError(401, 'invalid_totp');
    }
    return newSession(user, req);
  });

  r.post('/api/auth/logout', async ({ req }) => {
    const { sid } = await auth.session(req);
    await db.query('DELETE FROM sessions WHERE id = $1', [sid]);
    return reply(204);
  });

  r.get('/api/me', async ({ req }) => {
    const userId = await auth(req);
    const { rows } = await db.query(
      `SELECT id, email, created_at, password_changed_at, totp_secret IS NOT NULL AS totp_enabled,
              cardinality(recovery_codes) AS recovery_codes_left
       FROM users WHERE id = $1`, [userId]);
    if (!rows[0]) throw new HttpError(401, 'unauthorized');
    return rows[0];
  });

  // ---------- пароль ----------
  r.post('/api/auth/password', async ({ req, body }) => {
    const { userId, sid } = await auth.session(req);
    const current = str(body.current_password, 'current_password', { min: 1, max: 128 });
    const next = str(body.new_password, 'new_password', { min: 8, max: 128 });
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!rows[0] || !(await verifySecret(current, rows[0].password_hash))) throw new HttpError(403, 'invalid_password');
    await db.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [userId, await hashSecret(next)]);
    // остальные сеансы завершаются: если пароль меняют из-за утечки, украденный токен перестаёт работать
    const { rowCount } = await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [userId, sid]);
    await kickWeb(userId);
    return { ok: true, sessions_closed: rowCount };
  });

  // ---------- сессии ----------
  r.get('/api/sessions', async ({ req }) => {
    const { userId, sid } = await auth.session(req);
    const { rows } = await db.query(
      `SELECT id, created_at, last_seen_at, expires_at, user_agent, ip FROM sessions
       WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC`, [userId]);
    return { sessions: rows.map((s) => ({ ...s, current: s.id === sid })) };
  });

  r.delete('/api/sessions/:id', async ({ req, params }) => {
    const userId = await auth(req);
    if (!UUID_RE.test(params.id)) throw new HttpError(404, 'session_not_found');
    const { rowCount } = await db.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [params.id, userId]);
    if (!rowCount) throw new HttpError(404, 'session_not_found');
    await kickWeb(userId); // живые MQTT-подключения панели переподключатся с действующими токенами
    return reply(204);
  });

  r.post('/api/sessions/revoke-others', async ({ req }) => {
    const { userId, sid } = await auth.session(req);
    const { rowCount } = await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [userId, sid]);
    await kickWeb(userId);
    return { closed: rowCount };
  });

  // ---------- двухфакторная аутентификация ----------
  r.post('/api/auth/totp/setup', async ({ req }) => {
    const userId = await auth(req);
    const { rows } = await db.query('SELECT email, totp_secret FROM users WHERE id = $1', [userId]);
    if (rows[0].totp_secret) throw new HttpError(409, 'totp_already_enabled');
    const secret = newTotpSecret();
    await db.query('UPDATE users SET totp_pending = $2 WHERE id = $1', [userId, secret]);
    return { secret, otpauth_url: otpauthUrl(secret, rows[0].email, `IoT ${config.publicHost}`) };
  });

  r.post('/api/auth/totp/enable', async ({ req, body }) => {
    const userId = await auth(req);
    const code = str(body.code, 'code', { min: 6, max: 6, re: /^\d{6}$/ });
    const { rows } = await db.query('SELECT totp_pending, totp_secret FROM users WHERE id = $1', [userId]);
    if (rows[0].totp_secret) throw new HttpError(409, 'totp_already_enabled');
    if (!rows[0].totp_pending) throw new HttpError(409, 'totp_setup_required');
    const step = verifyTotp(rows[0].totp_pending, code);
    if (step === null) throw new HttpError(400, 'invalid_totp');
    const codes = newRecoveryCodes();
    await db.query(
      `UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = $2, recovery_codes = $3
       WHERE id = $1`, [userId, step, codes.map((c) => sha256(normalizeRecoveryCode(c)))]);
    // коды восстановления показываются один раз
    return { enabled: true, recovery_codes: codes };
  });

  r.post('/api/auth/totp/disable', async ({ req, body }) => {
    const userId = await auth(req);
    const password = str(body.password, 'password', { min: 1, max: 128 });
    const { rows } = await db.query('SELECT id, password_hash, totp_secret, totp_last_step FROM users WHERE id = $1', [userId]);
    const user = rows[0];
    if (!user.totp_secret) throw new HttpError(409, 'totp_not_enabled');
    if (!(await verifySecret(password, user.password_hash))) throw new HttpError(403, 'invalid_password');
    if (!(await checkSecondFactor(user, body.code))) throw new HttpError(400, 'invalid_totp');
    await db.query(
      `UPDATE users SET totp_secret = NULL, totp_pending = NULL, recovery_codes = '{}' WHERE id = $1`, [userId]);
    return { enabled: false };
  });

  r.post('/api/auth/totp/recovery-codes', async ({ req, body }) => {
    const userId = await auth(req);
    const password = str(body.password, 'password', { min: 1, max: 128 });
    const { rows } = await db.query('SELECT password_hash, totp_secret FROM users WHERE id = $1', [userId]);
    if (!rows[0].totp_secret) throw new HttpError(409, 'totp_not_enabled');
    if (!(await verifySecret(password, rows[0].password_hash))) throw new HttpError(403, 'invalid_password');
    const codes = newRecoveryCodes();
    await db.query('UPDATE users SET recovery_codes = $2 WHERE id = $1', [userId, codes.map((c) => sha256(normalizeRecoveryCode(c)))]);
    return { recovery_codes: codes };
  });

  return r;
}
