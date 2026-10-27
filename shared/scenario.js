// Описание сценария: проверка (бэкенд) и вычисление условий (scenario-runner).
import { parseCron, CronError, isValidTimeZone } from './cron.js';

export const DEVICE_ID_RE = /^d[0-9a-f]{16}$/;
export const PROP_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'changed'];
export const STATES = ['init', 'ready', 'disconnected', 'sleeping', 'lost', 'alert'];
export const LEVELS = ['info', 'warning', 'alert'];
export const LIMITS = { conditions: 10, actions: 10, delayMax: 3600, cooldownMax: 86400, message: 500, name: 100 };

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
    case 'property':
      return { type: 'property', ...comparison(t, 'trigger', true) };
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
      return fail('trigger.type', 'property|state|schedule|manual');
  }
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
  const conditions = conds.map((c, i) => {
    if (!isObj(c)) fail(`conditions[${i}]`, 'объект');
    return comparison(c, `conditions[${i}]`, false);
  });

  if (!Array.isArray(body.actions) || body.actions.length === 0 || body.actions.length > LIMITS.actions) {
    fail('actions', `1..${LIMITS.actions} действий`);
  }
  const actions = body.actions.map(validateAction);
  if (!actions.some((a) => a.type !== 'delay')) fail('actions', 'нужно хотя бы одно действие кроме паузы');

  const cooldown = body.cooldown_sec ?? 0;
  if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > LIMITS.cooldownMax) fail('cooldown_sec', `0..${LIMITS.cooldownMax}`);

  return { name, enabled, trigger, conditions, actions, cooldown_sec: cooldown };
}

export function referencedDevices(s) {
  const ids = [];
  if (s.trigger?.device_id) ids.push(s.trigger.device_id);
  for (const c of s.conditions || []) ids.push(c.device_id);
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
