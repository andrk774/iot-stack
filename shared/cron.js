// 5-польный cron: минута час день-месяца месяц день-недели.
// Поддерживаются *, числа, диапазоны a-b, списки a,b, шаги */n и a-b/n, @hourly @daily @weekly @monthly.
// День недели: 0 и 7 — воскресенье. Если ограничены и день месяца, и день недели — срабатывает любое (как в cron).

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7 },
];

const ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

export class CronError extends Error {}

function parseField(src, { name, min, max }) {
  const out = new Set();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`${name}: '${part}'`);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b === undefined ? (m[2] ? max : a) : b;
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new CronError(`${name}: '${part}' вне ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr) {
  if (typeof expr !== 'string') throw new CronError('пустое выражение');
  const src = ALIASES[expr.trim()] ?? expr.trim();
  const parts = src.split(/\s+/);
  if (parts.length !== 5) throw new CronError('нужно 5 полей: минута час день месяц день_недели');
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]));
  const weekday = sets[4];
  if (weekday.has(7)) { weekday.delete(7); weekday.add(0); }
  return {
    minute: sets[0], hour: sets[1], day: sets[2], month: sets[3], weekday,
    dayStar: parts[2] === '*', weekdayStar: parts[4] === '*',
  };
}

export function cronMatches(c, t) {
  if (!c.minute.has(t.minute) || !c.hour.has(t.hour) || !c.month.has(t.month)) return false;
  const dayOk = c.day.has(t.day);
  const wdOk = c.weekday.has(t.weekday);
  if (c.dayStar && c.weekdayStar) return true;
  if (c.dayStar) return wdOk;
  if (c.weekdayStar) return dayOk;
  return dayOk || wdOk;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map();

/** Время в указанном часовом поясе: {minute, hour, day, month, weekday} */
export function localParts(date, timeZone = 'UTC') {
  let fmt = fmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short',
    });
    fmtCache.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), weekday: WEEKDAYS[p.weekday],
  };
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
