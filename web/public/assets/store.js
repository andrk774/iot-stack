// Состояние панели: устройства из REST + живые обновления по MQTT/WSS.
import { get, getToken } from './api.js';
import { MqttClient } from './mqtt-client.js';
import { coerce } from './format.js';

class Store {
  constructor() {
    this.me = null;
    this.devices = new Map();
    this.handlers = new Set();
    this.mqtt = null;
    this.liveStatus = 'offline';
    this.flash = new Map(); // `${id}/${prop}` -> время последнего живого обновления
  }

  /** fn(event, payload): 'devices' | 'device' {id, prop?} | 'live' status */
  subscribe(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.handlers) {
      try { fn(event, payload); } catch (e) { console.error(e); }
    }
  }

  async init() {
    this.me = await get('/api/me');
    await this.loadDevices();
    this.startLive();
  }

  async loadDevices() {
    const { devices } = await get('/api/devices');
    this.devices = new Map(devices.map((d) => [d.id, d]));
    if (this.mqtt) for (const id of this.devices.keys()) this.mqtt.subscribe(`dev/${id}/#`).catch(() => {});
    this.emit('devices');
  }

  upsert(device) {
    this.devices.set(device.id, { ...this.devices.get(device.id), ...device });
    this.mqtt?.subscribe(`dev/${device.id}/#`).catch(() => {});
    this.emit('devices');
  }

  remove(id) {
    this.devices.delete(id);
    this.mqtt?.unsubscribe(`dev/${id}/#`).catch(() => {});
    this.emit('devices');
  }

  startLive() {
    if (this.mqtt || !this.me) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const rand = Math.random().toString(16).slice(2, 10);
    this.mqtt = new MqttClient(`${proto}://${location.host}/mqtt`, {
      clientId: `web-${this.me.id}-${rand}`, // сервер проверяет, что id пользователя совпадает с логином
      username: `u:${this.me.id}`,
      password: () => getToken() || '',
    });
    this.mqtt.on('status', (s) => { this.liveStatus = s; this.emit('live', s); });
    this.mqtt.on('message', (topic, payload) => this.onMessage(topic, payload));
    for (const id of this.devices.keys()) this.mqtt.subscribe(`dev/${id}/#`).catch(() => {});
    this.mqtt.start();
  }

  stop() {
    this.mqtt?.stop();
    this.mqtt = null;
    this.devices.clear();
    this.handlers.clear();
    this.me = null;
  }

  onMessage(topic, payload) {
    const parts = topic.split('/');
    if (parts.length !== 3 || parts[0] !== 'dev') return;
    const [, id, leaf] = parts;
    const d = this.devices.get(id);
    if (!d) return;
    const now = new Date().toISOString();

    if (leaf === '$state') {
      d.state = payload.trim();
      d.last_seen = now;
      this.emit('device', { id });
    } else if (leaf === '$meta') {
      try {
        const meta = JSON.parse(payload);
        if (meta && typeof meta === 'object') { d.meta = meta; this.emit('device', { id, meta: true }); }
      } catch { /* мусор игнорируем */ }
    } else {
      const type = d.meta?.props?.[leaf]?.type ?? null;
      d.last_values = { ...(d.last_values || {}), [leaf]: coerce(payload, type) };
      d.last_seen = now;
      this.flash.set(`${id}/${leaf}`, Date.now());
      this.emit('device', { id, prop: leaf });
    }
  }
}

export const store = new Store();
