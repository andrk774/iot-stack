// Должно совпадать с backend/src/acl.js
export const DEVICE_ID_RE = /^d[0-9a-f]{16}$/;
export const PROP_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const STATES = new Set(['init', 'ready', 'disconnected', 'sleeping', 'lost', 'alert']);

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
// PostgreSQL не принимает NUL ни в text, ни в jsonb (\u0000) — такие сообщения отбрасываем целиком
const hasNul = (buf) => buf.includes(0);
const MAX_VALUE_BYTES = 256;
const MAX_META_BYTES = 8192;

export function parseValue(text) {
  const t = text.trim();
  if (t === 'true') return { num: 1, text: 'true' };
  if (t === 'false') return { num: 0, text: 'false' };
  if (NUM_RE.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return { num: n, text: null };
  }
  return { num: null, text: t };
}

/**
 * dev/<id>/$state | dev/<id>/$meta | dev/<id>/<prop>  ->  событие или null
 * @param {string} topic
 * @param {Buffer} payload
 */
export const BRIDGE_ID_RE = /^b[0-9a-f]{16}$/;

export function parseMessage(topic, payload) {
  const parts = topic.split('/');
  // bridge/<bid>/$state — состояние моста; при обрыве его устройства считаем потерянными
  if (parts.length === 3 && parts[0] === 'bridge' && parts[2] === '$state' && BRIDGE_ID_RE.test(parts[1])) {
    const state = payload.toString('utf8').trim();
    return STATES.has(state) ? { kind: 'bridge_state', bridgeId: parts[1], state } : null;
  }
  if (parts.length !== 3 || parts[0] !== 'dev') return null;
  const [, deviceId, leaf] = parts;
  if (!DEVICE_ID_RE.test(deviceId)) return null;

  if (leaf === '$state') {
    const state = payload.toString('utf8').trim();
    return STATES.has(state) ? { kind: 'state', deviceId, state } : null;
  }

  if (leaf === '$meta') {
    if (payload.length === 0 || payload.length > MAX_META_BYTES || hasNul(payload)) return null;
    try {
      const meta = JSON.parse(payload.toString('utf8'));
      // "\u0000" внутри JSON-строки сырой NUL не содержит, но jsonb его тоже не примет
      if (meta && typeof meta === 'object' && !Array.isArray(meta) && !JSON.stringify(meta).includes('\\u0000')) {
        return { kind: 'meta', deviceId, meta };
      }
    } catch { /* невалидный JSON — игнор */ }
    return null;
  }

  if (!PROP_RE.test(leaf)) return null;
  if (payload.length === 0 || payload.length > MAX_VALUE_BYTES || hasNul(payload)) return null;
  return { kind: 'value', deviceId, property: leaf, ...parseValue(payload.toString('utf8')) };
}
