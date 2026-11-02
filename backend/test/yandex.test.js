// Алиса: отображение устройств, состояния и команд.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapDevices, stateOf, actionToCommand, floatInstance } from '../src/yandex/map.js';
import { redirectAllowed } from '../src/routes/yandex.js';

const plug = {
  id: 'd0000000000000001', name: 'Розетка', room_name: 'Кухня', state: 'ready', my_role: 'owner',
  meta: { name: 'Sonoff', fw: '13.2', props: {
    power: { type: 'boolean', settable: true }, energy_power: { type: 'float', unit: 'W' },
    energy_total: { type: 'float', unit: 'kWh' }, energy_voltage: { type: 'float', unit: 'V' }, rssi: { type: 'integer', unit: '%' },
  } },
  last_values: { power: true, energy_power: 120.5, energy_total: 3.25, energy_voltage: 229 },
};
const relay2 = {
  id: 'd0000000000000002', name: 'Свет в зале', state: 'ready', my_role: 'control',
  meta: { props: { power1: { type: 'boolean', settable: true }, power2: { type: 'boolean', settable: true }, dimmer: { type: 'integer', min: 0, max: 255, settable: true } } },
  last_values: { power1: 'true', power2: 'false', dimmer: 128 },
};
const climate = {
  id: 'd0000000000000003', name: 'Датчик спальни', state: 'lost', my_role: 'view',
  meta: { props: { temperature: { type: 'float', unit: '°C' }, humidity: { type: 'float', unit: '%' }, pressure: { type: 'float', unit: 'hPa' }, battery: { type: 'integer', unit: '%' } } },
  last_values: { temperature: 21.5, humidity: 40, pressure: 1013.2 },
};
const nothing = { id: 'd0000000000000004', name: 'Текст', meta: { props: { note: { type: 'string' } } }, last_values: {} };

test('devices are mapped to Yandex types, capabilities and properties', () => {
  const out = mapDevices([plug, relay2, climate, nothing]);
  const ids = out.map((m) => m.yandex.id);
  assert.deepEqual(ids, ['d0000000000000001', 'd0000000000000002', 'd0000000000000002:power2', 'd0000000000000003']);
  const [p, r1, r2, c] = out.map((m) => m.yandex);
  assert.equal(p.type, 'devices.types.socket');
  assert.equal(p.room, 'Кухня');
  assert.deepEqual(p.capabilities, [{ type: 'devices.capabilities.on_off', retrievable: true, reportable: false }]);
  assert.deepEqual(p.properties.map((x) => x.parameters), [
    { instance: 'power', unit: 'unit.watt' }, { instance: 'electricity_meter', unit: 'unit.kilowatt_hour' }, { instance: 'voltage', unit: 'unit.volt' }]);
  assert.deepEqual(p.device_info, { manufacturer: 'iot-stack', model: 'Sonoff', sw_version: '13.2' });
  assert.equal(r1.type, 'devices.types.light');
  assert.deepEqual(r1.capabilities[1].parameters, { instance: 'brightness', unit: 'unit.percent', random_access: true, range: { min: 0, max: 100, precision: 1 } });
  assert.equal(r2.name, 'Свет в зале · power2');
  assert.equal(c.type, 'devices.types.sensor.climate');
  assert.deepEqual(c.properties.map((x) => x.parameters.instance), ['temperature', 'humidity', 'pressure', 'battery_level']);
  assert.equal(floatInstance('rssi', { type: 'integer', unit: '%' }), null);
});

test('state: booleans, percent scaling, unit conversion', () => {
  const [p, r1, r2, c] = mapDevices([plug, relay2, climate]);
  assert.deepEqual(stateOf(p, plug.last_values), {
    capabilities: [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: true } }],
    properties: [
      { type: 'devices.properties.float', state: { instance: 'power', value: 120.5 } },
      { type: 'devices.properties.float', state: { instance: 'electricity_meter', value: 3.25 } },
      { type: 'devices.properties.float', state: { instance: 'voltage', value: 229 } }],
  });
  assert.deepEqual(stateOf(r1, relay2.last_values).capabilities.map((x) => x.state), [{ instance: 'on', value: true }, { instance: 'brightness', value: 50 }]);
  assert.deepEqual(stateOf(r2, relay2.last_values).capabilities[0].state, { instance: 'on', value: false });
  const props = stateOf(c, climate.last_values).properties;
  assert.equal(props.find((x) => x.state.instance === 'pressure').state.value, 101320); // гПа -> Па
  assert.ok(!props.some((x) => x.state.instance === 'battery_level')); // значения нет — не отдаём
});

test('actions: on_off, absolute and relative brightness, bad input', () => {
  const [, r1, r2] = mapDevices([plug, relay2]);
  assert.deepEqual(actionToCommand(r2, { type: 'devices.capabilities.on_off', state: { instance: 'on', value: true } }), { prop: 'power2', value: true });
  assert.deepEqual(actionToCommand(r1, { type: 'devices.capabilities.range', state: { instance: 'brightness', value: 100 } }, relay2.last_values), { prop: 'dimmer', value: 255 });
  assert.deepEqual(actionToCommand(r1, { type: 'devices.capabilities.range', state: { instance: 'brightness', value: -30, relative: true } }, relay2.last_values), { prop: 'dimmer', value: 52 }); // 50,2% − 30% = 20,2% от 255
  assert.deepEqual(actionToCommand(r1, { type: 'devices.capabilities.range', state: { instance: 'brightness', value: 500 } }, {}), { prop: 'dimmer', value: 255 });
  assert.equal(actionToCommand(r1, { type: 'devices.capabilities.on_off', state: { instance: 'on', value: 'yes' } }).error, 'INVALID_ACTION');
  assert.equal(actionToCommand(r1, { type: 'devices.capabilities.color_setting', state: { instance: 'hsv', value: {} } }).error, 'INVALID_ACTION');
  assert.equal(actionToCommand(r1, { type: 'devices.capabilities.range', state: { instance: 'open', value: 1 } }).error, 'INVALID_ACTION');
});

test('redirect_uri allowlist', () => {
  const p = ['https://social.yandex.net/'];
  assert.equal(redirectAllowed('https://social.yandex.net/broker/redirect', p), true);
  for (const bad of ['http://social.yandex.net/broker/redirect', 'https://social.yandex.net.evil.com/x', 'https://evil.com/?https://social.yandex.net/', 'javascript:alert(1)', 42]) {
    assert.equal(redirectAllowed(bad, p), false, String(bad));
  }
});
