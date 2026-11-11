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

// ---------- пороги, длительность, «нет данных», условия ----------
const runs = (calls) => calls.runs.map(([id]) => id);

test('hysteresis: no chatter around the threshold', async () => {
  const s = { ...hot, id: 'h', conditions: [], actions: [{ type: 'notify', message: 'x' }], trigger: { ...hot.trigger, hysteresis: 2 } };
  const { engine, calls } = setup([s]);
  await Promise.all(engine.onValue(T, 'temperature', '30.5'));
  await Promise.all(engine.onValue(T, 'temperature', '29.5')); // ниже порога, но не на 2 градуса
  await Promise.all(engine.onValue(T, 'temperature', '30.4'));
  assert.deepEqual(runs(calls), ['h']);
  await Promise.all(engine.onValue(T, 'temperature', '27.9')); // ушло на гистерезис — взвелось
  await Promise.all(engine.onValue(T, 'temperature', '31'));
  assert.deepEqual(runs(calls), ['h', 'h']);
  // для «меньше» — наоборот
  const cold = { ...s, id: 'c', trigger: { type: 'property', device_id: T, property: 'temperature', op: 'lt', value: 10, hysteresis: 1 } };
  const e2 = setup([cold]);
  for (const v of ['9', '10.5', '9', '11.2', '9']) await Promise.all(e2.engine.onValue(T, 'temperature', v));
  assert.deepEqual(runs(e2.calls), ['c', 'c']);
});

test('for_sec: fires only if condition holds long enough', async () => {
  const s = { ...hot, id: 'f', conditions: [], actions: [{ type: 'notify', level: 'info', message: '{value}' }], trigger: { ...hot.trigger, for_sec: 60 } };
  const { engine, calls, advance } = setup([s]);
  engine.onValue(T, 'temperature', '31');
  advance(30_000);
  await Promise.all(engine.poll());
  engine.onValue(T, 'temperature', '29'); // прервалось
  advance(40_000);
  await Promise.all(engine.poll());
  assert.deepEqual(runs(calls), []);
  engine.onValue(T, 'temperature', '32');
  advance(30_000);
  engine.onValue(T, 'temperature', '33'); // всё ещё выше — отсчёт не сбрасывается
  advance(31_000);
  await Promise.all(engine.poll());
  assert.deepEqual(runs(calls), ['f']);
  assert.deepEqual(calls.notify.at(-1), ['f', 'info', '33']);
  advance(120_000);
  await Promise.all(engine.poll()); // повторно — только после возврата ниже порога
  assert.deepEqual(runs(calls), ['f']);
});

test('stale: no data for N minutes fires once until data returns', async () => {
  const s = { id: 'st', name: 'Тишина', enabled: true, cooldown_sec: 0, trigger: { type: 'stale', device_id: T, minutes: 10 }, conditions: [], actions: [{ type: 'notify', message: '{device} молчит {value} мин' }] };
  const p = { ...s, id: 'sp', trigger: { type: 'stale', device_id: T, property: 'humidity', minutes: 5 } };
  const { engine, calls, advance } = setup([s, p]);
  advance(4 * 60_000);
  engine.onValue(T, 'temperature', '25');
  advance(6 * 60_000);
  await Promise.all(engine.poll());
  assert.deepEqual(runs(calls), ['sp']); // humidity не приходила ни разу
  advance(5 * 60_000);
  await Promise.all(engine.poll());
  await Promise.all(engine.poll());
  assert.deepEqual(runs(calls), ['sp', 'st']);
  assert.equal(calls.notify.at(-1)[2], 'Теплица молчит 10 мин');
  engine.onValue(T, 'temperature', '25'); // данные вернулись — взвелось
  advance(11 * 60_000);
  await Promise.all(engine.poll());
  assert.deepEqual(runs(calls), ['sp', 'st', 'st']);
});

test('conditions: any/all, device state, time window across midnight', async () => {
  const base = { id: 'm', name: 'M', enabled: true, cooldown_sec: 0, trigger: { type: 'manual' }, actions: [{ type: 'notify', message: 'x' }] };
  const night = { type: 'time', from: '22:00', to: '07:00' };
  // 1_000_000 мс = 00:16:40 UTC четверга 1 января 1970
  const s1 = { ...base, id: 'all', conditions: [night, { type: 'state', device_id: R, state: 'ready' }] };
  const s2 = { ...base, id: 'any', condition_mode: 'any', conditions: [{ type: 'time', from: '08:00', to: '20:00' }, { type: 'state', device_id: R, state: 'lost' }] };
  const s3 = { ...base, id: 'days', conditions: [{ type: 'time', from: '22:00', to: '07:00', days: [3] }] }; // ночь со среды на четверг
  const s4 = { ...base, id: 'neg', conditions: [{ type: 'state', device_id: R, state: 'ready', negate: true }] };
  const { engine } = setup([s1, s2, s3, s4]);
  assert.equal(engine.conditionsHold(s1), true);
  assert.equal(engine.conditionsHold(s2), false);
  assert.equal(engine.conditionsHold(s3), true);
  assert.equal(engine.conditionsHold({ ...s3, conditions: [{ ...s3.conditions[0], days: [4] }] }), false);
  assert.equal(engine.conditionsHold(s4), false);
  engine.onState(R, 'lost');
  assert.equal(engine.conditionsHold(s2), true);
  assert.equal(engine.conditionsHold(s1), false);
  assert.equal(engine.conditionsHold(s4), true);
  assert.equal(engine.conditionsHold({ ...base, conditions: [] }), true);
});

// ---------- журнал запусков ----------
function setupWithLog(scenarios, opts) {
  const s = setup(scenarios, opts);
  const log = [];
  s.engine.deps.recordRun = async (sc, run) => { log.push({ id: sc.id, ...run }); };
  return { ...s, log };
}

test('журнал: причина, шаги, ошибка шага', async () => {
  const { engine, log, calls } = setupWithLog([hot]);
  engine.deps.publishSet = async () => { throw new Error('mqtt not connected'); };
  await Promise.all(engine.onValue(T, 'temperature', '31.5'));
  assert.equal(log.length, 1);
  const [run] = log;
  assert.equal(run.status, 'error');
  assert.deepEqual(run.cause, { kind: 'property', device_id: T, device_name: 'Теплица', property: 'temperature', value: '31.5' });
  assert.deepEqual(run.steps, [{ type: 'set', ok: false, info: 'Вентилятор · relay = true', error: 'mqtt not connected' }]);
  assert.equal(run.error, 'set: mqtt not connected');
  assert.deepEqual(calls.runs, [['s1', 'set: mqtt not connected']], 'last_error по-прежнему сохраняется');

  log.length = 0;
  engine.deps.publishSet = async () => {};
  await Promise.all(engine.runManual('s1'));
  assert.equal(log[0].status, 'ok');
  assert.deepEqual(log[0].cause, { kind: 'manual' });
  assert.deepEqual(log[0].steps.map((x) => [x.type, x.ok]), [['set', true], ['delay', true], ['notify', true]]);
});

test('журнал: пропуск по условиям — не чаще раза в минуту, с логикой «любое»', async () => {
  const { engine, log, advance } = setupWithLog([hot]);
  await Promise.all(engine.onValue(R, 'mode', 'manual'));   // условие mode = auto не выполнено
  await Promise.all(engine.onValue(T, 'temperature', '31'));
  await Promise.all(engine.onValue(T, 'temperature', '20'));
  await Promise.all(engine.onValue(T, 'temperature', '31'));
  assert.deepEqual(log.map((r) => [r.status, r.error]), [['skipped', 'условия не выполнены']]);
  advance(61_000);
  await Promise.all(engine.onValue(T, 'temperature', '20'));
  await Promise.all(engine.onValue(T, 'temperature', '31'));
  assert.equal(log.length, 2);

  const any = setupWithLog([{ ...hot, id: 's2', condition_mode: 'any' }]);
  await Promise.all(any.engine.onValue(R, 'mode', 'manual'));
  await Promise.all(any.engine.onValue(T, 'temperature', '31'));
  assert.equal(any.log[0].error, 'ни одно из условий не выполнено');
});

test('журнал: пауза между запусками и «нет данных»', async () => {
  const { engine, log, advance } = setupWithLog([{ ...hot, conditions: [], cooldown_sec: 600 }]);
  await Promise.all(engine.onValue(T, 'temperature', '31'));
  await Promise.all(engine.onValue(T, 'temperature', '20'));
  await Promise.all(engine.onValue(T, 'temperature', '31'));
  assert.deepEqual(log.map((r) => r.status), ['ok', 'skipped']);
  assert.equal(log[1].error, 'пауза между запусками: 600 с');

  const stale = setupWithLog([{ id: 's3', name: 'Тишина', enabled: true, cooldown_sec: 0,
    trigger: { type: 'stale', device_id: T, minutes: 10 }, conditions: [], actions: [{ type: 'notify', level: 'alert', message: 'нет данных' }] }]);
  stale.engine.onValue(T, 'temperature', '25');
  stale.advance(11 * 60_000);
  await Promise.all(stale.engine.poll());
  assert.deepEqual(stale.log[0].cause, { kind: 'stale', device_id: T, device_name: 'Теплица', property: null, value: '10' });
  advance(0);
});
