// Протокол платформы (те же правила, что в ESP32 SDK и на сервере).
//   dev/<id>/$state | dev/<id>/$meta | dev/<id>/<prop> | dev/<id>/<prop>/set

export const PROP_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const DEVICE_ID_RE = /^d[0-9a-f]{16}$/;
export const STATES = ['init', 'ready', 'disconnected', 'sleeping', 'lost', 'alert'];
export const TYPES = ['boolean', 'integer', 'float', 'string'];
export const MAX_VALUE_LEN = 256;
export const MAX_META_LEN = 8192;

export const topic = (id, leaf) => `dev/${id}/${leaf}`;

export function parseSetTopic(t, id) {
  const prefix = `dev/${id}/`;
  if (!t.startsWith(prefix) || !t.endsWith('/set')) return null;
  const prop = t.slice(prefix.length, -4);
  return PROP_RE.test(prop) ? prop : null;
}

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Строка команды -> значение нужного типа или undefined */
export function parseValue(raw, spec) {
  const s = String(raw).trim();
  switch (spec.type) {
    case 'boolean': {
      const v = s.toLowerCase();
      if (['true', '1', 'on', 'yes'].includes(v)) return true;
      if (['false', '0', 'off', 'no'].includes(v)) return false;
      return undefined;
    }
    case 'integer': {
      if (!/^[-+]?\d{1,15}$/.test(s)) return undefined;
      const n = Number(s);
      return inRange(n, spec) ? n : undefined;
    }
    case 'float': {
      if (!NUM_RE.test(s)) return undefined;
      const n = Number(s);
      if (!Number.isFinite(n) || !inRange(n, spec)) return undefined;
      return round(n, spec.decimals ?? 2);
    }
    default:
      return Buffer.byteLength(String(raw)) <= MAX_VALUE_LEN ? String(raw) : undefined;
  }
}

const inRange = (n, spec) => (spec.min === undefined || n >= spec.min) && (spec.max === undefined || n <= spec.max);
const round = (n, d) => {
  const f = 10 ** Math.max(0, Math.min(6, d));
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** Значение -> строка для публикации; null, если отправлять нечего */
export function formatValue(value, spec) {
  if (value === null || value === undefined) return null;
  switch (spec.type) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'integer': {
      const n = Math.trunc(Number(value));
      return Number.isFinite(n) ? String(n) : null;
    }
    case 'float': {
      const n = Number(value);
      return Number.isFinite(n) ? String(round(n, spec.decimals ?? 2)) : null;
    }
    default: {
      const s = String(value);
      return Buffer.byteLength(s) <= MAX_VALUE_LEN ? s : Buffer.from(s).subarray(0, MAX_VALUE_LEN).toString().replace(/�+$/, '');
    }
  }
}

export function buildMeta(name, firmware, specs) {
  const props = {};
  for (const s of specs) {
    props[s.name] = {
      type: s.type,
      ...(s.unit ? { unit: s.unit } : {}),
      ...(s.settable ? { settable: true } : {}),
      ...(s.min !== undefined ? { min: s.min } : {}),
      ...(s.max !== undefined ? { max: s.max } : {}),
    };
  }
  return JSON.stringify({ name, fw: firmware, props });
}
