// Описание сценария: проверка (бэкенд) и вычисление условий (scenario-runner).
import { parseCron, CronError, isValidTimeZone } from './cron.js';

export const DEVICE_ID_RE = /^d[0-9a-f]{16}$/;
export const PROP_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'changed'];
export const STATES = ['init', 'ready', 'disconnected', 'sleeping', 'lost', 'alert'];
export const LEVELS = ['info', 'warning', 'alert'];
export const LIMITS = {
  conditions: 10, actions: 10, delayMax: 3600, cooldownMax: 86400, message: 500, name: 100,
  forMax: 86400, staleMinMax: 7 * 24 * 60,
};
export const CONDITION_MODES = ['all', 'any'];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ScenarioError extends Error {
  constructor(field, reason) {
    super(`${field}: ${reason}`);
    this.field = field;
    this.reason = reason;
  }
}

const fail = (field, reason) => { throw new ScenarioError(field, reason); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function scalar(v, field) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length <= 256) return v;
  return fail(field, 'число, true/false или строка до 256 символов');
}

function deviceRef(o, field) {
  if (typeof o.device_id !== 'string' || !DEVICE_ID_RE.test(o.device_id)) fail(`${field}.device_id`, 'нужен id устройства');
  return o.device_id;
}

function propRef(o, field) {
  if (typeof o.property !== 'string' || !PROP_RE.test(o.property)) fail(`${field}.property`, 'имя свойства');
  return o.property;
}

function comparison(o, field, allowChanged) {
  const out = { device_id: deviceRef(o, field), property: propRef(o, field) };
  if (!OPS.includes(o.op) || (!allowChanged && o.op === 'changed')) fail(`${field}.op`, 'оператор');
  out.op = o.op;
  if (o.op !== 'changed') out.value = scalar(o.value, `${field}.value`);
  return out;
}

export function validateTrigger(t) {
  if (!isObj(t)) fail('trigger', 'объект');
  switch (t.type) {
    case 'property': {
      const out = { type: 'property', ...comparison(t, 'trigger', true) };
      const threshold = ['gt', 'gte', 'lt', 'lte'].includes(out.op);
      // гистерезис: повторно сработает, только когда значение уйдёт от порога на эту величину обратно
      if (t.hysteresis !== undefined && t.hysteresis !== null && t.hysteresis !== 0) {
        if (!threshold || typeof out.value !== 'number') fail('trigger.hysteresis', 'только для >, ≥, <, ≤ с числом');
        if (typeof t.hysteresis !== 'number' || !Number.isFinite(t.hysteresis) || t.hysteresis < 0) fail('trigger.hysteresis', 'число ≥ 0');
        out.hysteresis = t.hysteresis;
      }
      // «дольше N секунд»: условие должно держаться без перерыва
      if (t.for_sec !== undefined && t.for_sec !== null && t.for_sec !== 0) {
        if (out.op === 'changed') fail('trigger.for_sec', 'не для «изменилось»');
        if (!Number.isInteger(t.for_sec) || t.for_sec < 0 || t.for_sec > LIMITS.forMax) fail('trigger.for_sec', `целое 0..${LIMITS.forMax}`);
        out.for_sec = t.for_sec;
      }
      return out;
    }
    case 'stale': {
      // нет данных от устройства (или от одного свойства) дольше N минут
      const out = { type: 'stale', device_id: deviceRef(t, 'trigger') };
      if (t.property !== undefined && t.property !== null && t.property !== '') out.property = propRef(t, 'trigger');
      if (!Number.isInteger(t.minutes) || t.minutes < 1 || t.minutes > LIMITS.staleMinMax) fail('trigger.minutes', `целое 1..${LIMITS.staleMinMax}`);
      out.minutes = t.minutes;
      return out;
    }
    case 'state':
      if (!STATES.includes(t.state)) fail('trigger.state', STATES.join('|'));
      return { type: 'state', device_id: deviceRef(t, 'trigger'), state: t.state };
    case 'schedule': {
      try {
        parseCron(t.cron);
      } catch (e) {
        if (e instanceof CronError) fail('trigger.cron', e.message);
        throw e;
      }
      if (t.tz !== undefined && t.tz !== null && t.tz !== '' && (typeof t.tz !== 'string' || !isValidTimeZone(t.tz))) {
        fail('trigger.tz', 'часовой пояс IANA, например Asia/Yekaterinburg');
      }
      return { type: 'schedule', cron: t.cron.trim(), ...(t.tz ? { tz: t.tz } : {}) };
    }
    case 'manual':
      return { type: 'manual' };
    default:
      return fail('trigger.type', 'property|state|stale|schedule|manual');
  }
}

/** Условие: значение свойства (по умолчанию), состояние устройства или время суток / дни недели */
export function validateCondition(c, i) {
  const field = `conditions[${i}]`;
  if (!isObj(c)) fail(field, 'объект');
  const type = c.type ?? 'property';
  if (type === 'property') return { type, ...comparison(c, field, false) };
  if (type === 'state') {
    if (!STATES.includes(c.state)) fail(`${field}.state`, STATES.join('|'));
    const out = { type, device_id: deviceRef(c, field), state: c.state };
    if (c.negate === true) out.negate = true;
    return out;
  }
  if (type === 'time') {
    if (typeof c.from !== 'string' || !HHMM_RE.test(c.from)) fail(`${field}.from`, 'ЧЧ:ММ');
    if (typeof c.to !== 'string' || !HHMM_RE.test(c.to)) fail(`${field}.to`, 'ЧЧ:ММ');
    const out = { type, from: c.from, to: c.to };
    if (c.days !== undefined && c.days !== null) {
      if (!Array.isArray(c.days) || c.days.length === 0 || c.days.length > 7
        || !c.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) || new Set(c.days).size !== c.days.length) {
        fail(`${field}.days`, 'дни недели 0..6 (0 — воскресенье), без повторов');
      }
      out.days = [...c.days].sort();
    }
    if (c.tz) {
      if (typeof c.tz !== 'string' || !isValidTimeZone(c.tz)) fail(`${field}.tz`, 'часовой пояс IANA');
      out.tz = c.tz;
    }
    return out;
  }
  return fail(`${field}.type`, 'property|state|time');
}

/** Попадает ли момент в окно времени (окно через полночь: 22:00–07:00) */
export function inTimeWindow(cond, parts) {
  const now = parts.hour * 60 + parts.minute;
  const [fh, fm] = cond.from.split(':').map(Number);
  const [th, tm] = cond.to.split(':').map(Number);
  const from = fh * 60 + fm;
  const to = th * 60 + tm;
  // день недели для окна через полночь — тот, в который окно началось
  const startedYesterday = from > to && now < to;
  const day = startedYesterday ? (parts.weekday + 6) % 7 : parts.weekday;
  if (cond.days && !cond.days.includes(day)) return false;
  if (from === to) return true; // сутки целиком
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function validateAction(a, i) {
  const field = `actions[${i}]`;
  if (!isObj(a)) fail(field, 'объект');
  switch (a.type) {
    case 'set':
      return { type: 'set', device_id: deviceRef(a, field), property: propRef(a, field), value: scalar(a.value, `${field}.value`) };
    case 'notify': {
      if (typeof a.message !== 'string' || !a.message.trim() || a.message.length > LIMITS.message) {
        fail(`${field}.message`, `текст до ${LIMITS.message} символов`);
      }
      const level = a.level ?? 'info';
      if (!LEVELS.includes(level)) fail(`${field}.level`, LEVELS.join('|'));
      return { type: 'notify', message: a.message.trim(), level };
    }
    case 'delay':
      if (!Number.isInteger(a.seconds) || a.seconds < 1 || a.seconds > LIMITS.delayMax) {
        fail(`${field}.seconds`, `целое 1..${LIMITS.delayMax}`);
      }
      return { type: 'delay', seconds: a.seconds };
    default:
      return fail(`${field}.type`, 'set|notify|delay');
  }
}

export function validateScenario(body) {
  if (!isObj(body)) fail('body', 'объект');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > LIMITS.name) fail('name', `1..${LIMITS.name} символов`);
  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== 'boolean') fail('enabled', 'true/false');

  const trigger = validateTrigger(body.trigger);

  const conds = body.conditions ?? [];
  if (!Array.isArray(conds) || conds.length > LIMITS.conditions) fail('conditions', `массив до ${LIMITS.conditions}`);
  const conditions = conds.map(validateCondition);
  const mode = body.condition_mode ?? 'all';
  if (!CONDITION_MODES.includes(mode)) fail('condition_mode', 'all|any');

  if (!Array.isArray(body.actions) || body.actions.length === 0 || body.actions.length > LIMITS.actions) {
    fail('actions', `1..${LIMITS.actions} действий`);
  }
  const actions = body.actions.map(validateAction);
  if (!actions.some((a) => a.type !== 'delay')) fail('actions', 'нужно хотя бы одно действие кроме паузы');

  const cooldown = body.cooldown_sec ?? 0;
  if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > LIMITS.cooldownMax) fail('cooldown_sec', `0..${LIMITS.cooldownMax}`);

  return { name, enabled, trigger, conditions, condition_mode: mode, actions, cooldown_sec: cooldown };
}

export function referencedDevices(s) {
  const ids = [];
  if (s.trigger?.device_id) ids.push(s.trigger.device_id);
  for (const c of s.conditions || []) if (c.device_id) ids.push(c.device_id);
  for (const a of s.actions || []) if (a.device_id) ids.push(a.device_id);
  return [...new Set(ids)];
}

// ---------- вычисление ----------

/** Значение для сравнения: bool -> 1/0, числовая строка -> число */
export function comparable(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === 'true') return 1;
  if (s === 'false') return 0;
  if (s !== '' && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return s;
}

export function compare(op, actualRaw, expectedRaw) {
  const a = comparable(actualRaw);
  const b = comparable(expectedRaw);
  if (a === null) return false;
  const nums = typeof a === 'number' && typeof b === 'number';
  switch (op) {
    case 'eq': return nums ? a === b : String(a) === String(b);
    case 'ne': return nums ? a !== b : String(a) !== String(b);
    case 'gt': return nums && a > b;
    case 'gte': return nums && a >= b;
    case 'lt': return nums && a < b;
    case 'lte': return nums && a <= b;
    default: return false;
  }
}

/**
 * Можно ли отправить команду в свойство. Пока устройство не описало себя в $meta — можно
 * (так же решает POST /api/devices/:id/commands), иначе только свойства с settable: true.
 */
export function isSettable(meta, property) {
  const props = meta?.props;
  if (!props || typeof props !== 'object') return true;
  return props[property]?.settable === true;
}

export const OP_LABELS = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', ne: '≠', changed: 'изменилось' };
