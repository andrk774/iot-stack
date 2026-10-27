// Схема топиков (упрощённый Homie):
//   dev/<id>/$state        — состояние устройства (init|ready|lost|...), retained
//   dev/<id>/$meta         — JSON-описание свойств, retained
//   dev/<id>/<prop>        — значение свойства (публикует устройство или его мост)
//   dev/<id>/<prop>/set    — команда устройству (публикуют бэкенд и scenario-runner)
//   bridge/<bid>/$state    — состояние моста (LWT), retained
//
// Кто подключается к брокеру:
//   d<16 hex>          устройство           — только своё поддерево
//   b<16 hex>          мост                 — поддеревья устройств этого моста
//   u:<uuid>           веб-панель (JWT)     — только чтение своих устройств
//   backend, ingest…   сервисы (superuser)  — EMQX в ACL их не присылает

export const DEVICE_ID_RE = /^d[0-9a-f]{16}$/;
export const BRIDGE_ID_RE = /^b[0-9a-f]{16}$/;
export const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PROP_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function identify(username) {
  if (typeof username !== 'string') return null;
  if (DEVICE_ID_RE.test(username)) return { kind: 'device', id: username };
  if (BRIDGE_ID_RE.test(username)) return { kind: 'bridge', id: username };
  if (username.startsWith('u:') && USER_ID_RE.test(username.slice(2))) return { kind: 'user', id: username.slice(2) };
  return null;
}

/** Топик dev/<id>/<rest...> -> { deviceId, parts } */
function splitDeviceTopic(topic) {
  if (typeof topic !== 'string' || !topic.startsWith('dev/')) return null;
  const segs = topic.split('/');
  if (segs.length < 3 || !DEVICE_ID_RE.test(segs[1])) return null;
  return { deviceId: segs[1], parts: segs.slice(2) };
}

/** Что можно публиковать и на что подписываться в поддереве устройства от имени устройства */
function deviceSideAllowed(parts, action) {
  if (action === 'publish') {
    if (parts.length !== 1) return false;
    const [leaf] = parts;
    return leaf === '$state' || leaf === '$meta' || PROP_RE.test(leaf);
  }
  if (action === 'subscribe') {
    if (parts.length !== 2 || parts[1] !== 'set') return false;
    return parts[0] === '+' || PROP_RE.test(parts[0]);
  }
  return false;
}

/** Фильтр подписки веб-панели: любой фильтр внутри dev/<id>/ без чужих поддеревьев */
function userFilterAllowed(parts) {
  if (parts.length === 0 || parts.length > 2) return false;
  if (parts.length === 1) {
    const [p] = parts;
    return p === '#' || p === '+' || p === '$state' || p === '$meta' || PROP_RE.test(p);
  }
  const [p, sub] = parts;
  return (p === '+' || PROP_RE.test(p)) && (sub === 'set' || sub === '#' || sub === '+');
}

/**
 * Решение ACL. Возвращает:
 *   'allow' | 'deny'
 *   { lookup: 'bridge_device', bridgeId, deviceId }  — разрешить, если устройство принадлежит мосту
 *   { lookup: 'user_device', userId, deviceId }      — разрешить, если устройство принадлежит пользователю
 */
export function aclDecision({ username, topic, action }) {
  const who = identify(username);
  if (!who || typeof topic !== 'string') return 'deny';
  if (action !== 'publish' && action !== 'subscribe') return 'deny';

  if (who.kind === 'bridge' && topic === `bridge/${who.id}/$state`) {
    return action === 'publish' ? 'allow' : 'deny';
  }

  const t = splitDeviceTopic(topic);
  if (!t) return 'deny';

  if (who.kind === 'device') {
    return t.deviceId === who.id && deviceSideAllowed(t.parts, action) ? 'allow' : 'deny';
  }
  if (who.kind === 'bridge') {
    if (!deviceSideAllowed(t.parts, action)) return 'deny';
    return { lookup: 'bridge_device', bridgeId: who.id, deviceId: t.deviceId };
  }
  // user: только чтение
  if (action !== 'subscribe' || !userFilterAllowed(t.parts)) return 'deny';
  return { lookup: 'user_device', userId: who.id, deviceId: t.deviceId };
}

/** Совместимость: синхронная проверка для устройств */
export function checkAcl(req) {
  return aclDecision(req) === 'allow';
}
