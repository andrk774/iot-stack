// Произвольный MQTT: явные правила "топик -> свойство устройства" из настроек моста.
import { getPath } from '../props.js';

export class GenericAdapter {
  constructor(config = {}) {
    this.mappings = Array.isArray(config.mappings) ? config.mappings : [];
    this.byTopic = new Map();
    this.devices = new Map(); // key -> { name, props, map: prop -> mapping }
    for (const m of this.mappings) {
      if (!this.byTopic.has(m.topic)) this.byTopic.set(m.topic, []);
      this.byTopic.get(m.topic).push(m);
      let d = this.devices.get(m.device_key);
      if (!d) { d = { name: m.device_name || m.device_key, props: {}, map: {} }; this.devices.set(m.device_key, d); }
      if (m.device_name) d.name = m.device_name;
      d.props[m.property] = {
        type: m.type || 'float',
        ...(m.unit ? { unit: m.unit } : {}),
        ...(m.command_topic ? { settable: true } : {}),
      };
      d.map[m.property] = m;
    }
  }

  subscriptions() {
    return [...this.byTopic.keys()];
  }

  initialEvents() {
    return [...this.devices].map(([key, d]) => ({ kind: 'device', key, name: d.name, props: d.props }));
  }

  convert(m, raw) {
    if (raw === undefined || raw === null || typeof raw === 'object') return undefined;
    const s = String(raw).trim();
    switch (m.type) {
      case 'boolean':
        if (m.payload_on !== undefined && s === m.payload_on) return true;
        if (m.payload_off !== undefined && s === m.payload_off) return false;
        if (['true', '1', 'on', 'ON'].includes(s)) return true;
        if (['false', '0', 'off', 'OFF'].includes(s)) return false;
        return undefined;
      case 'integer':
      case 'float': {
        const n = Number(s);
        if (s === '' || !Number.isFinite(n)) return undefined;
        return m.type === 'integer' ? Math.round(n) : n;
      }
      default:
        return s;
    }
  }

  handle(topic, payload) {
    const rules = this.byTopic.get(topic);
    if (!rules) return [];
    const text = payload.toString('utf8');
    let json;
    const events = [];
    for (const m of rules) {
      let raw = text;
      if (m.json_key) {
        if (json === undefined) { try { json = JSON.parse(text); } catch { json = null; } }
        raw = json === null ? undefined : getPath(json, m.json_key);
      }
      const value = this.convert(m, raw);
      if (value !== undefined) events.push({ kind: 'value', key: m.device_key, prop: m.property, value });
    }
    return events;
  }

  command(key, prop, value) {
    const m = this.devices.get(key)?.map[prop];
    if (!m?.command_topic) return null;
    let payload = String(value);
    if (typeof value === 'boolean') payload = value ? (m.payload_on ?? 'true') : (m.payload_off ?? 'false');
    return { topic: m.command_topic, payload };
  }
}
