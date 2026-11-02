// Движок сценариев без ввода-вывода: всё внешнее передаётся через deps — тестируется целиком.
import { compare, comparable, isSettable, inTimeWindow } from '../../shared/scenario.js';
import { parseCron, cronMatches, localParts } from '../../shared/cron.js';

const MAX_RUNS_PER_MIN = 30;

export class Engine {
  /**
   * @param {{
   *   publishSet: (deviceId, property, value) => Promise<void>,
   *   notify: (scenario, level, message) => Promise<void>,
   *   saveRun: (scenario, error|null) => Promise<void>,
   *   sleep?: (ms) => Promise<void>, now?: () => number, log?: object, defaultTz?: string }} deps
   */
  constructor(deps) {
    this.deps = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), log: console, defaultTz: 'UTC', ...deps };
    this.scenarios = new Map();
    this.devices = new Map(); // id -> { name, state, values: {} }
    this.armed = new Map();     // scenario id -> может ли сработать порог (взведён)
    this.pending = new Map();   // scenario id -> с какого момента держится условие (для «дольше N секунд»)
    this.seen = new Map();      // 'dev' | 'dev/prop' -> время последнего сообщения, мс
    this.staleFired = new Set(); // сценарии «нет данных», уже сработавшие до появления новых данных
    this.loadedAt = null;
    this.running = new Set();
    this.runLog = new Map(); // scenario id -> [timestamps]
    this.lastRunAt = new Map();
  }

  /** Полная перезагрузка из БД. Значения устройств и края условий сохраняются. */
  load(scenarios, devices) {
    const now = this.deps.now();
    this.loadedAt ??= now;
    for (const d of devices) {
      // для «нет данных»: если сервис только запустился, отсчёт — от last_seen устройства
      if (!this.seen.has(d.id) && d.last_seen) this.seen.set(d.id, Date.parse(d.last_seen));
      const prev = this.devices.get(d.id);
      this.devices.set(d.id, {
        name: d.name,
        state: prev?.state ?? d.state,
        meta: prev?.meta ?? d.meta ?? null,
        values: { ...(d.last_values || {}), ...(prev?.values || {}) },
      });
    }
    const next = new Map();
    for (const s of scenarios) {
      const compiled = { ...s };
      if (s.trigger.type === 'schedule') {
        try {
          compiled.cron = parseCron(s.trigger.cron);
        } catch (e) {
          this.deps.log.warn?.(`scenario ${s.id}: bad cron ${s.trigger.cron}`);
          continue;
        }
      }
      if (s.last_run_at && !this.lastRunAt.has(s.id)) this.lastRunAt.set(s.id, Date.parse(s.last_run_at));
      next.set(s.id, compiled);
      // текущее состояние считаем исходным: уже превышенный порог при старте не срабатывает
      const prev = this.scenarios.get(s.id);
      const changed = !prev || JSON.stringify(prev.trigger) !== JSON.stringify(s.trigger);
      if (s.trigger.type === 'property' && s.trigger.op !== 'changed' && (changed || !this.armed.has(s.id))) {
        const v = this.devices.get(s.trigger.device_id)?.values[s.trigger.property];
        this.armed.set(s.id, !compare(s.trigger.op, v, s.trigger.value));
        this.pending.delete(s.id);
      }
      if (changed) this.staleFired.delete(s.id);
    }
    for (const id of [...this.armed.keys()]) if (!next.has(id)) this.armed.delete(id);
    for (const id of [...this.pending.keys()]) if (!next.has(id)) this.pending.delete(id);
    this.scenarios = next;
  }

  watchedDevices() {
    return new Set(this.devices.keys());
  }

  /** Порог снова взведён? С гистерезисом — только когда значение ушло от порога обратно на величину гистерезиса */
  rearmed(t, raw, match) {
    if (!t.hysteresis) return !match;
    const v = comparable(raw);
    if (typeof v !== 'number') return false;
    return t.op === 'gt' || t.op === 'gte' ? v < t.value - t.hysteresis : v > t.value + t.hysteresis;
  }

  markSeen(deviceId, property) {
    const now = this.deps.now();
    this.seen.set(deviceId, now);
    if (property) this.seen.set(`${deviceId}/${property}`, now);
    for (const s of this.scenarios.values()) {
      const t = s.trigger;
      if (t.type === 'stale' && t.device_id === deviceId && (!t.property || t.property === property)) this.staleFired.delete(s.id);
    }
  }

  onValue(deviceId, property, raw) {
    const d = this.devices.get(deviceId);
    if (!d) return [];
    this.markSeen(deviceId, property);
    const prev = d.values[property];
    d.values[property] = raw;
    const fired = [];
    for (const s of this.scenarios.values()) {
      const t = s.trigger;
      if (t.type !== 'property' || t.device_id !== deviceId || t.property !== property) continue;
      if (t.op === 'changed') {
        if (prev !== undefined && String(prev) !== String(raw)) fired.push(this.fire(s, { value: raw, deviceId, property }));
        continue;
      }
      const match = compare(t.op, raw, t.value);
      const armed = this.armed.get(s.id) ?? false;
      if (!match) this.pending.delete(s.id);
      if (match && armed) {
        if (t.for_sec) {
          if (!this.pending.has(s.id)) this.pending.set(s.id, this.deps.now());
        } else {
          this.armed.set(s.id, false);
          fired.push(this.fire(s, { value: raw, deviceId, property }));
        }
      } else if (!armed && this.rearmed(t, raw, match)) {
        this.armed.set(s.id, true);
      }
    }
    return fired;
  }

  /**
   * Раз в несколько секунд: «держится дольше N секунд» и «нет данных N минут».
   */
  poll(now = this.deps.now()) {
    const fired = [];
    for (const [id, since] of [...this.pending]) {
      const s = this.scenarios.get(id);
      if (!s) { this.pending.delete(id); continue; }
      const t = s.trigger;
      if (now - since < t.for_sec * 1000) continue;
      const v = this.devices.get(t.device_id)?.values[t.property];
      this.pending.delete(id);
      if (!compare(t.op, v, t.value)) continue;
      this.armed.set(id, false);
      fired.push(this.fire(s, { value: v, deviceId: t.device_id, property: t.property }));
    }
    for (const s of this.scenarios.values()) {
      const t = s.trigger;
      if (t.type !== 'stale' || this.staleFired.has(s.id)) continue;
      const last = this.seen.get(t.property ? `${t.device_id}/${t.property}` : t.device_id) ?? this.seen.get(t.device_id) ?? this.loadedAt;
      if (last === null || now - last < t.minutes * 60_000) continue;
      this.staleFired.add(s.id);
      fired.push(this.fire(s, { value: t.minutes, deviceId: t.device_id, property: t.property || '' }));
    }
    return fired.filter(Boolean);
  }

  onState(deviceId, state) {
    const d = this.devices.get(deviceId);
    if (!d) return [];
    const prev = d.state;
    d.state = state;
    if (state !== 'lost' && state !== 'disconnected') this.markSeen(deviceId, null);
    if (prev === state) return [];
    const fired = [];
    for (const s of this.scenarios.values()) {
      if (s.trigger.type === 'state' && s.trigger.device_id === deviceId && s.trigger.state === state) {
        fired.push(this.fire(s, { value: state, deviceId, property: '$state' }));
      }
    }
    return fired;
  }

  /** Устройство заново описало свои свойства */
  onMeta(deviceId, meta) {
    const d = this.devices.get(deviceId);
    if (d && meta && typeof meta === 'object') d.meta = meta;
  }

  /** Раз в минуту: расписания */
  tick(date) {
    const fired = [];
    for (const s of this.scenarios.values()) {
      if (s.trigger.type !== 'schedule') continue;
      const parts = localParts(date, s.trigger.tz || this.deps.defaultTz);
      if (cronMatches(s.cron, parts)) fired.push(this.fire(s, { value: date.toISOString() }));
    }
    return fired;
  }

  runManual(id) {
    const s = this.scenarios.get(id);
    return s ? [this.fire(s, { manual: true })] : [];
  }

  conditionHolds(c) {
    const type = c.type ?? 'property';
    if (type === 'property') return compare(c.op, this.devices.get(c.device_id)?.values[c.property], c.value);
    if (type === 'state') {
      const is = this.devices.get(c.device_id)?.state === c.state;
      return c.negate ? !is : is;
    }
    if (type === 'time') return inTimeWindow(c, localParts(new Date(this.deps.now()), c.tz || this.deps.defaultTz));
    return false;
  }

  conditionsHold(s) {
    const list = s.conditions || [];
    if (!list.length) return true;
    return s.condition_mode === 'any' ? list.some((c) => this.conditionHolds(c)) : list.every((c) => this.conditionHolds(c));
  }

  /** Возвращает промис выполнения или null, если запуск пропущен */
  fire(s, ctx) {
    const now = this.deps.now();
    if (!s.enabled) return null;
    if (this.running.has(s.id)) return null;                  // предыдущий запуск ещё идёт (пауза)
    const last = this.lastRunAt.get(s.id);
    if (!ctx.manual && s.cooldown_sec > 0 && last && now - last < s.cooldown_sec * 1000) return null;
    const recent = (this.runLog.get(s.id) || []).filter((t) => now - t < 60_000);
    if (recent.length >= MAX_RUNS_PER_MIN) {
      this.deps.log.warn?.(`scenario ${s.id}: rate limited`);
      this.runLog.set(s.id, recent);
      return this.deps.saveRun(s, 'Слишком частые запуски: больше 30 в минуту, проверьте условия').catch(() => {});
    }
    if (!ctx.manual && !this.conditionsHold(s)) return null;

    recent.push(now);
    this.runLog.set(s.id, recent);
    this.lastRunAt.set(s.id, now);
    this.running.add(s.id);
    return this.execute(s, ctx).finally(() => this.running.delete(s.id));
  }

  render(template, s, ctx) {
    const dev = ctx.deviceId ? this.devices.get(ctx.deviceId) : null;
    return template
      .replaceAll('{value}', ctx.value === undefined ? '' : String(ctx.value))
      .replaceAll('{device}', dev?.name ?? '')
      .replaceAll('{property}', ctx.property ?? '')
      .replaceAll('{scenario}', s.name);
  }

  async execute(s, ctx) {
    let error = null;
    for (const a of s.actions) {
      try {
        if (a.type === 'set') {
          // $meta мог измениться после сохранения сценария — правило то же, что у /commands
          if (!isSettable(this.devices.get(a.device_id)?.meta, a.property)) throw new Error(`свойство ${a.property} не управляемое`);
          await this.deps.publishSet(a.device_id, a.property, a.value);
        }
        else if (a.type === 'notify') await this.deps.notify(s, a.level, this.render(a.message, s, ctx));
        else if (a.type === 'delay') await this.deps.sleep(a.seconds * 1000);
      } catch (e) {
        error = `${a.type}: ${e.message}`;
        this.deps.log.error?.(`scenario ${s.id} action ${a.type} failed: ${e.message}`);
        break;
      }
    }
    await this.deps.saveRun(s, error).catch((e) => this.deps.log.error?.(`saveRun: ${e.message}`));
    return error;
  }
}
