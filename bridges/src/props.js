// Общие правила: имена свойств, приведение значений в обе стороны.

export const PROP_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Произвольное имя (zigbee2mqtt property, ESPHome object_id) -> допустимое имя свойства */
export function sanitizeName(raw, fallback = 'value') {
  let s = String(raw ?? '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+/g, '_')
    .replace(/_$/, '')
    .slice(0, 32);
  if (!PROP_RE.test(s)) s = fallback;
  return s;
}

/** Уникальное имя в пределах устройства */
export function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  for (let i = 2; i < 100; i++) {
    const n = `${name.slice(0, 29)}_${i}`;
    if (!taken.has(n)) return n;
  }
  return name;
}

/** Значение -> строка для нашей шины */
export function toWire(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length <= 256 ? s : s.slice(0, 256);
}

/** Команда с нашей шины (строка) -> типизированное значение или undefined */
export function parseCommand(raw, spec) {
  const s = String(raw).trim();
  switch (spec?.type) {
    case 'boolean': {
      const v = s.toLowerCase();
      if (['true', '1', 'on', 'yes'].includes(v)) return true;
      if (['false', '0', 'off', 'no'].includes(v)) return false;
      return undefined;
    }
    case 'integer':
    case 'float': {
      if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return undefined;
      let n = Number(s);
      if (spec.type === 'integer') n = Math.round(n);
      if (typeof spec.min === 'number' && n < spec.min) return undefined;
      if (typeof spec.max === 'number' && n > spec.max) return undefined;
      return n;
    }
    default:
      return s.length <= 256 ? s : undefined;
  }
}

/** Достать значение по пути "a.b.c" */
export function getPath(obj, path) {
  let cur = obj;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}
