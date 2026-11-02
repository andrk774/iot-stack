// Устройства платформы -> устройства умного дома Яндекса (Алиса) и обратно. Без ввода-вывода.
//
// Правила:
//  - каждое управляемое boolean-свойство — «включить/выключить» (on_off). У устройства Яндекса on_off один,
//    поэтому реле №2, №3… становятся отдельными устройствами «<имя> · <свойство>» с id «<id>:<свойство>»;
//  - управляемые числа: яркость/диммер -> range brightness, позиция штор -> range open,
//    уставка температуры -> range temperature;
//  - датчики (числа с единицами) -> properties float: температура, влажность, мощность, напряжение, ток,
//    энергия, освещённость, CO2, давление, заряд батареи.

const isNum = (t) => t === 'float' || t === 'integer';

/** Свойство-датчик -> {instance, unit, scale} или null */
export function floatInstance(name, spec) {
  if (!isNum(spec.type)) return null;
  const n = name.toLowerCase();
  const u = (spec.unit || '').trim();
  if (u === '°C' || u === 'C' || (/temp/.test(n) && !u)) return { instance: 'temperature', unit: 'unit.temperature.celsius' };
  if (u === 'K') return { instance: 'temperature', unit: 'unit.temperature.kelvin' };
  if (/batt/.test(n) && u === '%') return { instance: 'battery_level', unit: 'unit.percent' };
  if (/humid|^rh$|_rh$/.test(n) && (u === '%' || !u)) return { instance: 'humidity', unit: 'unit.percent' };
  if (u === 'W' || u === 'Вт') return { instance: 'power', unit: 'unit.watt' };
  if (u === 'V' || u === 'В') return { instance: 'voltage', unit: 'unit.volt' };
  if (u === 'A' || u === 'А') return { instance: 'amperage', unit: 'unit.ampere' };
  if (/^k?wh$/i.test(u) || u === 'кВт·ч') return { instance: 'electricity_meter', unit: 'unit.kilowatt_hour', scale: /^wh$/i.test(u) ? 0.001 : 1 };
  if (u === 'lx' || u === 'лк') return { instance: 'illumination', unit: 'unit.illumination.lux' };
  if (u === 'ppm' && /co2/.test(n)) return { instance: 'co2_level', unit: 'unit.ppm' };
  if (u === 'hPa' || u === 'гПа') return { instance: 'pressure', unit: 'unit.pressure.pascal', scale: 100 };
  if (u === 'Pa' || u === 'Па') return { instance: 'pressure', unit: 'unit.pressure.pascal' };
  if (u === 'mmHg' || u === 'мм рт. ст.') return { instance: 'pressure', unit: 'unit.pressure.mmhg' };
  if (u === 'µg/m³' && /pm2/.test(n)) return { instance: 'pm2.5_density', unit: 'unit.density.mcg_m3' };
  if (u === 'µg/m³' && /pm10/.test(n)) return { instance: 'pm10_density', unit: 'unit.density.mcg_m3' };
  return null;
}

/** Управляемое число -> {instance, unit, min, max, precision} или null */
export function rangeInstance(name, spec) {
  if (!isNum(spec.type) || !spec.settable) return null;
  const n = name.toLowerCase();
  const r = rangeKind(n, spec);
  return r ? { ...r, type: spec.type } : null;
}

function rangeKind(n, spec) {
  const min = typeof spec.min === 'number' ? spec.min : 0;
  const max = typeof spec.max === 'number' ? spec.max : 100;
  if (/bright|dimmer|level/.test(n)) return { instance: 'brightness', unit: 'unit.percent', min, max, precision: 1, scale: 100 / (max - min || 1), offset: min };
  if (/pos|open|cover|roller|curtain|blind/.test(n)) return { instance: 'open', unit: 'unit.percent', min, max, precision: 1, scale: 100 / (max - min || 1), offset: min };
  if (/target|setpoint|set_temp|thermostat|heat/.test(n) && (spec.unit === '°C' || !spec.unit)) {
    return { instance: 'temperature', unit: 'unit.temperature.celsius', min: spec.min ?? 5, max: spec.max ?? 35, precision: spec.type === 'integer' ? 1 : 0.5, scale: 1, offset: 0 };
  }
  return null;
}

function typeFor(name, hasOnOff, ranges, floats, roomOrName) {
  const n = `${name} ${roomOrName}`.toLowerCase();
  if (ranges.some((r) => r.instance === 'open')) return 'devices.types.openable.curtain';
  if (ranges.some((r) => r.instance === 'brightness') || /свет|ламп|light|lamp|led/.test(n)) return hasOnOff ? 'devices.types.light' : 'devices.types.sensor';
  if (ranges.some((r) => r.instance === 'temperature')) return 'devices.types.thermostat';
  if (hasOnOff) return floats.some((f) => f.instance === 'power') || /розет|socket|plug/.test(n) ? 'devices.types.socket' : 'devices.types.switch';
  if (floats.some((f) => f.instance === 'temperature' || f.instance === 'humidity')) return 'devices.types.sensor.climate';
  return 'devices.types.sensor';
}

/**
 * Список устройств для Яндекса. device: { id, name, meta, room_name?, state, my_role }
 * Возвращает [{ yandex, bind: { prop -> capability|property описание } }]
 */
export function mapDevices(devices, { reportable = false } = {}) {
  const out = [];
  for (const d of devices) {
    const props = d.meta?.props && typeof d.meta.props === 'object' ? Object.entries(d.meta.props) : [];
    const onoff = props.filter(([, s]) => s?.type === 'boolean' && s.settable);
    const ranges = props.map(([k, s]) => [k, rangeInstance(k, s || {})]).filter(([, r]) => r);
    const floats = props.map(([k, s]) => [k, floatInstance(k, s || {})]).filter(([, f]) => f);
    // по одному instance на устройство: первые встретившиеся
    const uniq = (list) => {
      const seen = new Set();
      return list.filter(([, x]) => (seen.has(x.instance) ? false : seen.add(x.instance)));
    };
    const rangesU = uniq(ranges);
    const floatsU = uniq(floats);
    const info = { manufacturer: 'iot-stack', model: String(d.meta?.name || 'IoT device').slice(0, 256), ...(d.meta?.fw ? { sw_version: String(d.meta.fw).slice(0, 256) } : {}) };
    const base = (id, name, caps, propsY, binds, type) => ({
      yandex: {
        id, name: name.slice(0, 64), ...(d.room_name ? { room: d.room_name } : {}), type,
        status_info: { reportable }, device_info: info,
        ...(caps.length ? { capabilities: caps } : {}), ...(propsY.length ? { properties: propsY } : {}),
      },
      deviceId: d.id,
      bind: binds,
    });
    const capOnOff = () => ({ type: 'devices.capabilities.on_off', retrievable: true, reportable });
    const capRange = (r) => ({
      type: 'devices.capabilities.range', retrievable: true, reportable,
      parameters: { instance: r.instance, unit: r.unit, random_access: true, range: { min: r.instance === 'temperature' ? r.min : 0, max: r.instance === 'temperature' ? r.max : 100, precision: r.precision } },
    });
    const propFloat = (f) => ({ type: 'devices.properties.float', retrievable: true, reportable, parameters: { instance: f.instance, unit: f.unit } });

    const caps = [];
    const binds = {};
    if (onoff[0]) { caps.push(capOnOff()); binds[`on_off:on`] = { prop: onoff[0][0], kind: 'on_off' }; }
    for (const [k, r] of rangesU) { caps.push(capRange(r)); binds[`range:${r.instance}`] = { prop: k, kind: 'range', ...r }; }
    const propsY = floatsU.map(([, f]) => propFloat(f));
    for (const [k, f] of floatsU) binds[`float:${f.instance}`] = { prop: k, kind: 'float', ...f };
    if (caps.length || propsY.length) {
      out.push(base(d.id, d.name, caps, propsY, binds, typeFor(onoff[0]?.[0] || '', Boolean(onoff[0]), rangesU.map(([, r]) => r), floatsU.map(([, f]) => f), d.name)));
    }
    // второе и следующие реле — отдельные устройства
    for (const [k] of onoff.slice(1)) {
      out.push(base(`${d.id}:${k}`, `${d.name} · ${k}`, [capOnOff()], [], { 'on_off:on': { prop: k, kind: 'on_off' } },
        /свет|ламп|light|lamp/.test(`${d.name} ${k}`.toLowerCase()) ? 'devices.types.light' : 'devices.types.switch'));
    }
  }
  return out;
}

const truthy = (v) => v === true || v === 1 || v === 'true' || v === '1' || v === 'on' || v === 'ON';

/** Состояние одного устройства Яндекса по последним значениям */
export function stateOf(mapped, lastValues) {
  const capabilities = [];
  const properties = [];
  for (const [key, b] of Object.entries(mapped.bind)) {
    const raw = lastValues?.[b.prop];
    if (raw === undefined || raw === null || raw === '') continue;
    if (b.kind === 'on_off') capabilities.push({ type: 'devices.capabilities.on_off', state: { instance: 'on', value: truthy(raw) } });
    else {
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      if (b.kind === 'range') {
        const value = b.instance === 'temperature' ? v : Math.round((v - b.offset) * b.scale);
        capabilities.push({ type: 'devices.capabilities.range', state: { instance: b.instance, value } });
      } else {
        properties.push({ type: 'devices.properties.float', state: { instance: b.instance, value: Math.round(v * (b.scale ?? 1) * 1000) / 1000 } });
      }
    }
    void key;
  }
  return { capabilities, properties };
}

/**
 * Действие Яндекса -> {prop, value} для команды устройству или {error}.
 * current — последние значения (для relative).
 */
export function actionToCommand(mapped, cap, lastValues) {
  const st = cap?.state;
  if (!st || typeof st.instance !== 'string') return { error: 'INVALID_ACTION' };
  if (cap.type === 'devices.capabilities.on_off') {
    const b = mapped.bind['on_off:on'];
    if (!b || st.instance !== 'on' || typeof st.value !== 'boolean') return { error: 'INVALID_ACTION' };
    return { prop: b.prop, value: st.value };
  }
  if (cap.type === 'devices.capabilities.range') {
    const b = mapped.bind[`range:${st.instance}`];
    if (!b || typeof st.value !== 'number' || !Number.isFinite(st.value)) return { error: 'INVALID_ACTION' };
    let target;
    if (b.instance === 'temperature') {
      target = st.relative ? Number(lastValues?.[b.prop] ?? 0) + st.value : st.value;
    } else {
      const curPct = (Number(lastValues?.[b.prop] ?? b.min) - b.offset) * b.scale;
      const pct = Math.min(100, Math.max(0, st.relative ? curPct + st.value : st.value));
      target = b.offset + pct / b.scale;
    }
    target = Math.min(b.max, Math.max(b.min, target));
    return { prop: b.prop, value: b.type === 'integer' ? Math.round(target) : Math.round(target * 1000) / 1000 };
  }
  return { error: 'INVALID_ACTION' };
}
