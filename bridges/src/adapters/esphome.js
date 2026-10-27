// ESPHome через MQTT discovery (формат Home Assistant): <prefix>/<component>/[<node_id>/]<object_id>/config.
// Нужен компонент `mqtt:` в конфигурации ESPHome. Native API (порт 6053) не используется.
// Тот же формат публикуют Tasmota (SetOption19) и многие другие прошивки.
import { sanitizeName, uniqueName, getPath } from '../props.js';

const ABBR = {
  '~': '~', avty: 'availability', avty_t: 'availability_topic', pl_avail: 'payload_available',
  pl_not_avail: 'payload_not_available', stat_t: 'state_topic', cmd_t: 'command_topic', unit_of_meas: 'unit_of_measurement',
  dev_cla: 'device_class', stat_cla: 'state_class', val_tpl: 'value_template', stat_val_tpl: 'state_value_template',
  pl_on: 'payload_on', pl_off: 'payload_off', stat_on: 'state_on', stat_off: 'state_off', uniq_id: 'unique_id',
  obj_id: 'object_id', dev: 'device', ids: 'identifiers', mf: 'manufacturer', mdl: 'model', sw: 'sw_version',
  t: 'topic', bri_scl: 'brightness_scale', ops: 'options', cmd_tpl: 'command_template', json_attr_t: 'json_attributes_topic',
};
const SUPPORTED = new Set(['sensor', 'binary_sensor', 'switch', 'light', 'number', 'select']);

/** Развернуть сокращённые ключи и подставить "~" */
export function expandConfig(cfg) {
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (!o || typeof o !== 'object') return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) out[ABBR[k] ?? k] = walk(v);
    return out;
  };
  const out = walk(cfg);
  const base = typeof out['~'] === 'string' ? out['~'] : null;
  if (base) {
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'string' || k === '~') continue;
      if (v.startsWith('~')) out[k] = base + v.slice(1);
      else if (v.endsWith('~')) out[k] = v.slice(0, -1) + base;
    }
  }
  return out;
}

function applyTemplate(tpl, raw) {
  if (!tpl) return raw;
  const m = /^\{\{\s*value_json\.([\w.]+)\s*\}\}$/.exec(tpl.trim());
  if (m) {
    try { return getPath(JSON.parse(raw), m[1]); } catch { return undefined; }
  }
  if (/^\{\{\s*value\s*\}\}$/.test(tpl.trim())) return raw;
  return raw; // сложные шаблоны Jinja не исполняем
}

export class EsphomeAdapter {
  constructor(config = {}) {
    this.prefix = config.discovery_prefix || 'homeassistant';
    this.devices = new Map();   // key -> { key, name, entities: Map(prop -> entity) }
    this.entities = new Map();  // config topic -> entity
    this.stateTopics = new Map(); // topic -> Set(entity)
    this.availTopics = new Map(); // topic -> { keys:Set, on, off }
  }

  subscriptions() {
    return [`${this.prefix}/+/+/config`, `${this.prefix}/+/+/+/config`];
  }

  deviceEvent(dev) {
    const props = {};
    for (const e of dev.entities.values()) Object.assign(props, e.props);
    return { kind: 'device', key: dev.key, name: dev.name, props };
  }

  handle(topic, payload) {
    const text = payload.toString('utf8');
    if (topic.startsWith(`${this.prefix}/`) && topic.endsWith('/config')) return this.onConfig(topic, text);
    const events = [];
    for (const e of this.stateTopics.get(topic) || []) events.push(...this.onState(e, text));
    const av = this.availTopics.get(topic);
    if (av) {
      const t = text.trim();
      const state = t === av.on ? 'ready' : t === av.off ? 'lost' : null;
      if (state) for (const key of av.keys) events.push({ kind: 'state', key, state });
    }
    return events;
  }

  onConfig(topic, text) {
    const segs = topic.slice(this.prefix.length + 1).split('/');
    const component = segs[0];
    const objectId = segs[segs.length - 2];
    const old = this.entities.get(topic);

    if (text.trim() === '') { // удаление сущности
      if (!old) return [];
      this.entities.delete(topic);
      this.stateTopics.get(old.stateTopic)?.delete(old);
      const dev = this.devices.get(old.key);
      dev?.entities.delete(old.prop);
      return dev ? [this.deviceEvent(dev)] : [];
    }
    if (!SUPPORTED.has(component)) return [];
    let cfg;
    try { cfg = expandConfig(JSON.parse(text)); } catch { return []; }
    if (!cfg || typeof cfg !== 'object') return [];

    const ids = cfg.device?.identifiers;
    const key = String((Array.isArray(ids) ? ids[0] : ids) || cfg.device?.name || segs[1] || cfg.unique_id || objectId).slice(0, 100)
      .replace(/[^\w:.\-]/g, '_');
    const name = String(cfg.device?.name || key).slice(0, 64);
    let dev = this.devices.get(key);
    if (!dev) { dev = { key, name, entities: new Map() }; this.devices.set(key, dev); }
    dev.name = name;

    const taken = new Set([...dev.entities.values()].filter((e) => e !== old).flatMap((e) => Object.keys(e.props)));
    const prop = old?.prop ?? uniqueName(sanitizeName(cfg.object_id || objectId || cfg.name), taken);
    const entity = this.buildEntity(component, cfg, key, prop);
    if (!entity) return [];
    if (old) this.stateTopics.get(old.stateTopic)?.delete(old);
    this.entities.set(topic, entity);
    dev.entities.set(prop, entity);

    const events = [];
    if (entity.stateTopic) {
      if (!this.stateTopics.has(entity.stateTopic)) this.stateTopics.set(entity.stateTopic, new Set());
      this.stateTopics.get(entity.stateTopic).add(entity);
      events.push({ kind: 'subscribe', topic: entity.stateTopic });
    }
    const avail = cfg.availability_topic || (Array.isArray(cfg.availability) ? cfg.availability[0]?.topic : null);
    if (typeof avail === 'string' && avail) {
      const a = this.availTopics.get(avail) || { keys: new Set(), on: cfg.payload_available ?? 'online', off: cfg.payload_not_available ?? 'offline' };
      a.keys.add(key);
      this.availTopics.set(avail, a);
      events.push({ kind: 'subscribe', topic: avail });
    }
    events.push(this.deviceEvent(dev));
    return events;
  }

  buildEntity(component, cfg, key, prop) {
    const e = { component, key, prop, cfg, stateTopic: cfg.state_topic, commandTopic: cfg.command_topic, props: {} };
    const on = cfg.state_on ?? cfg.payload_on ?? 'ON';
    const off = cfg.state_off ?? cfg.payload_off ?? 'OFF';
    e.on = on;
    e.off = off;
    switch (component) {
      case 'sensor': {
        const numeric = Boolean(cfg.unit_of_measurement || cfg.device_class || cfg.state_class);
        e.props[prop] = numeric ? { type: 'float', ...(cfg.unit_of_measurement ? { unit: String(cfg.unit_of_measurement) } : {}) } : { type: 'string' };
        break;
      }
      case 'binary_sensor':
        e.props[prop] = { type: 'boolean' };
        break;
      case 'switch':
        e.props[prop] = { type: 'boolean', ...(cfg.command_topic ? { settable: true } : {}) };
        break;
      case 'number':
        e.props[prop] = {
          type: 'float', ...(cfg.command_topic ? { settable: true } : {}),
          ...(typeof cfg.min === 'number' ? { min: cfg.min } : {}), ...(typeof cfg.max === 'number' ? { max: cfg.max } : {}),
          ...(cfg.unit_of_measurement ? { unit: String(cfg.unit_of_measurement) } : {}),
        };
        break;
      case 'select':
        e.props[prop] = { type: 'string', ...(cfg.command_topic ? { settable: true } : {}) };
        e.options = Array.isArray(cfg.options) ? cfg.options.map(String) : null;
        break;
      case 'light':
        e.json = cfg.schema === 'json';
        e.props[prop] = { type: 'boolean', ...(cfg.command_topic ? { settable: true } : {}) };
        if (e.json && cfg.brightness) {
          e.brightnessProp = `${prop.slice(0, 21)}_brightness`;
          e.scale = typeof cfg.brightness_scale === 'number' ? cfg.brightness_scale : 255;
          e.props[e.brightnessProp] = { type: 'integer', min: 0, max: e.scale, ...(cfg.command_topic ? { settable: true } : {}) };
        }
        break;
      default:
        return null;
    }
    return e;
  }

  onState(e, text) {
    const out = [];
    const push = (prop, value) => { if (value !== undefined) out.push({ kind: 'value', key: e.key, prop, value }); };
    if (e.component === 'light' && e.json) {
      let j;
      try { j = JSON.parse(text); } catch { return out; }
      if (j?.state !== undefined) push(e.prop, j.state === 'ON');
      if (e.brightnessProp && typeof j?.brightness === 'number') push(e.brightnessProp, j.brightness);
      return out;
    }
    const raw = applyTemplate(e.cfg.value_template ?? e.cfg.state_value_template, text);
    if (raw === undefined || raw === null) return out;
    const s = String(raw).trim();
    switch (e.component) {
      case 'binary_sensor':
      case 'switch':
      case 'light':
        push(e.prop, s === String(e.on) ? true : s === String(e.off) ? false : undefined);
        break;
      case 'number':
      case 'sensor': {
        const spec = e.props[e.prop];
        if (spec.type === 'float') {
          const n = Number(s);
          push(e.prop, s !== '' && Number.isFinite(n) ? n : undefined); // ESPHome шлёт "nan", пока нет данных
        } else push(e.prop, s);
        break;
      }
      default:
        push(e.prop, s);
    }
    return out;
  }

  command(key, prop, value) {
    const dev = this.devices.get(key);
    if (!dev) return null;
    let e = dev.entities.get(prop);
    let brightness = false;
    if (!e) {
      e = [...dev.entities.values()].find((x) => x.brightnessProp === prop);
      brightness = Boolean(e);
    }
    if (!e?.commandTopic) return null;
    const topic = e.commandTopic;
    switch (e.component) {
      case 'switch':
        return { topic, payload: value ? String(e.cfg.payload_on ?? 'ON') : String(e.cfg.payload_off ?? 'OFF') };
      case 'number':
        return { topic, payload: String(value) };
      case 'select':
        if (e.options && !e.options.includes(String(value))) return null;
        return { topic, payload: String(value) };
      case 'light':
        if (e.json) {
          const body = brightness ? { state: 'ON', brightness: value } : { state: value ? 'ON' : 'OFF' };
          return { topic, payload: JSON.stringify(body) };
        }
        return { topic, payload: value ? String(e.cfg.payload_on ?? 'ON') : String(e.cfg.payload_off ?? 'OFF') };
      default:
        return null;
    }
  }
}
