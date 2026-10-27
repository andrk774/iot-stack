import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coerce, formatValue, deviceProps, relativeTime, errorMessage, seriesFromTelemetry, niceTicks, stateTone,
} from '../public/assets/format.js';

test('coerce by type', () => {
  assert.equal(coerce(1, 'boolean'), true);        // last_values хранит bool как 1/0
  assert.equal(coerce('false', 'boolean'), false);
  assert.equal(coerce('x', 'boolean'), null);
  assert.equal(coerce('21.5', 'float'), 21.5);
  assert.equal(coerce('abc', 'float'), null);
  assert.equal(coerce(5, 'string'), '5');
  assert.equal(coerce('3', null), 3);
  assert.equal(coerce('on', null), 'on');
  assert.equal(coerce(undefined, 'float'), null);
});

test('formatValue', () => {
  assert.equal(formatValue(true, 'boolean'), 'вкл');
  assert.equal(formatValue(null, 'float'), '—');
  assert.equal(formatValue(21.456, 'float').replace(/\s/g, ' '), '21,46');
  assert.equal(formatValue(1500, 'integer').replace(/\s/g, ' '), '1 500');
  assert.equal(formatValue('heat', 'string'), 'heat');
});

test('deviceProps from meta or last_values', () => {
  const withMeta = deviceProps({ meta: { props: { relay: { type: 'boolean', settable: true }, t: { type: 'float', unit: '°C', min: 0, max: 50 } } } });
  assert.deepEqual(withMeta.map((p) => p.name), ['relay', 't']);
  assert.equal(withMeta[0].settable, true);
  assert.equal(withMeta[1].unit, '°C');
  assert.equal(withMeta[1].max, 50);
  const noMeta = deviceProps({ last_values: { a: 1, b: 'x' } });
  assert.deepEqual(noMeta.map((p) => [p.name, p.settable]), [['a', false], ['b', false]]);
  assert.deepEqual(deviceProps({ meta: { props: { x: { type: 'evil' } } } })[0].type, 'string');
});

test('relativeTime', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  assert.equal(relativeTime(null, now), 'никогда');
  assert.equal(relativeTime('2026-10-23T11:59:55Z', now), 'только что');
  assert.equal(relativeTime('2026-10-23T11:58:00Z', now), '2 мин назад');
  assert.equal(relativeTime('2026-10-23T09:00:00Z', now), '3 ч назад');
  assert.equal(relativeTime('2026-10-20T12:00:00Z', now), '3 дн назад');
});

test('errors, telemetry, ticks, tones', () => {
  assert.equal(errorMessage({ code: 'invalid_credentials' }), 'Неверный email или пароль');
  assert.match(errorMessage({ code: 'validation', details: { field: 'name' } }), /name/);
  assert.match(errorMessage({ code: 'weird' }), /weird/);

  const s = seriesFromTelemetry({ points: [
    { t: '2026-10-23T10:00:00Z', avg: 1, min: 0, max: 2 },
    { t: '2026-10-23T11:00:00Z', v: '3', s: null },
    { t: 'bad', v: 1 },
    { t: '2026-10-23T12:00:00Z', v: null, s: 'text' },
  ] });
  assert.equal(s.length, 2);
  assert.equal(s[1].v, 3);
  assert.equal(s[0].max, 2);

  assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(niceTicks(21.2, 23.9, 3), [21, 22, 23, 24]);
  assert.deepEqual(niceTicks(5, 5).length > 0, true);
  assert.equal(stateTone('ready'), 'ok');
  assert.equal(stateTone('lost'), 'bad');
});
