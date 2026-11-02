// Линейный график на SVG: среднее + полоса min/max, подсказка по наведению.
import { svg, h } from './dom.js';
import { niceTicks, formatValue } from './format.js';

const H = 220;
const PAD = { l: 44, r: 12, t: 12, b: 26 };

const timeFmt = (span) => new Intl.DateTimeFormat('ru-RU',
  span > 2 * 24 * 3600e3 ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' });

// Цвета серий — классы .chart-s0…s3 в styles.css (атрибут style в SVG запрещён CSP)
const NSERIES = 4;

export function lineChart(points, opts) {
  return seriesChart([{ points, type: opts.type, unit: opts.unit }], opts);
}

/**
 * Несколько серий на одном графике: [{ label, points: [{t, v, min, max}], type, unit }].
 * Полоса min/max рисуется только для одной серии; подсказка показывает все серии в ближайшей точке.
 */
export function seriesChart(series, { from, to, width = 720 }) {
  const W = Math.max(300, Math.round(width));
  const wrap = h('div', { class: 'chart' });
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) {
    wrap.append(h('p', { class: 'chart-empty' }, 'Нет данных за этот период'));
    return wrap;
  }
  const single = series.length === 1;
  const onlyBool = series.every((s) => s.type === 'boolean');
  const t0 = from ?? Math.min(...all.map((p) => p.t));
  const t1 = to ?? Math.max(...all.map((p) => p.t));
  const lo = Math.min(...all.map((p) => (single ? p.min ?? p.v : p.v)));
  const hi = Math.max(...all.map((p) => (single ? p.max ?? p.v : p.v)));
  const ticks = onlyBool ? [0, 1] : niceTicks(lo, hi, 4);
  const yMin = Math.min(ticks[0], lo);
  const yMax = Math.max(ticks[ticks.length - 1], hi);

  const x = (t) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - yMin) / Math.max(1e-9, yMax - yMin)) * (H - PAD.t - PAD.b);

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img',
    'aria-label': `График, серий: ${series.length}, точек: ${all.length}` });

  for (const v of ticks) {
    root.append(
      svg('line', { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), class: 'chart-grid' }),
      svg('text', { x: PAD.l - 6, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' },
        onlyBool ? (v ? 'вкл' : 'выкл') : formatValue(v, 'float')),
    );
  }
  const tf = timeFmt(t1 - t0);
  for (const frac of [0, 0.5, 1]) {
    const t = t0 + (t1 - t0) * frac;
    root.append(svg('text', {
      x: x(t), y: H - 6, class: 'chart-axis', 'text-anchor': frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle',
    }, tf.format(new Date(t))));
  }

  series.forEach((s, i) => {
    const pts = s.points;
    if (!pts.length) return;
    if (single && pts.some((p) => p.min !== null && p.max !== null && p.min !== p.max)) {
      const top = pts.map((p) => `${x(p.t)},${y(p.max ?? p.v)}`);
      const bottom = pts.slice().reverse().map((p) => `${x(p.t)},${y(p.min ?? p.v)}`);
      root.append(svg('polygon', { points: [...top, ...bottom].join(' '), class: 'chart-band' }));
    }
    let d = '';
    pts.forEach((p, k) => {
      if (k === 0) d += `M${x(p.t)},${y(p.v)}`;
      else if (s.type === 'boolean') d += `H${x(p.t)}V${y(p.v)}`;
      else d += `L${x(p.t)},${y(p.v)}`;
    });
    root.append(svg('path', { d, class: `chart-line chart-s${i % NSERIES}` }));
  });

  // подсказка
  const cursor = svg('line', { y1: PAD.t, y2: H - PAD.b, class: 'chart-cursor', visibility: 'hidden' });
  const dots = series.map((_, i) => svg('circle', { r: 4, class: `chart-dot chart-s${i % NSERIES}`, visibility: 'hidden' }));
  root.append(cursor, ...dots);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const full = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const nearest = (pts, px) => {
    let best = null;
    for (const p of pts) if (!best || Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    return best;
  };

  root.addEventListener('pointermove', (ev) => {
    const rect = root.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const ref = nearest(all, px);
    cursor.setAttribute('x1', x(ref.t));
    cursor.setAttribute('x2', x(ref.t));
    cursor.setAttribute('visibility', 'visible');
    const parts = [full.format(new Date(ref.t))];
    series.forEach((s, i) => {
      const p = nearest(s.points, x(ref.t));
      if (!p) { dots[i].setAttribute('visibility', 'hidden'); return; }
      dots[i].setAttribute('cx', x(p.t));
      dots[i].setAttribute('cy', y(p.v));
      dots[i].setAttribute('visibility', 'visible');
      const range = single && p.min !== null && p.max !== null && p.min !== p.max
        ? ` (${formatValue(p.min, s.type)}…${formatValue(p.max, s.type)})` : '';
      parts.push(`${s.label ? `${s.label}: ` : ''}${formatValue(s.type === 'boolean' ? p.v >= 0.5 : p.v, s.type)}${s.unit ? ` ${s.unit}` : ''}${range}`);
    });
    tip.textContent = parts.join(single ? ': ' : ' · ');
    tip.hidden = false;
    tip.style.left = `${(x(ref.t) / W) * 100}%`;
  });
  root.addEventListener('pointerleave', () => {
    cursor.setAttribute('visibility', 'hidden');
    for (const d of dots) d.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });

  if (!single) {
    wrap.append(h('div', { class: 'chart-legend' }, ...series.map((s, i) => h('span', { class: 'chart-key' },
      h('span', { class: `chart-swatch chart-s${i % NSERIES}` }),
      `${s.label}${s.unit ? `, ${s.unit}` : ''}`))));
  }
  wrap.append(root, tip);
  return wrap;
}
