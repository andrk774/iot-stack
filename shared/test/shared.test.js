import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, cronMatches, localParts, CronError } from '../cron.js';
import { validateScenario, compare, comparable, referencedDevices, ScenarioError } from '../scenario.js';

const at = (iso, tz = 'UTC') => localParts(new Date(iso), tz);

test('cron parsing and matching', () => {
  const c = parseCron('*/15 7-9 * * 1-5');
  assert.equal(cronMatches(c, at('2026-10-23T07:30:00Z')), true);   // пятница
  assert.equal(cronMatches(c, at('2026-10-23T07:31:00Z')), false);
  assert.equal(cronMatches(c, at('2026-10-24T07:30:00Z')), false);  // суббота
  assert.equal(cronMatches(parseCron('0 0 * * 7'), at('2026-10-25T00:00:00Z')), true); // 7 = воскресенье
  assert.equal(cronMatches(parseCron('@daily'), at('2026-10-25T00:00:00Z')), true);
  // день месяца ИЛИ день недели
  const either = parseCron('0 12 1 * 1');
  assert.equal(cronMatches(either, at('2026-10-01T12:00:00Z')), true); // четверг, 1-е
  assert.equal(cronMatches(either, at('2026-10-26T12:00:00Z')), true); // понедельник
  assert.equal(cronMatches(either, at('2026-10-27T12:00:00Z')), false);
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', 'a * * * *', '5-1 * * * *']) {
    assert.throws(() => parseCron(bad), CronError, bad);
  }
});

test('time zones', () => {
  // 02:00 UTC = 07:00 в Екатеринбурге (UTC+5)
  const p = at('2026-10-23T02:00:00Z', 'Asia/Yekaterinburg');
  assert.equal(p.hour, 7);
  assert.equal(p.minute, 0);
  assert.equal(cronMatches(parseCron('0 7 * * *'), p), true);
});

test('compare', () => {
  assert.equal(compare('gt', '30.5', 30), true);
  assert.equal(compare('gt', 'abc', 30), false);
  assert.equal(compare('eq', 'true', true), true);
  assert.equal(compare('eq', 1, true), true);
  assert.equal(compare('eq', 'heat', 'heat'), true);
  assert.equal(compare('ne', 'heat', 'off'), true);
  assert.equal(compare('lte', undefined, 1), false);
  assert.equal(comparable(' 12 '), 12);
});

const D1 = 'd0123456789abcdef';
const D2 = 'dfedcba9876543210';
const base = {
  name: 'Жарко',
  trigger: { type: 'property', device_id: D1, property: 'temperature', op: 'gt', value: 30 },
  conditions: [{ device_id: D2, property: 'mode', op: 'eq', value: 'auto' }],
  actions: [{ type: 'set', device_id: D2, property: 'relay', value: true }, { type: 'delay', seconds: 60 },
    { type: 'notify', message: 'Включил вентилятор: {value}' }],
};

test('validateScenario: normalizes valid input', () => {
  const s = validateScenario(base);
  assert.equal(s.enabled, true);
  assert.equal(s.cooldown_sec, 0);
  assert.equal(s.actions[2].level, 'info');
  assert.deepEqual(referencedDevices(s), [D1, D2]);
  assert.deepEqual(validateScenario({ name: 'x', trigger: { type: 'schedule', cron: '0 7 * * *', tz: 'Asia/Yekaterinburg' },
    actions: [{ type: 'notify', message: 'утро' }] }).trigger, { type: 'schedule', cron: '0 7 * * *', tz: 'Asia/Yekaterinburg' });
  assert.equal(validateScenario({ ...base, trigger: { type: 'property', device_id: D1, property: 't', op: 'changed' } }).trigger.value, undefined);
});

test('validateScenario: rejects bad input', () => {
  const bad = [
    [{ ...base, name: '' }, 'name'],
    [{ ...base, trigger: { type: 'schedule', cron: '61 * * * *' } }, 'trigger.cron'],
    [{ ...base, trigger: { type: 'schedule', cron: '0 * * * *', tz: 'Mars/Base' } }, 'trigger.tz'],
    [{ ...base, trigger: { type: 'property', device_id: 'x', property: 't', op: 'gt', value: 1 } }, 'trigger.device_id'],
    [{ ...base, trigger: { ...base.trigger, op: 'like' } }, 'trigger.op'],
    [{ ...base, conditions: [{ device_id: D1, property: 'a', op: 'changed' }] }, 'conditions[0].op'],
    [{ ...base, actions: [] }, 'actions'],
    [{ ...base, actions: [{ type: 'delay', seconds: 5 }] }, 'actions'],
    [{ ...base, actions: [{ type: 'delay', seconds: 99999 }, base.actions[0]] }, 'actions[0].seconds'],
    [{ ...base, actions: [{ type: 'exec', cmd: 'rm' }] }, 'actions[0].type'],
    [{ ...base, actions: [{ type: 'set', device_id: D1, property: 'relay', value: { x: 1 } }] }, 'actions[0].value'],
    [{ ...base, cooldown_sec: -1 }, 'cooldown_sec'],
  ];
  for (const [input, field] of bad) {
    assert.throws(() => validateScenario(input), (e) => e instanceof ScenarioError && e.field === field, field);
  }
});

test('scenario: hysteresis, for_sec, stale, condition types and mode', async () => {
  const { validateScenario, ScenarioError, inTimeWindow } = await import('../scenario.js');
  const D = 'd0123456789abcdef';
  const base = { name: 'x', actions: [{ type: 'notify', message: 'm' }] };
  const ok = (o) => validateScenario({ ...base, ...o });
  const bad = (o, field) => assert.throws(() => ok(o), (e) => e instanceof ScenarioError && e.field === field);
  const prop = { type: 'property', device_id: D, property: 't', op: 'gt', value: 30 };
  assert.equal(ok({ trigger: { ...prop, hysteresis: 1.5, for_sec: 300 } }).trigger.for_sec, 300);
  bad({ trigger: { ...prop, op: 'eq', hysteresis: 1 } }, 'trigger.hysteresis');
  bad({ trigger: { ...prop, hysteresis: -1 } }, 'trigger.hysteresis');
  bad({ trigger: { ...prop, op: 'changed', value: undefined, for_sec: 5 } }, 'trigger.for_sec');
  bad({ trigger: { ...prop, for_sec: 1.5 } }, 'trigger.for_sec');
  assert.deepEqual(ok({ trigger: { type: 'stale', device_id: D, minutes: 30 } }).trigger, { type: 'stale', device_id: D, minutes: 30 });
  bad({ trigger: { type: 'stale', device_id: D, minutes: 0 } }, 'trigger.minutes');
  const m = { type: 'manual' };
  const s = ok({ trigger: m, condition_mode: 'any', conditions: [{ device_id: D, property: 'a', op: 'eq', value: 1 }, { type: 'state', device_id: D, state: 'lost', negate: true }, { type: 'time', from: '22:00', to: '07:00', days: [5, 6, 0] }] });
  assert.equal(s.condition_mode, 'any');
  assert.equal(s.conditions[0].type, 'property'); // старые условия без type — сравнение
  assert.deepEqual(s.conditions[2].days, [0, 5, 6]);
  bad({ trigger: m, condition_mode: 'some' }, 'condition_mode');
  bad({ trigger: m, conditions: [{ type: 'time', from: '24:00', to: '07:00' }] }, 'conditions[0].from');
  bad({ trigger: m, conditions: [{ type: 'time', from: '22:00', to: '07:00', days: [7] }] }, 'conditions[0].days');
  bad({ trigger: m, conditions: [{ type: 'state', device_id: D, state: 'weird' }] }, 'conditions[0].state');
  bad({ trigger: m, conditions: [{ type: 'moon' }] }, 'conditions[0].type');
  // окно через полночь: день — тот, когда окно началось
  const w = { from: '22:00', to: '07:00', days: [5] }; // ночь с пятницы на субботу
  assert.equal(inTimeWindow(w, { hour: 23, minute: 0, weekday: 5 }), true);
  assert.equal(inTimeWindow(w, { hour: 3, minute: 0, weekday: 6 }), true);
  assert.equal(inTimeWindow(w, { hour: 3, minute: 0, weekday: 5 }), false);
  assert.equal(inTimeWindow(w, { hour: 12, minute: 0, weekday: 5 }), false);
  assert.equal(inTimeWindow({ from: '08:00', to: '20:00' }, { hour: 20, minute: 0, weekday: 1 }), false);
  assert.equal(inTimeWindow({ from: '00:00', to: '00:00' }, { hour: 13, minute: 7, weekday: 1 }), true);
});
