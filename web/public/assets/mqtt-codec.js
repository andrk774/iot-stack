// Минимальный кодек MQTT 3.1.1 — только то, что нужно панели (подписка и приём).
// Без зависимостей; работает в браузере и в Node (тесты).

export const PacketType = {
  CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9,
  UNSUBSCRIBE: 10, UNSUBACK: 11, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14,
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeRemainingLength(n) {
  if (n < 0 || n > 268_435_455) throw new RangeError('remaining length out of range');
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

function str(s) {
  const b = enc.encode(s);
  if (b.length > 0xffff) throw new RangeError('string too long');
  return [b.length >> 8, b.length & 0xff, ...b];
}

function packet(header, body) {
  return new Uint8Array([header, ...encodeRemainingLength(body.length), ...body]);
}

export function encodeConnect({ clientId, username, password, keepalive = 30, clean = true }) {
  let flags = clean ? 0x02 : 0;
  if (username != null) flags |= 0x80;
  if (password != null) flags |= 0x40;
  const body = [
    ...str('MQTT'), 4, flags, keepalive >> 8, keepalive & 0xff,
    ...str(clientId),
    ...(username != null ? str(username) : []),
    ...(password != null ? str(password) : []),
  ];
  return packet(0x10, body);
}

export function encodeSubscribe(packetId, filters, qos = 1) {
  const body = [packetId >> 8, packetId & 0xff];
  for (const f of filters) body.push(...str(f), qos);
  return packet(0x82, body);
}

export function encodeUnsubscribe(packetId, filters) {
  const body = [packetId >> 8, packetId & 0xff];
  for (const f of filters) body.push(...str(f));
  return packet(0xa2, body);
}

export const encodePuback = (packetId) => new Uint8Array([0x40, 0x02, packetId >> 8, packetId & 0xff]);
export const encodePingreq = () => new Uint8Array([0xc0, 0x00]);
export const encodeDisconnect = () => new Uint8Array([0xe0, 0x00]);

function parsePacket(type, flags, b) {
  const u16 = (i) => (b[i] << 8) | b[i + 1];
  switch (type) {
    case PacketType.CONNACK:
      return { type, sessionPresent: (b[0] & 1) === 1, returnCode: b[1] };
    case PacketType.SUBACK:
      return { type, packetId: u16(0), granted: Array.from(b.subarray(2)) };
    case PacketType.UNSUBACK:
    case PacketType.PUBACK:
      return { type, packetId: u16(0) };
    case PacketType.PINGRESP:
      return { type };
    case PacketType.PUBLISH: {
      const qos = (flags >> 1) & 3;
      const tlen = u16(0);
      const topic = dec.decode(b.subarray(2, 2 + tlen));
      let i = 2 + tlen;
      let packetId = null;
      if (qos > 0) { packetId = u16(i); i += 2; }
      return { type, qos, retain: (flags & 1) === 1, dup: (flags & 8) === 8, topic, packetId, payload: b.slice(i) };
    }
    default:
      return { type, flags, body: b };
  }
}

/** Потоковый разборщик: WebSocket-кадры могут резать или склеивать MQTT-пакеты */
export class PacketReader {
  constructor() {
    this.buf = new Uint8Array(0);
  }

  push(chunk) {
    const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const merged = new Uint8Array(this.buf.length + c.length);
    merged.set(this.buf);
    merged.set(c, this.buf.length);
    this.buf = merged;

    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0;
      let mul = 1;
      let i = 1;
      let complete = false;
      for (; i < 5 && i < this.buf.length; i++) {
        len += (this.buf[i] & 0x7f) * mul;
        mul *= 128;
        if ((this.buf[i] & 0x80) === 0) { complete = true; i++; break; }
      }
      if (!complete) {
        if (i >= 5) throw new Error('malformed remaining length');
        break;
      }
      if (this.buf.length < i + len) break;
      const header = this.buf[0];
      out.push(parsePacket(header >> 4, header & 0x0f, this.buf.slice(i, i + len)));
      this.buf = this.buf.slice(i + len);
    }
    return out;
  }
}

export const decodeUtf8 = (bytes) => dec.decode(bytes);
