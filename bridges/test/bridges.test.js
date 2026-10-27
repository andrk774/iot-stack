import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, parseCommand, toWire } from '../src/props.js';
import { Zigbee2MqttAdapter, flattenExposes } from '../src/adapters/zigbee2mqtt.js';
import { EsphomeAdapter, expandConfig } from '../src/adapters/esphome.js';
import { GenericAdapter } from '../src/adapters/generic.js';
import { BridgeCore } from '../src/core.js';

const B = (s) => Buffer.from(typeof s === 'string' ? s : JSON.stringify(s));

test('props helpers', () => {
  assert.equal(sanitizeName('Temperature'), 'temperature');
  assert.equal(sanitizeName('state_l1'), 'state_l1');
  assert.equal(sanitizeName('Living Room Temp!'), 'living_room_temp');
  assert.equal(sanitizeName('1st'), 'st');
  assert.equal(sanitizeName('Температура'), 'value');
  assert.equal(sanitizeName('x'.repeat(50)).length, 32);
  assert.equal(parseCommand('on', { type: 'boolean' }), true);
  assert.equal(parseCommand('300', { type: 'float', max: 254 }), undefined);
  assert.equal(parseCommand('12.7', { type: 'integer' }), 13);
  assert.equal(toWire(false), 'false');
  assert.equal(toWire(NaN), null);
});

// --- zigbee2mqtt: фрагмент реального bridge/devices ---
const z2mDevices = [
  { ieee_address: '0x00124b0000000001', type: 'Coordinator', friendly_name: 'Coordinator' },
  {
    ieee_address: '0x00158d0001a2b3c4', type: 'EndDevice', friendly_name: 'kitchen/sensor',
    definition: { model: 'WSDCGQ11LM', vendor: 'Aqara', exposes: [
      { type: 'numeric', name: 'temperature', property: 'temperature', access: 1, unit: '°C' },
      { type: 'numeric', name: 'humidity', property: 'humidity', access: 1, unit: '%' },
      { type: 'numeric', name: 'battery', property: 'battery', access: 1, unit: '%', value_min: 0, value_max: 100 },
      { type: 'numeric', name: 'linkquality', property: 'linkquality', access: 1, unit: 'lqi' },
    ] },
  },
  {
    ieee_address: '0x0017880100aabbcc', type: 'Router', friendly_name: 'lamp',
    definition: { model: 'LCT015', vendor: 'Philips', exposes: [
      { type: 'light', features: [
        { type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF', value_toggle: 'TOGGLE' },
        { type: 'numeric', name: 'brightness', property: 'brightness', access: 7, value_min: 0, value_max: 254 },
        { type: 'composite', name: 'color_xy', property: 'color', access: 7, features: [] },
      ] },
      { type: 'enum', name: 'effect', property: 'effect', access: 2, values: ['blink', 'breathe', 'okay'] },
    ] },
  },
  { ieee_address: '0xdead', type: 'EndDevice', friendly_name: 'unsupported', definition: null },
];

test('zigbee2mqtt: devices, values, availability, commands', () => {
  const z = new Zigbee2MqttAdapter({ base_topic: 'zigbee2mqtt' });
  assert.equal(flattenExposes(z2mDevices[2].definition.exposes).length, 3); // state, brightness, effect
  const evs = z.handle('zigbee2mqtt/bridge/devices', B(z2mDevices));
  assert.deepEqual(evs.map((e) => [e.kind, e.key, e.name]), [
    ['device', '0x00158d0001a2b3c4', 'kitchen/sensor'], ['device', '0x0017880100aabbcc', 'lamp']]);
  assert.deepEqual(evs[0].props.battery, { type: 'float', unit: '%', min: 0, max: 100 });
  assert.deepEqual(evs[1].props.state, { type: 'boolean', settable: true });
  assert.equal(evs[1].props.brightness.max, 254);

  // имя с "/" — сопоставляется целиком
  assert.deepEqual(z.handle('zigbee2mqtt/kitchen/sensor', B({ temperature: 21.4, humidity: 55, voltage: 3000 })), [
    { kind: 'value', key: '0x00158d0001a2b3c4', prop: 'temperature', value: 21.4 },
    { kind: 'value', key: '0x00158d0001a2b3c4', prop: 'humidity', value: 55 },
  ]);
  assert.deepEqual(z.handle('zigbee2mqtt/lamp', B({ state: 'ON', brightness: 120 })).map((e) => e.value), [true, 120]);
  assert.deepEqual(z.handle('zigbee2mqtt/lamp/availability', B({ state: 'offline' })), [{ kind: 'state', key: '0x0017880100aabbcc', state: 'lost' }]);
  assert.deepEqual(z.handle('zigbee2mqtt/lamp/availability', B('online'))[0].state, 'ready');
  assert.deepEqual(z.handle('zigbee2mqtt/lamp/set', B({ state: 'ON' })), []);
  assert.deepEqual(z.handle('zigbee2mqtt/unknown', B({ a: 1 })), []);

  assert.deepEqual(z.command('0x0017880100aabbcc', 'state', false), { topic: 'zigbee2mqtt/lamp/set', payload: '{"state":"OFF"}' });
  assert.deepEqual(z.command('0x0017880100aabbcc', 'brightness', 200), { topic: 'zigbee2mqtt/lamp/set', payload: '{"brightness":200}' });
  assert.equal(z.command('0x0017880100aabbcc', 'effect', 'disco'), null);
  assert.equal(z.command('0x0017880100aabbcc', 'effect', 'blink').payload, '{"effect":"blink"}');
});

// --- ESPHome MQTT discovery (сокращённые ключи, как публикует ESPHome) ---
const espDev = { ids: 'e8db84a1b2c3', name: 'greenhouse', sw: 'esphome v2024.6.0', mdl: 'esp32dev', mf: 'espressif' };
const espConfigs = [
  ['homeassistant/sensor/greenhouse/temperature/config', { dev_cla: 'temperature', unit_of_meas: '°C', stat_cla: 'measurement', name: 'Temperature',
    stat_t: 'greenhouse/sensor/temperature/state', avty_t: 'greenhouse/status', uniq_id: 'ESPsensortemperature', dev: espDev }],
  ['homeassistant/switch/greenhouse/fan/config', { name: 'Fan', stat_t: 'greenhouse/switch/fan/state', cmd_t: 'greenhouse/switch/fan/command',
    avty_t: 'greenhouse/status', uniq_id: 'ESPswitchfan', dev: espDev }],
  ['homeassistant/light/greenhouse/grow_light/config', { name: 'Grow light', schema: 'json', brightness: true, color_mode: true,
    '~': 'greenhouse/light/grow_light', stat_t: '~/state', cmd_t: '~/command', uniq_id: 'ESPlightgrow', dev: espDev }],
  ['homeassistant/number/greenhouse/target/config', { name: 'Target', min: 10, max: 35, step: 0.5, stat_t: 'greenhouse/number/target/state',
    cmd_t: 'greenhouse/number/target/command', dev: espDev }],
  ['homeassistant/sensor/greenhouse/wifi_ssid/config', { name: 'SSID', stat_t: 'greenhouse/sensor/wifi_ssid/state', dev: espDev }],
  ['homeassistant/climate/greenhouse/heater/config', { name: 'Heater', dev: espDev }],
];

test('esphome: discovery -> device, values, availability, commands', () => {
  assert.equal(expandConfig({ '~': 'a/b', stat_t: '~/state', cmd_t: 'x' }).state_topic, 'a/b/state');
  const e = new EsphomeAdapter();
  let last;
  const subs = [];
  for (const [t, c] of espConfigs) {
    const evs = e.handle(t, B(c));
    subs.push(...evs.filter((x) => x.kind === 'subscribe').map((x) => x.topic));
    last = evs.filter((x) => x.kind === 'device').at(-1) ?? last;
  }
  assert.equal(last.key, 'e8db84a1b2c3');
  assert.equal(last.name, 'greenhouse');
  assert.deepEqual(Object.keys(last.props), ['temperature', 'fan', 'grow_light', 'grow_light_brightness', 'target', 'wifi_ssid']);
  assert.deepEqual(last.props.temperature, { type: 'float', unit: '°C' });
  assert.deepEqual(last.props.target, { type: 'float', settable: true, min: 10, max: 35 });
  assert.equal(last.props.wifi_ssid.type, 'string');
  assert.ok(subs.includes('greenhouse/status') && subs.includes('greenhouse/light/grow_light/state'));

  assert.deepEqual(e.handle('greenhouse/sensor/temperature/state', B('23.7')), [{ kind: 'value', key: 'e8db84a1b2c3', prop: 'temperature', value: 23.7 }]);
  assert.deepEqual(e.handle('greenhouse/sensor/temperature/state', B('nan')), []);
  assert.deepEqual(e.handle('greenhouse/switch/fan/state', B('ON'))[0].value, true);
  assert.deepEqual(e.handle('greenhouse/light/grow_light/state', B({ state: 'ON', brightness: 200, color_mode: 'brightness' })).map((x) => [x.prop, x.value]),
    [['grow_light', true], ['grow_light_brightness', 200]]);
  assert.deepEqual(e.handle('greenhouse/status', B('offline')), [{ kind: 'state', key: 'e8db84a1b2c3', state: 'lost' }]);

  assert.deepEqual(e.command('e8db84a1b2c3', 'fan', true), { topic: 'greenhouse/switch/fan/command', payload: 'ON' });
  assert.deepEqual(e.command('e8db84a1b2c3', 'grow_light_brightness', 128), { topic: 'greenhouse/light/grow_light/command', payload: '{"state":"ON","brightness":128}' });
  assert.deepEqual(e.command('e8db84a1b2c3', 'target', 21.5), { topic: 'greenhouse/number/target/command', payload: '21.5' });
  assert.equal(e.command('e8db84a1b2c3', 'temperature', 1), null);

  // удаление сущности
  const rm = e.handle('homeassistant/switch/greenhouse/fan/config', B(''));
  assert.equal(rm[0].props.fan, undefined);
});

test('generic adapter', () => {
  const g = new GenericAdapter({ mappings: [
    { topic: 'home/boiler', device_key: 'boiler', device_name: 'Котёл', property: 'temp', type: 'float', json_key: 'sensors.t', unit: '°C' },
    { topic: 'home/boiler', device_key: 'boiler', property: 'pump', type: 'boolean', json_key: 'pump', payload_on: 'RUN', payload_off: 'STOP', command_topic: 'home/boiler/pump/set' },
  ] });
  assert.deepEqual(g.subscriptions(), ['home/boiler']);
  const [dev] = g.initialEvents();
  assert.equal(dev.name, 'Котёл');
  assert.deepEqual(dev.props.pump, { type: 'boolean', settable: true });
  assert.deepEqual(g.handle('home/boiler', B({ sensors: { t: 61.5 }, pump: 'RUN' })).map((e) => e.value), [61.5, true]);
  assert.deepEqual(g.handle('home/boiler', B('not json')), []);
  assert.deepEqual(g.command('boiler', 'pump', false), { topic: 'home/boiler/pump/set', payload: 'STOP' });
  assert.equal(g.command('boiler', 'temp', 1), null);
});

test('core: registers devices, buffers values, routes commands', async () => {
  const pub = [];
  const ext = [];
  const subs = [];
  const extSubs = [];
  let n = 0;
  const core = new BridgeCore({
    api: { registerDevice: async (key, name) => ({ id: `d${String(++n).padStart(16, '0')}`, key, name }) },
    publish: async (t, p, o) => { pub.push([t, p, Boolean(o?.retain)]); },
    subscribe: async (f) => { subs.push(f); },
    publishExternal: async (t, p) => { ext.push([t, p]); },
    subscribeExternal: async (f) => { extSubs.push(f); },
    adapter: new Zigbee2MqttAdapter(),
    metaDebounceMs: 0,
    log: {},
  });
  await core.start();
  assert.deepEqual(extSubs, ['zigbee2mqtt/#']);
  await core.onExternalMessage('zigbee2mqtt/bridge/devices', B(z2mDevices));
  const id = 'd0000000000000002'; // лампа
  assert.ok(subs.includes(`dev/${id}/+/set`));
  const meta = pub.find(([t]) => t === `dev/${id}/$meta`);
  assert.equal(JSON.parse(meta[1]).name, 'lamp');
  assert.equal(meta[2], true);
  assert.ok(pub.some(([t, p, r]) => t === `dev/${id}/$state` && p === 'ready' && r));

  await core.onExternalMessage('zigbee2mqtt/lamp', B({ state: 'OFF' }));
  assert.deepEqual(pub.at(-1), [`dev/${id}/state`, 'false', false]);

  assert.deepEqual(await core.onCommand(`dev/${id}/state/set`, B('true')), { topic: 'zigbee2mqtt/lamp/set', payload: '{"state":"ON"}' });
  assert.equal(await core.onCommand(`dev/${id}/brightness/set`, B('999')), null);  // вне диапазона
  assert.equal(await core.onCommand('dev/d0000000000000001/temperature/set', B('5')), null); // не settable
  assert.equal(ext.length, 1);
});
