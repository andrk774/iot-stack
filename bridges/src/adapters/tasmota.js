// Tasmota по собственному MQTT-протоколу (без Home Assistant discovery):
//   tasmota/discovery/<MAC>/config   — описание устройства (Tasmota 9+, SetOption19 0 — по умолчанию)
//   tasmota/discovery/<MAC>/sensors  — состав датчиков
//   tele/<topic>/STATE|SENSOR|LWT    — телеметрия и доступность
//   stat/<topic>/RESULT|POWER<n>     — ответы на команды
//   cmnd/<topic>/POWER<n>|Dimmer     — команды
// Устройства без discovery можно перечислить в config.topics (имя топика из настройки Topic в Tasmota).
import { sanitizeName } from '../props.js';

const UNITS = {
  temperature: '°C', humidity: '%', dewpoint: '°C', pressure: 'hPa', seapressure: 'hPa', illuminance: 'lx',
  co2: 'ppm', eco2: 'ppm', tvoc: 'ppb', pm2_5: 'µg/m³', pm10: 'µg/m³', pm1: 'µg/m³', distance: 'cm',
  power: 'W', apparentpower: 'VA', reactivepower: 'var', voltage: 'V', current: 'A', frequency: 'Hz',
  total: 'kWh', today: 'kWh', yesterday: 'kWh', factor: '', battery: '%', moisture: '%', gas: 'ppm',
};
const SKIP = new Set(['Time', 'TempUnit', 'PressureUnit', 'SpeedUnit', 'TotalStartTime', 'Id']);

/** Полный топик Tasmota по шаблону FullTopic (%prefix%/%topic%/ по умолчанию) */
function fullTopic(ft, prefix, topic) {
  return String(ft || '%prefix%/%topic%/').replace('%prefix%', prefix).replace('%topic%', topic)
    .replace(/%hostname%|%id%/g, topic).replace(/\/$/, '');
}

export class TasmotaAdapter {
  constructor(config = {}) {
    this.prefix = config.discovery_prefix || 'tasmota/discovery';
    this.manual = config.topics || [];
    this.devices = new Map(); // key -> dev
    this.byTopic = new Map(); // полный топик tele/stat -> dev
  }

  subscriptions() {
    return [`${this.prefix}/+/config`, `${this.prefix}/+/sensors`];
  }

  /** Устройства из config.topics заводятся сразу, свойства появятся с первыми сообщениями */
  initialEvents() {
    const events = [];
    for (const t of this.manual) events.push(...this.addDevice({ key: t, name: t, tele: `tele/${t}`, stat: `stat/${t}`, cmnd: `cmnd/${t}`, relays: 0 }));
    return events;
  }

  addDevice({ key, name, tele, stat, cmnd, relays, dimmer = false }) {
    let dev = this.devices.get(key);
    const events = [];
    if (!dev) {
      dev = { key, name, tele, stat, cmnd, props: {}, relays: 0 };
      this.devices.set(key, dev);
    }
    for (const t of [dev.tele, dev.stat]) this.byTopic.delete(t);
    Object.assign(dev, { name, tele, stat, cmnd });
    this.byTopic.set(tele, dev);
    this.byTopic.set(stat, dev);
    this.setRelays(dev, relays);
    if (dimmer) dev.props.dimmer = { type: 'integer', min: 0, max: 100, settable: true };
    events.push({ kind: 'subscribe', topic: `${tele}/+` }, { kind: 'subscribe', topic: `${stat}/+` });
    events.push(this.deviceEvent(dev));
    return events;
  }

  /** POWER — если реле одно, POWER1…N — если несколько (так их называет Tasmota) */
  setRelays(dev, n) {
    if (n <= dev.relays) return false;
    for (const k of Object.keys(dev.props)) if (/^power\d*$/.test(k)) delete dev.props[k];
    dev.relays = n;
    if (n === 1) dev.props.power = { type: 'boolean', settable: true };
    else for (let i = 1; i <= n; i++) dev.props[`power${i}`] = { type: 'boolean', settable: true };
    return true;
  }

  deviceEvent(dev) {
    return { kind: 'device', key: dev.key, name: dev.name, props: { ...dev.props } };
  }

  handle(topic, payload) {
    const text = payload.toString('utf8');
    if (topic.startsWith(`${this.prefix}/`)) {
      if (topic.endsWith('/config')) return this.onConfig(text);
      if (topic.endsWith('/sensors')) return this.onSensors(topic, text);
      return [];
    }
    const cut = topic.lastIndexOf('/');
    const dev = this.byTopic.get(topic.slice(0, cut));
    if (!dev) return [];
    const leaf = topic.slice(cut + 1);
    if (leaf === 'LWT') {
      const t = text.trim();
      return t === 'Online' ? [{ kind: 'state', key: dev.key, state: 'ready' }] : t === 'Offline' ? [{ kind: 'state', key: dev.key, state: 'lost' }] : [];
    }
    const pm = /^POWER(\d*)$/.exec(leaf);
    if (pm) return this.onPower(dev, pm[1], text.trim());
    if (leaf === 'STATE' || leaf === 'RESULT' || leaf === 'SENSOR') {
      let j;
      try { j = JSON.parse(text); } catch { return []; }
      if (!j || typeof j !== 'object') return [];
      return leaf === 'SENSOR' ? this.onSensorJson(dev, j) : this.onStateJson(dev, j);
    }
    return [];
  }

  onConfig(text) {
    let c;
    try { c = JSON.parse(text); } catch { return []; }
    if (!c || typeof c.t !== 'string' || !c.mac) return [];
    const [pCmnd, pStat, pTele] = Array.isArray(c.tp) && c.tp.length === 3 ? c.tp : ['cmnd', 'stat', 'tele'];
    const relays = Array.isArray(c.rl) ? c.rl.filter((x) => x === 1 || x === 2).length : 0;
    const name = String(c.dn || (Array.isArray(c.fn) && c.fn[0]) || c.t).slice(0, 64);
    return this.addDevice({
      key: String(c.mac).toLowerCase().replace(/[^\w]/g, ''),
      name,
      tele: fullTopic(c.ft, pTele, c.t),
      stat: fullTopic(c.ft, pStat, c.t),
      cmnd: fullTopic(c.ft, pCmnd, c.t),
      relays,
      dimmer: Number.isInteger(c.lt_st) && c.lt_st > 0,
    });
  }

  onSensors(topic, text) {
    const mac = topic.slice(this.prefix.length + 1).split('/')[0].toLowerCase().replace(/[^\w]/g, '');
    const dev = this.devices.get(mac);
    if (!dev) return [];
    let j;
    try { j = JSON.parse(text); } catch { return []; }
    return j?.sn && typeof j.sn === 'object' ? this.onSensorJson(dev, j.sn) : [];
  }

  onPower(dev, idx, s) {
    // POWER без номера у устройства с несколькими реле — это первое реле
    const n = idx === '' ? 1 : Number(idx);
    const events = [];
    if (this.setRelays(dev, n)) events.push(this.deviceEvent(dev));
    const v = s === 'ON' ? true : s === 'OFF' ? false : undefined;
    if (v !== undefined) events.push({ kind: 'value', key: dev.key, prop: dev.relays === 1 ? 'power' : `power${n}`, value: v });
    return events;
  }

  onStateJson(dev, j) {
    const events = [];
    const powers = Object.entries(j).map(([k, v]) => [/^POWER(\d*)$/.exec(k), v]).filter(([m, v]) => m && typeof v === 'string');
    // сначала — сколько реле всего (POWER1 и POWER2 в одном сообщении), потом значения
    const maxN = Math.max(0, ...powers.map(([m]) => (m[1] === '' ? 1 : Number(m[1]))));
    if (this.setRelays(dev, maxN)) events.push(this.deviceEvent(dev));
    for (const [m, v] of powers) events.push(...this.onPower(dev, m[1], v));
    let changed = false;
    if (typeof j.Dimmer === 'number') {
      if (!dev.props.dimmer) { dev.props.dimmer = { type: 'integer', min: 0, max: 100, settable: true }; changed = true; }
      events.push({ kind: 'value', key: dev.key, prop: 'dimmer', value: j.Dimmer });
    }
    if (typeof j.Wifi?.RSSI === 'number') {
      if (!dev.props.rssi) { dev.props.rssi = { type: 'integer', unit: '%' }; changed = true; }
      events.push({ kind: 'value', key: dev.key, prop: 'rssi', value: j.Wifi.RSSI });
    }
    if (changed) events.unshift(this.deviceEvent(dev));
    return events;
  }

  /** {"AM2301":{"Temperature":21.4,"Humidity":40},"ENERGY":{"Power":12},"TempUnit":"C"} -> am2301_temperature, energy_power… */
  onSensorJson(dev, j) {
    const values = [];
    let changed = false;
    const tempUnit = j.TempUnit === 'F' ? '°F' : '°C';
    for (const [sensor, data] of Object.entries(j)) {
      if (SKIP.has(sensor) || !data || typeof data !== 'object' || Array.isArray(data)) continue;
      for (const [field, v] of Object.entries(data)) {
        if (SKIP.has(field) || typeof v !== 'number' || !Number.isFinite(v)) continue;
        const prop = sanitizeName(`${sensor}_${field}`);
        if (!dev.props[prop]) {
          const base = field.toLowerCase().replace(/\./g, '_');
          const unit = base === 'temperature' || base === 'dewpoint' ? tempUnit : UNITS[base];
          dev.props[prop] = { type: Number.isInteger(v) && !unit ? 'integer' : 'float', ...(unit ? { unit } : {}) };
          changed = true;
        }
        values.push({ kind: 'value', key: dev.key, prop, value: v });
      }
    }
    return changed ? [this.deviceEvent(dev), ...values] : values;
  }

  command(key, prop, value) {
    const dev = this.devices.get(key);
    if (!dev) return null;
    if (prop === 'power') return { topic: `${dev.cmnd}/POWER`, payload: value ? 'ON' : 'OFF' };
    const pm = /^power(\d+)$/.exec(prop);
    if (pm) return { topic: `${dev.cmnd}/POWER${pm[1]}`, payload: value ? 'ON' : 'OFF' };
    if (prop === 'dimmer') return { topic: `${dev.cmnd}/Dimmer`, payload: String(Math.round(value)) };
    return null;
  }
}
