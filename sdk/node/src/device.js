import { EventEmitter } from 'node:events';
import { readFile, writeFile, rename } from 'node:fs/promises';
import {
  PROP_RE, DEVICE_ID_RE, STATES, TYPES, MAX_META_LEN, topic, parseSetTopic, parseValue, formatValue, buildMeta,
} from './protocol.js';

export class IotProperty {
  constructor(device, spec) {
    this.device = device;
    this.spec = spec;
    this.value = undefined;
    this.handler = null;
  }

  get name() { return this.spec.name; }

  /**
   * Сделать свойство управляемым. handler(value, property) -> true | false | Promise<boolean>.
   * true — принять (значение сохранится и уйдёт серверу), false — отклонить (уйдёт прежнее).
   */
  onSet(handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    this.handler = handler;
    this.spec.settable = true;
    return this;
  }

  /** Установить значение и отправить (если онлайн; иначе — после подключения) */
  set(value) {
    const wire = formatValue(value, this.spec);
    if (wire === null) return this;
    this.value = this.spec.type === 'string' ? wire : parseValue(wire, { ...this.spec, min: undefined, max: undefined });
    this.wire = wire;
    this.device.publishProperty(this);
    return this;
  }
}

export class IotDevice extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {string} [o.firmware]
   * @param {string} o.host               PUBLIC_HOST сервера
   * @param {number} [o.mqttPort=8883]
   * @param {string} [o.apiUrl]           по умолчанию https://<host>
   * @param {string} [o.claimToken]       для первой привязки или перепривязки
   * @param {string} [o.credentialsFile]  где хранить учётку (по умолчанию ./iot-credentials.json)
   * @param {string|Buffer} [o.ca]        корневой сертификат, если он не из системных (самоподписанный)
   * @param {Function} [o.mqttConnect]    (url, options) -> MqttClient; по умолчанию mqtt.connect
   * @param {Function} [o.fetch]
   * @param {object|false} [o.log]
   */
  constructor(o) {
    super();
    if (!o?.name) throw new TypeError('name is required');
    if (!o.host) throw new TypeError('host is required');
    this.o = { firmware: '1.0.0', mqttPort: 8883, credentialsFile: './iot-credentials.json', ...o };
    this.o.apiUrl = (o.apiUrl || `https://${o.host}`).replace(/\/$/, '');
    this.log = o.log === false ? {} : (o.log || console);
    this.props = new Map();
    this.client = null;
    this.creds = null;
    this.state = 'idle';
  }

  add(name, type, opts = {}) {
    if (!PROP_RE.test(name)) throw new Error(`property name '${name}': a-z, 0-9, _ -, до 32 символов, с буквы`);
    if (!TYPES.includes(type)) throw new Error(`type ${type}`);
    if (this.props.has(name)) throw new Error(`property '${name}' already exists`);
    const spec = { name, type, unit: opts.unit, min: opts.min, max: opts.max, decimals: opts.decimals ?? 2, settable: false };
    const p = new IotProperty(this, spec);
    this.props.set(name, p);
    return p;
  }

  addBool(name, opts) { return this.add(name, 'boolean', opts); }
  addInt(name, opts) { return this.add(name, 'integer', opts); }
  addFloat(name, opts) { return this.add(name, 'float', opts); }
  addString(name, opts) { return this.add(name, 'string', opts); }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  get online() { return this.state === 'online'; }
  get deviceId() { return this.creds?.device_id ?? null; }

  async loadCredentials() {
    try {
      const c = JSON.parse(await readFile(this.o.credentialsFile, 'utf8'));
      if (DEVICE_ID_RE.test(c.device_id) && c.password) return c;
    } catch { /* нет файла — привяжемся */ }
    return null;
  }

  async saveCredentials(c) {
    const tmp = `${this.o.credentialsFile}.tmp`;
    await writeFile(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    await rename(tmp, this.o.credentialsFile);
  }

  async provision() {
    const token = this.o.claimToken;
    if (!token) throw new Error('нет учётки и claimToken: создайте устройство (POST /api/devices) и передайте claim_token');
    const doFetch = this.o.fetch || globalThis.fetch;
    const res = await doFetch(`${this.o.apiUrl}/api/provision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim_token: token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`provision failed: HTTP ${res.status} ${data.error || ''}`.trim());
      err.status = res.status;
      throw err;
    }
    const creds = { device_id: data.device_id, password: data.mqtt.password, claim_token_used: token, host: this.o.host };
    await this.saveCredentials(creds);
    this.log.log?.(`[iot] привязано как ${creds.device_id}`);
    return creds;
  }

  async start() {
    let creds = await this.loadCredentials();
    if (this.o.claimToken && creds?.claim_token_used !== this.o.claimToken) {
      if (creds) this.log.log?.('[iot] новый claimToken — привязка заново');
      creds = null;
    }
    if (!creds) {
      this.setState('provisioning');
      creds = await this.provision();
    }
    this.creds = creds;

    const meta = this.meta();
    if (Buffer.byteLength(meta) > MAX_META_LEN) this.log.warn?.('[iot] $meta больше 8 КБ, сервер его отбросит');

    const connect = this.o.mqttConnect || (await import('mqtt')).default.connect;
    const id = creds.device_id;
    this.setState('connecting');
    this.client = connect(`mqtts://${this.o.host}:${this.o.mqttPort}`, {
      clientId: id,
      username: id,
      password: creds.password,
      keepalive: 60,
      reconnectPeriod: 5000,
      will: { topic: topic(id, '$state'), payload: 'lost', qos: 1, retain: true },
      ...(this.o.ca ? { ca: this.o.ca } : {}),
    });

    this.client.on('connect', () => this.onConnect().catch((e) => this.log.error?.(`[iot] ${e.message}`)));
    this.client.on('close', () => { if (this.state === 'online') this.setState('connecting'); });
    this.client.on('error', (e) => {
      this.log.error?.(`[iot] mqtt: ${e.message}`);
      this.emit('error', e);
    });
    this.client.on('message', (t, payload) => this.onMessage(t, payload).catch((e) => this.log.error?.(`[iot] ${e.message}`)));
    return this;
  }

  meta() {
    return buildMeta(this.o.name, this.o.firmware, [...this.props.values()].map((p) => p.spec));
  }

  async onConnect() {
    const id = this.deviceId;
    const c = this.client;
    await c.publishAsync(topic(id, '$state'), 'init', { qos: 1, retain: true });
    await c.publishAsync(topic(id, '$meta'), this.meta(), { qos: 1, retain: true });
    await c.subscribeAsync(topic(id, '+/set'), { qos: 1 });
    for (const p of this.props.values()) {
      if (p.wire !== undefined) await c.publishAsync(topic(id, p.name), p.wire, { qos: 0 });
    }
    await c.publishAsync(topic(id, '$state'), 'ready', { qos: 1, retain: true });
    this.setState('online');
    this.log.log?.(`[iot] онлайн: dev/${id}/…`);
  }

  publishProperty(p) {
    if (!this.client?.connected || !this.online || p.wire === undefined) return;
    this.client.publishAsync(topic(this.deviceId, p.name), p.wire, { qos: 0 }).catch(() => {});
  }

  async publishState(state) {
    if (!STATES.includes(state)) throw new Error(`state ${state}`);
    if (this.client?.connected) await this.client.publishAsync(topic(this.deviceId, '$state'), state, { qos: 1, retain: true });
  }

  async onMessage(t, payload) {
    const name = parseSetTopic(t, this.deviceId);
    if (!name) return;
    const p = this.props.get(name);
    if (!p?.handler) return;
    const value = parseValue(payload.toString('utf8'), p.spec);
    if (value === undefined) {
      this.log.warn?.(`[iot] ${name}: недопустимое значение '${payload}'`);
      this.publishProperty(p);
      return;
    }
    let ok = false;
    try {
      ok = await p.handler(value, p);
    } catch (e) {
      this.log.error?.(`[iot] обработчик ${name}: ${e.message}`);
    }
    if (ok) p.set(value);
    else this.publishProperty(p);
  }

  async stop() {
    if (!this.client) return;
    try {
      if (this.client.connected) await this.client.publishAsync(topic(this.deviceId, '$state'), 'disconnected', { qos: 1, retain: true });
    } finally {
      await this.client.endAsync();
      this.setState('idle');
    }
  }
}
