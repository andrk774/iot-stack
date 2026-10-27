// zigbee2mqtt: список устройств из <base>/bridge/devices, значения из <base>/<friendly_name>,
// команды в <base>/<friendly_name>/set.
import { sanitizeName, uniqueName } from '../props.js';

const ACCESS_SET = 2;
const CONTAINERS = new Set(['light', 'switch', 'lock', 'climate', 'cover', 'fan']);

/** exposes -> плоский список простых характеристик */
export function flattenExposes(exposes, out = []) {
  for (const e of exposes || []) {
    if (!e || typeof e !== 'object') continue;
    if (CONTAINERS.has(e.type) && Array.isArray(e.features)) flattenExposes(e.features, out);
    else if (['binary', 'numeric', 'enum', 'text'].includes(e.type) && typeof e.property === 'string') out.push(e);
    // composite/list (цвет xy, расписания) пока не поддерживаются
  }
  return out;
}

export class Zigbee2MqttAdapter {
  constructor(config = {}) {
    this.base = config.base_topic || 'zigbee2mqtt';
    this.byName = new Map(); // friendly_name -> dev
    this.byKey = new Map();  // ieee -> dev
  }

  subscriptions() {
    return [`${this.base}/#`];
  }

  buildDevice(raw) {
    const features = flattenExposes(raw.definition?.exposes);
    const props = {};
    const map = {}; // наше имя -> feature
    const byProperty = {}; // z2m property -> наше имя
    const taken = new Set();
    for (const f of features) {
      if (byProperty[f.property]) continue; // одно свойство в нескольких контейнерах
      const name = uniqueName(sanitizeName(f.property), taken);
      taken.add(name);
      const spec = { type: f.type === 'binary' ? 'boolean' : f.type === 'numeric' ? 'float' : 'string' };
      if (f.unit) spec.unit = String(f.unit);
      if ((f.access ?? 1) & ACCESS_SET) spec.settable = true;
      if (f.type === 'numeric' && typeof f.value_min === 'number') spec.min = f.value_min;
      if (f.type === 'numeric' && typeof f.value_max === 'number') spec.max = f.value_max;
      props[name] = spec;
      map[name] = f;
      byProperty[f.property] = name;
    }
    return { key: raw.ieee_address, name: raw.friendly_name, props, map, byProperty };
  }

  handle(topic, payload) {
    if (!topic.startsWith(`${this.base}/`)) return [];
    const rest = topic.slice(this.base.length + 1);
    const text = payload.toString('utf8');

    if (rest === 'bridge/devices') {
      let list;
      try { list = JSON.parse(text); } catch { return []; }
      if (!Array.isArray(list)) return [];
      const events = [];
      for (const raw of list) {
        if (!raw || raw.type === 'Coordinator' || !raw.definition || !raw.ieee_address || !raw.friendly_name) continue;
        const dev = this.buildDevice(raw);
        const old = this.byKey.get(dev.key);
        if (old && old.name !== dev.name) this.byName.delete(old.name); // переименование в z2m
        this.byKey.set(dev.key, dev);
        this.byName.set(dev.name, dev);
        events.push({ kind: 'device', key: dev.key, name: dev.name, props: dev.props });
      }
      return events;
    }
    if (rest.startsWith('bridge/')) return [];

    if (rest.endsWith('/availability')) {
      const dev = this.byName.get(rest.slice(0, -'/availability'.length));
      if (!dev) return [];
      let state = text.trim();
      try { const j = JSON.parse(text); if (j && typeof j === 'object') state = j.state; } catch { /* plain text */ }
      return [{ kind: 'state', key: dev.key, state: state === 'online' ? 'ready' : 'lost' }];
    }
    if (/\/(set|get)(\/.*)?$/.test(rest)) return [];

    const dev = this.byName.get(rest);
    if (!dev) return [];
    let obj;
    try { obj = JSON.parse(text); } catch { return []; }
    if (!obj || typeof obj !== 'object') return [];
    const events = [];
    for (const [prop, v] of Object.entries(obj)) {
      const name = dev.byProperty[prop];
      if (!name) continue;
      const value = this.fromZigbee(dev.map[name], v);
      if (value !== undefined) events.push({ kind: 'value', key: dev.key, prop: name, value });
    }
    return events;
  }

  fromZigbee(f, v) {
    if (v === null || v === undefined) return undefined;
    if (f.type === 'binary') {
      if (v === f.value_on || v === true) return true;
      if (v === f.value_off || v === false) return false;
      return undefined;
    }
    if (f.type === 'numeric') return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    return typeof v === 'object' ? undefined : String(v);
  }

  command(key, prop, value) {
    const dev = this.byKey.get(key);
    const f = dev?.map[prop];
    if (!f) return null;
    let v = value;
    if (f.type === 'binary') v = value ? (f.value_on ?? 'ON') : (f.value_off ?? 'OFF');
    if (f.type === 'enum' && Array.isArray(f.values) && !f.values.includes(v)) return null;
    return { topic: `${this.base}/${dev.name}/set`, payload: JSON.stringify({ [f.property]: v }) };
  }
}
