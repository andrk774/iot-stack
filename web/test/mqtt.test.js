import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PacketReader, PacketType, encodeConnect, encodeSubscribe, encodeRemainingLength,
} from '../public/assets/mqtt-codec.js';
import { MqttClient } from '../public/assets/mqtt-client.js';

const hex = (u8) => Buffer.from(u8).toString('hex');

test('remaining length varint', () => {
  assert.deepEqual(encodeRemainingLength(0), [0]);
  assert.deepEqual(encodeRemainingLength(127), [0x7f]);
  assert.deepEqual(encodeRemainingLength(128), [0x80, 0x01]);
  assert.deepEqual(encodeRemainingLength(16383), [0xff, 0x7f]);
  assert.deepEqual(encodeRemainingLength(268435455), [0xff, 0xff, 0xff, 0x7f]);
});

test('CONNECT matches MQTT 3.1.1 layout', () => {
  const p = encodeConnect({ clientId: 'c', username: 'u', password: 'p', keepalive: 60 });
  // 10 len | 00 04 MQTT | 04 | c2 | 00 3c | 00 01 'c' | 00 01 'u' | 00 01 'p'
  assert.equal(hex(p), '1013' + '00044d515454' + '04' + 'c2' + '003c' + '000163' + '000175' + '000170');
});

test('SUBSCRIBE layout', () => {
  assert.equal(hex(encodeSubscribe(10, ['a/b'], 1)), '8208' + '000a' + '0003612f62' + '01');
});

// PUBLISH qos1: topic "t", id 7, payload "hi"
const pub = new Uint8Array([0x32, 0x07, 0x00, 0x01, 0x74, 0x00, 0x07, 0x68, 0x69]);

test('reader: split and merged frames', () => {
  const r = new PacketReader();
  assert.deepEqual(r.push(pub.slice(0, 1)), []);
  assert.deepEqual(r.push(pub.slice(1, 5)), []);
  const [p] = r.push(pub.slice(5));
  assert.equal(p.type, PacketType.PUBLISH);
  assert.equal(p.topic, 't');
  assert.equal(p.packetId, 7);
  assert.equal(Buffer.from(p.payload).toString(), 'hi');

  const both = new Uint8Array([0x20, 0x02, 0x00, 0x00, 0x90, 0x03, 0x00, 0x01, 0x80, 0xd0, 0x00]);
  const ps = new PacketReader().push(both);
  assert.deepEqual(ps.map((x) => x.type), [PacketType.CONNACK, PacketType.SUBACK, PacketType.PINGRESP]);
  assert.deepEqual(ps[1].granted, [0x80]);
});

test('reader: large payload (2-byte remaining length)', () => {
  const payload = Buffer.alloc(300, 0x61);
  const body = Buffer.concat([Buffer.from([0x00, 0x01, 0x74]), payload]);
  const frame = Buffer.concat([Buffer.from([0x30, ...encodeRemainingLength(body.length)]), body]);
  const [p] = new PacketReader().push(frame);
  assert.equal(p.payload.length, 300);
  assert.equal(p.qos, 0);
});

// --- клиент поверх фейкового WebSocket ---
class FakeWS {
  static last;
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    FakeWS.last = this;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(b) { this.sent.push(Buffer.from(b)); }
  close() { this.readyState = 3; this.onclose?.(); }
  serverSends(bytes) { this.onmessage?.({ data: new Uint8Array(bytes).buffer }); }
}

test('client: connect, subscribe, receive, puback, resubscribe on reconnect', async () => {
  const c = new MqttClient('wss://x/mqtt', {
    clientId: 'web-1', username: 'u:abc', password: () => 'tok', WebSocketImpl: FakeWS,
  });
  const got = [];
  c.on('message', (t, s) => got.push([t, s]));
  c.subscribe('dev/d1/#'); // до подключения — запомнить
  c.start();
  await new Promise((r) => setTimeout(r, 0));
  const ws = FakeWS.last;
  assert.deepEqual(ws.protocols, ['mqtt']);
  assert.equal(ws.sent[0][0], 0x10);
  assert.match(ws.sent[0].toString('latin1'), /u:abc.*tok/);

  ws.serverSends([0x20, 0x02, 0x00, 0x00]);
  assert.equal(c.status, 'online');
  const sub = ws.sent[1];
  assert.equal(sub[0], 0x82);
  assert.match(sub.toString('latin1'), /dev\/d1\/#/);

  ws.serverSends(pub);
  assert.deepEqual(got, [['t', 'hi']]);
  assert.equal(hex(ws.sent[2]), '40020007');

  // ACL отказал -> промис отклонён
  const denied = c.subscribe('dev/d2/#');
  const id = (ws.sent[3][2] << 8) | ws.sent[3][3];
  ws.serverSends([0x90, 0x03, id >> 8, id & 0xff, 0x80]);
  await assert.rejects(denied, /denied/);

  c.stop();
  assert.equal(c.status, 'offline');
});
