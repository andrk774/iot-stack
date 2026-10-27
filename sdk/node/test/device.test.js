import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IotDevice } from '../index.js';
import { parseValue, formatValue, parseSetTopic, buildMeta } from '../src/protocol.js';

test('protocol', () => {
  assert.equal(parseValue('ON', { type: 'boolean' }), true);
  assert.equal(parseValue('2', { type: 'boolean' }), undefined);
  assert.equal(parseValue('101', { type: 'integer', max: 100 }), undefined);
  assert.equal(parseValue('21.456', { type: 'float', decimals: 1 }), 21.5);
  assert.equal(parseValue('inf', { type: 'float' }), undefined);
  assert.equal(formatValue(-0.001, { type: 'float', decimals: 2 }), '0');
  assert.equal(formatValue(7.9, { type: 'integer' }), '7');
  assert.equal(formatValue(NaN, { type: 'float' }), null);
  assert.equal(formatValue('я'.repeat(200), { type: 'string' }).length, 128);
  assert.equal(parseSetTopic('dev/d0123456789abcdef/relay/set', 'd0123456789abcdef'), 'relay');
  assert.equal(parseSetTopic('dev/d0123456789abcdef/a/b/set', 'd0123456789abcdef'), null);
  assert.equal(buildMeta('x', '1', [{ name: 't', type: 'float', unit: '°C', settable: false }]),
    '{"name":"x","fw":"1","props":{"t":{"type":"float","unit":"°C"}}}');
});

class FakeClient extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.connected = false; this.pub = []; this.subs = []; }
  async publishAsync(t, p, o) { this.pub.push([t, String(p), Boolean(o?.retain)]); }
  async subscribeAsync(f) { this.subs.push(f); }
  async endAsync() { this.connected = false; }
  serverConnects() { this.connected = true; this.emit('connect'); }
}

const ID = 'd0123456789abcdef';
const tick = () => new Promise((r) => setTimeout(r, 10));

async function makeDevice(extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'iotsdk-'));
  const calls = [];
  let client;
  const dev = new IotDevice({
    name: 'Pi', firmware: '2.0', host: 'iot.test', claimToken: 'claim-token-123456', log: false,
    credentialsFile: path.join(dir, 'creds.json'),
    fetch: async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({ device_id: ID, mqtt: { password: 'secret' } }) }; },
    mqttConnect: (url, opts) => { client = new FakeClient(url, opts); return client; },
    ...extra,
  });
  return { dev, calls, dir, getClient: () => client };
}

test('provision, connect, publish, commands', async () => {
  const { dev, calls, dir, getClient } = await makeDevice();
  const temp = dev.addFloat('temperature', { unit: '°C', decimals: 1 });
  const seen = [];
  const relay = dev.addBool('relay').onSet((v) => { seen.push(v); return true; });
  dev.addString('mode').onSet((v) => v === 'eco' || v === 'heat');
  temp.set(21.44);  // офлайн — запомнится

  await dev.start();
  assert.deepEqual(calls, [['https://iot.test/api/provision', { claim_token: 'claim-token-123456' }]]);
  const saved = JSON.parse(await readFile(path.join(dir, 'creds.json'), 'utf8'));
  assert.equal(saved.device_id, ID);
  // на Windows POSIX-прав нет (stat всегда отдаёт 0o666) — проверяем только там, где они есть
  if (process.platform !== 'win32') assert.equal((await stat(path.join(dir, 'creds.json'))).mode & 0o777, 0o600);

  const c = getClient();
  assert.equal(c.url, 'mqtts://iot.test:8883');
  assert.equal(c.opts.clientId, ID);
  assert.deepEqual(c.opts.will, { topic: `dev/${ID}/$state`, payload: 'lost', qos: 1, retain: true });
  c.serverConnects();
  await tick();
  assert.equal(dev.state, 'online');
  assert.deepEqual(c.subs, [`dev/${ID}/+/set`]);
  const meta = JSON.parse(c.pub.find(([t]) => t.endsWith('$meta'))[1]);
  assert.deepEqual(meta.props.relay, { type: 'boolean', settable: true });
  assert.ok(c.pub.some(([t, p]) => t === `dev/${ID}/temperature` && p === '21.4'));
  assert.deepEqual(c.pub.at(-1), [`dev/${ID}/$state`, 'ready', true]);

  temp.set(22);
  assert.deepEqual(c.pub.at(-1), [`dev/${ID}/temperature`, '22', false]);

  c.emit('message', `dev/${ID}/relay/set`, Buffer.from('on'));
  await tick();
  assert.deepEqual(seen, [true]);
  assert.equal(relay.value, true);
  assert.deepEqual(c.pub.at(-1), [`dev/${ID}/relay`, 'true', false]);

  c.emit('message', `dev/${ID}/mode/set`, Buffer.from('turbo')); // отклонено обработчиком
  await tick();
  assert.equal(dev.props.get('mode').value, undefined);
  c.emit('message', `dev/${ID}/temperature/set`, Buffer.from('5')); // не settable
  c.emit('message', `dev/${ID}/relay/set`, Buffer.from('maybe'));  // мусор
  await tick();
  assert.deepEqual(seen, [true]);

  await dev.stop();
  assert.deepEqual(c.pub.at(-1), [`dev/${ID}/$state`, 'disconnected', true]);
});

test('reuses credentials, re-provisions on new token, validates names', async () => {
  const first = await makeDevice();
  await first.dev.start();
  const again = await makeDevice({ credentialsFile: first.dev.o.credentialsFile });
  await again.dev.start();
  assert.equal(again.calls.length, 0, 'учётка из файла');
  const fresh = await makeDevice({ credentialsFile: first.dev.o.credentialsFile, claimToken: 'another-token-123456' });
  await fresh.dev.start();
  assert.equal(fresh.calls.length, 1, 'новый токен — новая привязка');

  assert.throws(() => first.dev.addFloat('Bad Name'), /property name/);
  assert.throws(() => first.dev.addFloat('relay2').onSet('x'), TypeError);

  const noToken = await makeDevice({ claimToken: undefined });
  await assert.rejects(noToken.dev.start(), /claimToken/);
});
