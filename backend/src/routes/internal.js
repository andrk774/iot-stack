// Хуки EMQX (HTTP authn / authz). Порт 8001 не публикуется и не проксируется nginx.
import { Router } from '../http.js';
import { aclDecision, identify } from '../acl.js';
import { safeEqual, verifySecret } from '../security.js';
import { checkSessionToken } from './common.js';

const ALLOW = { result: 'allow', is_superuser: false };
const ALLOW_SUPER = { result: 'allow', is_superuser: true };
const DENY = { result: 'deny' };

export function internalRoutes({ db, config, log = console }) {
  const r = new Router();

  r.post('/internal/mqtt/auth', async ({ body }) => {
    const { username, password, clientid } = body;
    if (typeof username !== 'string' || typeof password !== 'string' || typeof clientid !== 'string') return DENY;

    // Сервисы платформы
    if (Object.hasOwn(config.serviceUsers, username)) {
      return safeEqual(password, config.serviceUsers[username]) ? ALLOW_SUPER : DENY;
    }

    const who = identify(username);
    if (!who) return DENY;

    if (who.kind === 'user') {
      // Веб-панель: пароль = JWT. client id = web-<userId>-<случайное>: так нельзя выбить
      // ни устройство, ни сервис, ни сессию другого пользователя
      const prefix = `web-${who.id}-`;
      if (!clientid.startsWith(prefix) || !/^[0-9a-z]{4,16}$/.test(clientid.slice(prefix.length))) return DENY;
      // токен панели действует, пока жива его сессия (выход, смена пароля — и сюда больше не пустит)
      const s = await checkSessionToken(db, config, password);
      return s?.userId === who.id ? ALLOW : DENY;
    }

    // Устройства и мосты: client id обязан совпадать с username
    if (clientid !== username) return DENY;
    const table = who.kind === 'device' ? 'devices' : 'bridges';
    const { rows } = await db.query(`SELECT mqtt_password_hash FROM ${table} WHERE id = $1`, [who.id]);
    const hash = rows[0]?.mqtt_password_hash;
    if (!hash) return DENY;
    const ok = await verifySecret(password, hash);
    if (!ok) log.warn?.(`mqtt auth failed for ${username}`);
    return ok ? ALLOW : DENY;
  });

  r.post('/internal/mqtt/acl', async ({ body }) => {
    const d = aclDecision(body);
    if (d === 'allow') return { result: 'allow' };
    if (d === 'deny') return DENY;
    const sql = d.lookup === 'bridge_device'
      ? 'SELECT 1 FROM devices WHERE id = $1 AND bridge_id = $2'
      : 'SELECT 1 FROM devices WHERE id = $1 AND owner_id = $2';
    const { rows } = await db.query(sql, [d.deviceId, d.lookup === 'bridge_device' ? d.bridgeId : d.userId]);
    return rows.length ? { result: 'allow' } : DENY;
  });

  return r;
}
