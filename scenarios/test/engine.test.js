import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const T = 'd0123456789abcdef'; // термометр
const R = 'dfedcba9876543210'; // реле

function setup(scenarios, { now = 1_000_000 } = {}) {
  const calls = { set: [], notify: [], runs: [], sleeps: [] };
  let clock = now;
  const engine = new Engine({
    publishSet: async (id, p, v) => { calls.set.push([id, p, v]); },
    notify: async (s, level, msg) => { calls.notify.push([s.id, level, msg]); },
    saveRun: async (s, err) => { calls.runs.push([s.id, err]); },
    sleep: async (ms) => { calls.sleeps.push(ms); },
    now: () => clock,
    log: {},
    defaultTz: 'UTC',
  });
  engine.load(scenarios, [
    { id: T, name: 'Теплица', state: 'ready', last_values: { temperature: 25 } },
    { id: R, name: 'Вентилятор', state: 'ready', last_values: { relay: 0, mode: 'auto' } },
  ]);
  return { engine, calls, advance: (ms) => { clock += ms; } };
}

const hot = {
  id: 's1', name: 'Жарко', enabled: true, cooldown_sec: 0,
  trigger: { type: 'property', device_id: T, property: 'temperature', op: 'gt', value: 30 },
  conditions: [{ device_id: R, property: 'mode', op: 'eq', value: 'auto' }],
  actions: [
    { type: 'set', device_id: R, property: 'relay', value: true },
    { type: 'delay', seconds: 5 },
    { type: 'notify', level: 'warning', message: '{device}: {property} = {value}' },
  ],
};

test('threshold fires once on rising edge, then re-arms', async () => {
  const { engine, calls } = setup([hot]);
  await Promise.all(engine.onValue(T, 'temperature', '31.5'));
  await Promise.all(engine.onValue(T, 'temperature', '32'));    // всё ещё выше — не повторяем
  assert.deepEqual(calls.set, [[R, 'relay', true]]);
  assert.deepEqual(calls.sleeps, [5000]);
  assert.deepEqual(calls.notify, [['s1', 'warning', 'Теплица: temperature = 31.5']]);
  assert.deepEqual(calls.runs, [['s1', null]]);

  await Promise.all(engine.onValue(T, 'temperature', '29'));    // ниже — взвели
  await Promise.all(engine.onValue(T, 'temperature', '30.1'));  // снова выше — сработало
  assert.equal(calls.set.length, 2);
});

test('already above threshold at startup does not fire', async () => {
  const { engine, calls } = setup([]);
  engine.devices.get(T).values.temperature = 35;
  engine.load([hot], []);
  await Promise.all(engine.onValue(T, 'temperature', '36'));
  assert.equal(calls.set.length, 0);
});

test('conditions gate the run', async () => {
  const { engine, calls } = setup([hot]);
  engine.onValue(R, 'mode', 'manual');
  await Promise.all(engine.onValue(T, 'temperature', '31'));
  assert.equal(calls.set.length, 0);
});

test('cooldown and changed operator', async () => {
  const s = { ...hot, id: 's2', conditions: [], cooldown_sec: 60, trigger: { type: 'property', device_id: R, property: 'relay', op: 'changed' },
    actions: [{ type: 'notify', level: 'info', message: 'реле {value}' }] };
  const { engine, calls, advance } = setup([s]);
  await Promise.all(engine.onValue(R, 'relay', '0'));   // то же значение (0 -> "0") — не изменение
  await Promise.all(engine.onValue(R, 'relay', 'true'));
  await Promise.all(engine.onValue(R, 'relay', 'false')); // внутри cooldown
  advance(61_000);
  await Promise.all(engine.onValue(R, 'relay', 'true'));
  assert.deepEqual(calls.notify.map((n) => n[2]), ['реле true', 'реле true']);
});

test('state trigger fires on transition only', async () => {
  const s = { ...hot, id: 's3', conditions: [], trigger: { type: 'state', device_id: T, state: 'lost' },
    actions: [{ type: 'notify', level: 'alert', message: '{device} пропало' }] };
  const { engine, calls } = setup([s]);
  await Promise.all(engine.onState(T, 'lost'));
  await Promise.all(engine.onState(T, 'lost'));
  assert.deepEqual(calls.notify, [['s3', 'alert', 'Теплица пропало']]);
});

test('schedule in time zone, manual run, disabled', async () => {
  const s = { ...hot, id: 's4', conditions: [], trigger: { type: 'schedule', cron: '0 7 * * *', tz: 'Asia/Yekaterinburg' },
    actions: [{ type: 'set', device_id: R, property: 'relay', value: false }] };
  const off = { ...s, id: 's5', enabled: false };
  const { engine, calls } = setup([s, off]);
  await Promise.all(engine.tick(new Date('2026-10-23T01:00:00Z')));  // 06:00 локально
  await Promise.all(engine.tick(new Date('2026-10-23T02:00:00Z')));  // 07:00 локально
  assert.deepEqual(calls.set, [[R, 'relay', false]]);
  await Promise.all(engine.runManual('s4'));
  assert.equal(calls.set.length, 2);
  assert.deepEqual(engine.runManual('s5').filter(Boolean), []);
});

test('failing action records error, loop protection', async () => {
  const { engine, calls } = setup([]);
  engine.deps.publishSet = async () => { throw new Error('mqtt down'); };
  const s = { ...hot, id: 's6', conditions: [], trigger: { type: 'property', device_id: T, property: 'x', op: 'changed' },
    actions: [{ type: 'set', device_id: R, property: 'relay', value: true }, { type: 'notify', level: 'info', message: 'never' }] };
  engine.load([s], []);
  engine.onValue(T, 'x', '0');
  await Promise.all(engine.onValue(T, 'x', '1'));
  assert.deepEqual(calls.runs, [['s6', 'set: mqtt down']]);
  assert.equal(calls.notify.length, 0);

  engine.deps.publishSet = async () => {};
  for (let i = 2; i < 40; i++) await Promise.all(engine.onValue(T, 'x', String(i)));
  assert.equal(calls.runs.filter((r) => r[1] === null).length, 29);
  assert.match(calls.runs.at(-1)[1], /больше 30/);
});

test('set action respects settable from current $meta', async () => {
  const s = { ...hot, id: 's7', conditions: [], trigger: { type: 'manual' },
    actions: [{ type: 'set', device_id: R, property: 'relay', value: true }] };
  const { engine, calls } = setup([s]);
  await Promise.all(engine.runManual('s7'));          // $meta ещё нет — можно
  assert.equal(calls.set.length, 1);
  engine.onMeta(R, { props: { relay: { type: 'boolean' } } }); // перестало быть settable
  await Promise.all(engine.runManual('s7'));
  assert.equal(calls.set.length, 1);
  assert.match(calls.runs.at(-1)[1], /не управляемое/);
  engine.onMeta(R, { props: { relay: { type: 'boolean', settable: true } } });
  await Promise.all(engine.runManual('s7'));
  assert.equal(calls.set.length, 2);
});
