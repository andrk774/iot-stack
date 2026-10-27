// Линейный график на SVG: среднее + полоса min/max, подсказка по наведению.
import { svg, h } from './dom.js';
import { niceTicks, formatValue } from './format.js';

const H = 220;
const PAD = { l: 44, r: 12, t: 12, b: 26 };

const timeFmt = (span) => new Intl.DateTimeFormat('ru-RU',
  span > 2 * 24 * 3600e3 ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' });

export function lineChart(points, { type, unit, from, to, width = 720 }) {
  // ширина viewBox = реальной ширине, чтобы подписи не мельчали на телефоне
  const W = Math.max(300, Math.round(width));
  const wrap = h('div', { class: 'chart' });
  if (points.length === 0) {
    wrap.append(h('p', { class: 'chart-empty' }, 'Нет данных за этот период'));
    return wrap;
  }

  const t0 = from ?? points[0].t;
  const t1 = to ?? points[points.length - 1].t;
  const lo = Math.min(...points.map((p) => p.min ?? p.v));
  const hi = Math.max(...points.map((p) => p.max ?? p.v));
  const ticks = type === 'boolean' ? [0, 1] : niceTicks(lo, hi, 4);
  const yMin = Math.min(ticks[0], lo);
  const yMax = Math.max(ticks[ticks.length - 1], hi);

  const x = (t) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - yMin) / Math.max(1e-9, yMax - yMin)) * (H - PAD.t - PAD.b);

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img',
    'aria-label': `График, ${points.length} точек` });

  for (const v of ticks) {
    root.append(
      svg('line', { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), class: 'chart-grid' }),
      svg('text', { x: PAD.l - 6, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' },
        type === 'boolean' ? (v ? 'вкл' : 'выкл') : formatValue(v, 'float')),
    );
  }
  const tf = timeFmt(t1 - t0);
  for (const frac of [0, 0.5, 1]) {
    const t = t0 + (t1 - t0) * frac;
    root.append(svg('text', {
      x: x(t), y: H - 6, class: 'chart-axis', 'text-anchor': frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle',
    }, tf.format(new Date(t))));
  }

  const banded = points.some((p) => p.min !== null && p.max !== null && p.min !== p.max);
  if (banded) {
    const top = points.map((p) => `${x(p.t)},${y(p.max ?? p.v)}`);
    const bottom = points.slice().reverse().map((p) => `${x(p.t)},${y(p.min ?? p.v)}`);
    root.append(svg('polygon', { points: [...top, ...bottom].join(' '), class: 'chart-band' }));
  }

  const step = type === 'boolean';
  let d = '';
  points.forEach((p, i) => {
    if (i === 0) d += `M${x(p.t)},${y(p.v)}`;
    else if (step) d += `H${x(p.t)}V${y(p.v)}`;
    else d += `L${x(p.t)},${y(p.v)}`;
  });
  root.append(svg('path', { d, class: 'chart-line' }));

  // подсказка
  const cursor = svg('line', { y1: PAD.t, y2: H - PAD.b, class: 'chart-cursor', visibility: 'hidden' });
  const dot = svg('circle', { r: 4, class: 'chart-dot', visibility: 'hidden' });
  root.append(cursor, dot);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const full = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  root.addEventListener('pointermove', (ev) => {
    const rect = root.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    let best = points[0];
    for (const p of points) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    cursor.setAttribute('x1', x(best.t));
    cursor.setAttribute('x2', x(best.t));
    dot.setAttribute('cx', x(best.t));
    dot.setAttribute('cy', y(best.v));
    cursor.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    const range = best.min !== null && best.max !== null && best.min !== best.max
      ? ` (${formatValue(best.min, type)}…${formatValue(best.max, type)})` : '';
    tip.textContent = `${full.format(new Date(best.t))}: ${formatValue(type === 'boolean' ? best.v >= 0.5 : best.v, type)}${unit ? ` ${unit}` : ''}${range}`;
    tip.hidden = false;
    tip.style.left = `${(x(best.t) / W) * 100}%`;
  });
  root.addEventListener('pointerleave', () => {
    cursor.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });

  wrap.append(root, tip);
  return wrap;
}
