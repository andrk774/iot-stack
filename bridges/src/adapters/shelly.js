// Shelly по MQTT.
// Gen2/Gen3 (Plus, Pro, Mini): <id>/online, <id>/status/<компонент:N>, <id>/events/rpc (NotifyStatus),
//   команды — RPC в <id>/rpc. В настройках Shelly нужно включить MQTT и «Generic status update over MQTT».
// Gen1: shellies/<id>/online, shellies/<id>/relay/<n>, …/relay/<n>/power, …/roller/0/pos, …/sensor/<имя>;
//   команды — shellies/<id>/relay/<n>/command (on/off), …/roller/0/command/pos.
// Устройство определяется по топику, начинающемуся с «shelly», или по списку config.prefixes.

const kWh = (wh) => Number((wh / 1000).toFixed(6));

const GEN2_FIELDS = {
  // компонент -> [поле статуса, суффикс свойства, спецификация, преобразование]
  switch: [
    ['output', '', { type: 'boolean', settable: true }],
    ['apower', 'power', { type: 'float', unit: 'W' }],
    ['voltage', 'voltage', { type: 'float', unit: 'V' }],
    ['current', 'current', { type: 'float', unit: 'A' }],
    ['aenergy.total', 'energy', { type: 'float', unit: 'kWh' }, kWh],
    ['temperature.tC', 'temp', { type: 'float', unit: '°C' }],
  ],
  light: [
    ['output', '', { type: 'boolean', settable: true }],
    ['brightness', 'brightness', { type: 'integer', min: 0, max: 100, settable: true }],
  ],
  cover: [
    ['current_pos', 'pos', { type: 'integer', min: 0, max: 100, settable: true }],
    ['state', 'state', { type: 'string' }],
    ['apower', 'power', { type: 'float', unit: 'W' }],
  ],
  input: [['state', '', { type: 'boolean' }]],
  temperature: [['tC', '', { type: 'float', unit: '°C' }]],
  humidity: [['rh', '', { type: 'float', unit: '%' }]],
  illuminance: [['lux', '', { type: 'float', unit: 'lx' }]],
  devicepower: [['battery.percent', 'battery', { type: 'integer', unit: '%' }]],
  pm1: [
    ['apower', 'power', { type: 'float', unit: 'W' }],
    ['voltage', 'voltage', { type: 'float', unit: 'V' }],
    ['current', 'current', { type: 'float', unit: 'A' }],
    ['aenergy.total', 'energy', { type: 'float', unit: 'kWh' }, kWh],
  ],
  em1: [
    ['act_power', 'power', { type: 'float', unit: 'W' }],
    ['voltage', 'voltage', { type: 'float', unit: 'V' }],
    ['current', 'current', { type: 'float', unit: 'A' }],
  ],
};

const get = (o, path) => path.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);

export class ShellyAdapter {
  constructor(config = {}) {
    this.prefixes = new Set(config.prefixes || []);
    this.gen1 = config.gen1 !== false;
    this.devices = new Map(); // key -> { key, name, gen, base, props, map: prop -> {comp, id, kind} }
    this.rpcId = 1;
  }

  subscriptions() {
    const subs = ['+/online', '+/status/+', '+/events/rpc'];
    if (this.gen1) subs.push('shellies/+/online', 'shellies/+/relay/+', 'shellies/+/relay/+/power', 'shellies/+/relay/+/energy',
      'shellies/+/roller/+/pos', 'shellies/+/sensor/+', 'shellies/+/light/+/status', 'shellies/+/temperature');
    return subs;
  }

  accepts(id) {
    return this.prefixes.size ? this.prefixes.has(id) : /^shelly/i.test(id);
  }

  device(key, gen, base) {
    let dev = this.devices.get(key);
    if (!dev) {
      dev = { key, name: key, gen, base, props: {}, map: new Map() };
      this.devices.set(key, dev);
    }
    return dev;
  }

  deviceEvent(dev) {
    return { kind: 'device', key: dev.key, name: dev.name, props: { ...dev.props } };
  }

  /** Завести свойство; true — состав свойств изменился */
  ensure(dev, prop, spec, target) {
    dev.map.set(prop, target);
    if (dev.props[prop] && JSON.stringify(dev.props[prop]) === JSON.stringify(spec)) return false;
    dev.props[prop] = spec;
    return true;
  }

  handle(topic, payload) {
    const text = payload.toString('utf8');
    const segs = topic.split('/');
    if (segs[0] === 'shellies' && this.gen1) return this.handleGen1(segs, text);
    const id = segs[0];
    if (!this.accepts(id)) return [];
    if (segs.length === 2 && segs[1] === 'online') {
      const dev = this.device(id, 2, id);
      const st = text.trim() === 'true' ? 'ready' : text.trim() === 'false' ? 'lost' : null;
      return [this.deviceEvent(dev), ...(st ? [{ kind: 'state', key: id, state: st }] : [])];
    }
    let j;
    try { j = JSON.parse(text); } catch { return []; }
    if (!j || typeof j !== 'object') return [];
    if (segs.length === 3 && segs[1] === 'status') return this.onComponent(this.device(id, 2, id), segs[2], j);
    if (segs.length === 3 && segs[1] === 'events' && segs[2] === 'rpc' && j.method === 'NotifyStatus' && j.params) {
      const dev = this.device(id, 2, id);
      const events = [];
      for (const [comp, status] of Object.entries(j.params)) if (status && typeof status === 'object') events.push(...this.onComponent(dev, comp, status));
      // NotifyStatus присылает только изменившиеся поля — описание устройства уже есть, отдельно его не шлём
      return events;
    }
    return [];
  }

  onComponent(dev, compKey, status) {
    const m = /^([a-z0-9]+):(\d+)$/.exec(compKey);
    if (!m || !GEN2_FIELDS[m[1]]) {
      if (compKey === 'sys' && typeof status.device?.name === 'string') dev.name = status.device.name.slice(0, 64);
      return [];
    }
    const [, comp, id] = m;
    const events = [];
    let changed = false;
    for (const [path, suffix, spec, conv] of GEN2_FIELDS[comp]) {
      let v = get(status, path);
      if (v === undefined || v === null) continue;
      if (conv && typeof v === 'number') v = conv(v);
      const prop = `${comp}${id}${suffix ? `_${suffix}` : ''}`;
      changed = this.ensure(dev, prop, spec, { comp, id: Number(id), field: path }) || changed;
      events.push({ kind: 'value', key: dev.key, prop, value: v });
    }
    return changed ? [this.deviceEvent(dev), ...events] : events;
  }

  handleGen1(segs, text) {
    const id = segs[1];
    if (!id || !this.accepts(id)) return [];
    const dev = this.device(id, 1, `shellies/${id}`);
    const t = text.trim();
    const rest = segs.slice(2).join('/');
    let prop; let spec; let value; let target = null;
    let m;
    if (rest === 'online') {
      const st = t === 'true' ? 'ready' : t === 'false' ? 'lost' : null;
      return [this.deviceEvent(dev), ...(st ? [{ kind: 'state', key: id, state: st }] : [])];
    }
    if ((m = /^relay\/(\d+)$/.exec(rest))) {
      prop = `relay${m[1]}`; spec = { type: 'boolean', settable: true }; value = t === 'on' ? true : t === 'off' ? false : undefined;
      target = { kind: 'relay', id: m[1] };
    } else if ((m = /^relay\/(\d+)\/power$/.exec(rest))) {
      prop = `relay${m[1]}_power`; spec = { type: 'float', unit: 'W' }; value = Number(t);
    } else if ((m = /^relay\/(\d+)\/energy$/.exec(rest))) {
      // Gen1 считает энергию в ватт-минутах
      prop = `relay${m[1]}_energy`; spec = { type: 'float', unit: 'kWh' }; value = Number((Number(t) / 60000).toFixed(6));
    } else if ((m = /^roller\/(\d+)\/pos$/.exec(rest))) {
      prop = `roller${m[1]}_pos`; spec = { type: 'integer', min: 0, max: 100, settable: true }; value = Number(t);
      target = { kind: 'roller', id: m[1] };
    } else if ((m = /^sensor\/([a-z_]+)$/.exec(rest))) {
      const units = { temperature: '°C', humidity: '%', lux: 'lx', battery: '%' };
      prop = m[1]; spec = units[m[1]] ? { type: 'float', unit: units[m[1]] } : { type: 'string' };
      value = spec.type === 'float' ? Number(t) : t;
    } else if (rest === 'temperature') {
      prop = 'device_temp'; spec = { type: 'float', unit: '°C' }; value = Number(t);
    } else if ((m = /^light\/(\d+)\/status$/.exec(rest))) {
      let j;
      try { j = JSON.parse(text); } catch { return []; }
      const events = [];
      let changed = this.ensure(dev, `light${m[1]}`, { type: 'boolean', settable: true }, { kind: 'light', id: m[1] });
      events.push({ kind: 'value', key: id, prop: `light${m[1]}`, value: j.ison === true });
      if (typeof j.brightness === 'number') {
        changed = this.ensure(dev, `light${m[1]}_brightness`, { type: 'integer', min: 0, max: 100, settable: true }, { kind: 'brightness', id: m[1] }) || changed;
        events.push({ kind: 'value', key: id, prop: `light${m[1]}_brightness`, value: j.brightness });
      }
      return changed ? [this.deviceEvent(dev), ...events] : events;
    } else {
      return [];
    }
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return [];
    const changed = this.ensure(dev, prop, spec, target);
    const ev = { kind: 'value', key: id, prop, value };
    return changed ? [this.deviceEvent(dev), ev] : [ev];
  }

  command(key, prop, value) {
    const dev = this.devices.get(key);
    const t = dev?.map.get(prop);
    if (!dev || !t || !dev.props[prop]?.settable) return null;
    if (dev.gen === 1) {
      if (t.kind === 'relay') return { topic: `${dev.base}/relay/${t.id}/command`, payload: value ? 'on' : 'off' };
      if (t.kind === 'roller') return { topic: `${dev.base}/roller/${t.id}/command/pos`, payload: String(Math.round(value)) };
      if (t.kind === 'light') return { topic: `${dev.base}/light/${t.id}/command`, payload: value ? 'on' : 'off' };
      if (t.kind === 'brightness') return { topic: `${dev.base}/light/${t.id}/set`, payload: JSON.stringify({ brightness: Math.round(value), turn: 'on' }) };
      return null;
    }
    const rpc = (method, params) => ({
      topic: `${dev.base}/rpc`,
      payload: JSON.stringify({ id: this.rpcId++, src: `iot-bridge-${dev.key}`.slice(0, 64), method, params }),
    });
    if (t.comp === 'switch' && t.field === 'output') return rpc('Switch.Set', { id: t.id, on: Boolean(value) });
    if (t.comp === 'light' && t.field === 'output') return rpc('Light.Set', { id: t.id, on: Boolean(value) });
    if (t.comp === 'light' && t.field === 'brightness') return rpc('Light.Set', { id: t.id, on: true, brightness: Math.round(value) });
    if (t.comp === 'cover' && t.field === 'current_pos') return rpc('Cover.GoToPosition', { id: t.id, pos: Math.round(value) });
    return null;
  }
}
