import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../metrics.js';

test('metrics: формат Prometheus', () => {
  const m = new Metrics();
  const c = m.counter('x_total', 'Счётчик');
  c.inc({ code: '2xx' });
  c.inc({ code: '2xx' }, 2);
  c.inc({ code: '5xx' });
  m.gauge('g', 'Шкала').set({ name: 'a"b\\c\nd' }, 1.5);
  m.gaugeFn('fn', 'Вычисляемая', () => [{ labels: { k: 'v' }, value: 7 }]);
  m.counterFn('cf_total', 'Считает код', () => 42);
  m.gauge('nan', 'NaN').set({}, NaN);
  assert.equal(m.render(), [
    '# HELP x_total Счётчик', '# TYPE x_total counter', 'x_total{code="2xx"} 3', 'x_total{code="5xx"} 1',
    '# HELP g Шкала', '# TYPE g gauge', 'g{name="a\\"b\\\\c\\nd"} 1.5',
    '# HELP fn Вычисляемая', '# TYPE fn gauge', 'fn{k="v"} 7',
    '# HELP cf_total Считает код', '# TYPE cf_total counter', 'cf_total 42',
    '# HELP nan NaN', '# TYPE nan gauge', 'nan NaN', '',
  ].join('\n'));
});
