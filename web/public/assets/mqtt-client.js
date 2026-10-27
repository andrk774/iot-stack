// MQTT-over-WebSocket клиент панели: подключение, подписки, переподключение.
import {
  PacketReader, PacketType, encodeConnect, encodeSubscribe, encodeUnsubscribe,
  encodePuback, encodePingreq, encodeDisconnect, decodeUtf8,
} from './mqtt-codec.js';

const CONNACK_ERRORS = {
  1: 'unacceptable protocol', 2: 'client id rejected', 3: 'server unavailable',
  4: 'bad credentials', 5: 'not authorized',
};

export class MqttClient {
  /**
   * @param {string} url wss://host/mqtt
   * @param {{clientId: string, username: string, password: () => string, keepalive?: number,
   *          WebSocketImpl?: typeof WebSocket}} opts
   */
  constructor(url, opts) {
    this.url = url;
    this.opts = { keepalive: 30, ...opts };
    this.WS = opts.WebSocketImpl || globalThis.WebSocket;
    this.handlers = { connect: [], message: [], status: [] };
    this.subs = new Set();
    this.pending = new Map(); // packetId -> {resolve, reject, filters}
    this.nextId = 1;
    this.backoff = 1000;
    this.stopped = true;
    this.status = 'offline';
  }

  on(event, fn) {
    this.handlers[event].push(fn);
    return () => { this.handlers[event] = this.handlers[event].filter((f) => f !== fn); };
  }

  emit(event, ...args) {
    for (const fn of this.handlers[event]) {
      try { fn(...args); } catch (e) { console.error(e); }
    }
  }

  setStatus(s, detail) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s, detail);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.ws && this.ws.readyState === 1) this.send(encodeDisconnect());
    this.ws?.close();
    this.cleanup();
    this.setStatus('offline');
  }

  open() {
    this.setStatus('connecting');
    const ws = new this.WS(this.url, ['mqtt']);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.reader = new PacketReader();
    this.connected = false;

    ws.onopen = () => {
      const { clientId, username, password, keepalive } = this.opts;
      this.send(encodeConnect({ clientId, username, password: password(), keepalive }));
    };
    ws.onmessage = (ev) => {
      let packets;
      try {
        packets = this.reader.push(new Uint8Array(ev.data));
      } catch (e) {
        ws.close();
        return;
      }
      for (const p of packets) this.handle(p);
    };
    ws.onclose = () => {
      this.cleanup();
      if (this.stopped) return;
      this.setStatus('offline');
      const delay = this.backoff + Math.random() * 500;
      this.backoff = Math.min(this.backoff * 2, 30000);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => {};
  }

  cleanup() {
    clearInterval(this.pingTimer);
    this.connected = false;
    for (const { reject } of this.pending.values()) reject(new Error('disconnected'));
    this.pending.clear();
  }

  send(bytes) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
  }

  handle(p) {
    switch (p.type) {
      case PacketType.CONNACK:
        if (p.returnCode !== 0) {
          this.setStatus('error', CONNACK_ERRORS[p.returnCode] || `code ${p.returnCode}`);
          // неверный токен — не долбим брокер
          if (p.returnCode === 4 || p.returnCode === 5) this.backoff = 30000;
          this.ws.close();
          return;
        }
        this.connected = true;
        this.backoff = 1000;
        this.setStatus('online');
        this.pingTimer = setInterval(() => this.send(encodePingreq()), (this.opts.keepalive * 1000) / 2);
        if (this.subs.size) this.rawSubscribe([...this.subs]).catch(() => {});
        this.emit('connect');
        break;
      case PacketType.PUBLISH:
        if (p.qos === 1 && p.packetId != null) this.send(encodePuback(p.packetId));
        this.emit('message', p.topic, decodeUtf8(p.payload), p);
        break;
      case PacketType.SUBACK:
      case PacketType.UNSUBACK: {
        const req = this.pending.get(p.packetId);
        if (!req) break;
        this.pending.delete(p.packetId);
        if (p.type === PacketType.SUBACK && p.granted.some((g) => g === 0x80)) {
          req.reject(new Error(`subscription denied: ${req.filters.join(', ')}`));
        } else {
          req.resolve(p);
        }
        break;
      }
      default:
        break;
    }
  }

  packetId() {
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffff ? 1 : this.nextId + 1;
    return id;
  }

  request(bytesFor, filters) {
    if (!this.connected) return Promise.resolve(null); // отправится после connect
    const id = this.packetId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, filters });
      this.send(bytesFor(id));
    });
  }

  rawSubscribe(filters) {
    return this.request((id) => encodeSubscribe(id, filters, 1), filters);
  }

  subscribe(filter) {
    if (this.subs.has(filter)) return Promise.resolve(null);
    this.subs.add(filter);
    return this.rawSubscribe([filter]);
  }

  unsubscribe(filter) {
    if (!this.subs.delete(filter)) return Promise.resolve(null);
    return this.request((id) => encodeUnsubscribe(id, [filter]), [filter]);
  }
}
