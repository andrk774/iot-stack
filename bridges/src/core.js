// Ядро моста: регистрирует внешние устройства на платформе и гоняет значения/команды.
import { toWire, parseCommand } from './props.js';

const DEVICE_TOPIC_RE = /^dev\/(d[0-9a-f]{16})\/([a-z][a-z0-9_-]{0,31})\/set$/;

export class BridgeCore {
  /**
   * @param {{
   *   api: { registerDevice(key, name): Promise<{id}> },
   *   publish(topic, payload, opts): Promise<void>,     // наша шина
   *   subscribe(filter): Promise<void>,                 // наша шина
   *   publishExternal(topic, payload): Promise<void>,   // внешний брокер
   *   subscribeExternal(filter): Promise<void>,
   *   adapter, fw?: string, log?: object, metaDebounceMs?: number }} deps
   */
  constructor(deps) {
    this.d = { log: console, metaDebounceMs: 300, fw: 'bridge', ...deps };
    this.devices = new Map(); // key -> { key, id, name, props, state, pending: Map, metaTimer, ready: Promise }
    this.byId = new Map();
    this.externalSubs = new Set();
  }

  async start() {
    for (const f of this.d.adapter.subscriptions()) await this.subscribeExternal(f);
    for (const ev of this.d.adapter.initialEvents?.() || []) await this.apply(ev);
  }

  /** Повторно отправить всё после переподключения к нашей шине */
  async resync() {
    for (const dev of this.devices.values()) {
      if (!dev.id) continue;
      await this.d.subscribe(`dev/${dev.id}/+/set`).catch(() => {});
      await this.publishMeta(dev);
      if (dev.state) await this.d.publish(`dev/${dev.id}/$state`, dev.state, { retain: true, qos: 1 }).catch(() => {});
    }
  }

  async subscribeExternal(filter) {
    if (this.externalSubs.has(filter)) return;
    this.externalSubs.add(filter);
    await this.d.subscribeExternal(filter);
  }

  async onExternalMessage(topic, payload) {
    let events;
    try {
      events = this.d.adapter.handle(topic, payload);
    } catch (e) {
      this.d.log.warn?.(`adapter failed on ${topic}: ${e.message}`);
      return;
    }
    for (const ev of events) await this.apply(ev);
  }

  async apply(ev) {
    if (ev.kind === 'subscribe') return this.subscribeExternal(ev.topic);
    if (ev.kind === 'device') return this.upsertDevice(ev);
    const dev = this.devices.get(ev.key);
    if (!dev) return undefined;
    if (ev.kind === 'value') {
      const wire = toWire(ev.value);
      if (wire === null) return undefined;
      if (!dev.id) { dev.pending.set(ev.prop, wire); return undefined; }
      return this.d.publish(`dev/${dev.id}/${ev.prop}`, wire, { qos: 0 });
    }
    if (ev.kind === 'state') {
      dev.state = ev.state;
      if (dev.id) return this.d.publish(`dev/${dev.id}/$state`, ev.state, { retain: true, qos: 1 });
    }
    return undefined;
  }

  async upsertDevice({ key, name, props }) {
    let dev = this.devices.get(key);
    if (!dev) {
      dev = { key, id: null, name, props, state: null, pending: new Map(), metaTimer: null, ready: null };
      this.devices.set(key, dev);
    } else {
      dev.name = name ?? dev.name;
      dev.props = props;
    }
    if (!dev.ready) dev.ready = this.register(dev);
    await dev.ready;
    if (dev.id) this.scheduleMeta(dev);
  }

  async register(dev) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.d.api.registerDevice(dev.key, dev.name);
        dev.id = res.id;
        this.byId.set(dev.id, dev);
        await this.d.subscribe(`dev/${dev.id}/+/set`);
        await this.publishMeta(dev);
        await this.d.publish(`dev/${dev.id}/$state`, dev.state || 'ready', { retain: true, qos: 1 });
        for (const [prop, wire] of dev.pending) await this.d.publish(`dev/${dev.id}/${prop}`, wire, { qos: 0 });
        dev.pending.clear();
        this.d.log.log?.(`device ${dev.key} -> ${dev.id} (${dev.name})`);
        return;
      } catch (e) {
        if (e.permanent || attempt >= 5) {
          this.d.log.error?.(`register ${dev.key} failed: ${e.message}`);
          dev.ready = null; // повторим при следующем событии устройства
          return;
        }
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
      }
    }
  }

  scheduleMeta(dev) {
    clearTimeout(dev.metaTimer);
    dev.metaTimer = setTimeout(() => this.publishMeta(dev).catch(() => {}), this.d.metaDebounceMs);
  }

  publishMeta(dev) {
    const meta = { name: dev.name, fw: this.d.fw, props: dev.props };
    return this.d.publish(`dev/${dev.id}/$meta`, JSON.stringify(meta), { retain: true, qos: 1 });
  }

  /** Команда с нашей шины -> внешний брокер */
  async onCommand(topic, payload) {
    const m = DEVICE_TOPIC_RE.exec(topic);
    if (!m) return null;
    const dev = this.byId.get(m[1]);
    const spec = dev?.props?.[m[2]];
    if (!dev || !spec?.settable) return null;
    const value = parseCommand(payload.toString('utf8'), spec);
    if (value === undefined) {
      this.d.log.warn?.(`bad command ${topic}=${payload}`);
      return null;
    }
    const out = this.d.adapter.command(dev.key, m[2], value);
    if (!out) return null;
    await this.d.publishExternal(out.topic, out.payload);
    return out;
  }
}
