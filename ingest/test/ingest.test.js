import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, parseValue } from '../src/parse.js';
import { IngestBuffer, batchToQueries } from '../src/buffer.js';

const id = 'd0123456789abcdef';
const msg = (leaf, payload) => parseMessage(`dev/${id}/${leaf}`, Buffer.from(payload));

test('parseValue', () => {
  assert.deepEqual(parseValue(' 23.5 '), { num: 23.5, text: null });
  assert.deepEqual(parseValue('-1e3'), { num: -1000, text: null });
  assert.deepEqual(parseValue('true'), { num: 1, text: 'true' });
  assert.deepEqual(parseValue('false'), { num: 0, text: 'false' });
  assert.deepEqual(parseValue('on'), { num: null, text: 'on' });
  assert.deepEqual(parseValue('0x10'), { num: null, text: '0x10' });
  assert.deepEqual(parseValue('Infinity'), { num: null, text: 'Infinity' });
});

test('parseMessage kinds', () => {
  assert.deepEqual(msg('temperature', '21.4'), { kind: 'value', deviceId: id, property: 'temperature', num: 21.4, text: null });
  assert.deepEqual(msg('$state', 'ready'), { kind: 'state', deviceId: id, state: 'ready' });
  assert.equal(msg('$state', 'hacked'), null);
  assert.deepEqual(msg('$meta', '{"props":{}}'), { kind: 'meta', deviceId: id, meta: { props: {} } });
  assert.equal(msg('$meta', '[1,2]'), null);
  assert.equal(msg('$meta', '{bad'), null);
  assert.equal(msg('Temp', '1'), null);
  assert.equal(msg('temp', ''), null);
  assert.equal(msg('temp', 'x'.repeat(300)), null);
  assert.equal(parseMessage('dev/notanid/temp', Buffer.from('1')), null);
  assert.equal(parseMessage(`dev/${id}/relay/set`, Buffer.from('1')), null);
  assert.equal(parseMessage('other/topic/x', Buffer.from('1')), null);
});

test('buffer collects, takes and restores', () => {
  const b = new IngestBuffer({ maxRows: 3 });
  b.add(msg('t', '1'));
  b.add(msg('t', '2'));
  b.add(msg('$state', 'ready'));
  assert.equal(b.size, 3);
  const batch = b.take();
  assert.equal(b.size, 0);
  assert.deepEqual(batch.latest.get(id), { t: 2 });

  b.add(msg('t', '3'));
  b.add(msg('$state', 'lost'));
  b.restore(batch);
  assert.equal(b.rows.length, 3);
  assert.deepEqual(b.rows.map((r) => r.num), [1, 2, 3]);
  assert.equal(b.states.get(id), 'lost', 'newer state wins');
  assert.deepEqual(b.latest.get(id), { t: 3 }, 'newer value wins');

  b.add(msg('t', '4'));
  assert.equal(b.rows.length, 3);
  assert.equal(b.dropped, 1);
});

test('batchToQueries builds parameterized SQL', () => {
  const b = new IngestBuffer();
  b.add(msg('t', '1'));
  b.add(msg('label', 'hello'));
  b.add(msg('$meta', '{"name":"x"}'));
  const q = batchToQueries(b.take());
  assert.equal(q.length, 3);
  assert.match(q[0][0], /unnest/);
  assert.deepEqual(q[0][1][2], ['t', 'label']);
  assert.deepEqual(q[0][1][3], [1, null]);
  assert.deepEqual(q[0][1][4], [null, 'hello']);
  assert.equal(q[1][1][1], JSON.stringify({ t: 1, label: 'hello' }));
  assert.match(q[2][0], /meta/);
});

test('bridge state marks its devices', () => {
  const ev = parseMessage('bridge/b00112233445566ff/$state', Buffer.from('lost'));
  assert.deepEqual(ev, { kind: 'bridge_state', bridgeId: 'b00112233445566ff', state: 'lost' });
  assert.equal(parseMessage('bridge/bad/$state', Buffer.from('lost')), null);
  const b = new IngestBuffer();
  b.add(ev);
  const q = batchToQueries(b.take());
  assert.equal(q.length, 2);
  assert.match(q[1][0], /WHERE bridge_id = \$1/);
  b.add(parseMessage('bridge/b00112233445566ff/$state', Buffer.from('ready')));
  assert.equal(batchToQueries(b.take()).length, 1);
});

test('NUL bytes are rejected before they reach PostgreSQL', () => {
  const id = 'd0123456789abcdef';
  assert.equal(parseMessage(`dev/${id}/label`, Buffer.from('a\0b')), null);
  assert.equal(parseMessage(`dev/${id}/$meta`, Buffer.from('{"name":"x\0"}')), null);
  assert.equal(parseMessage(`dev/${id}/$meta`, Buffer.from('{"name":"x\\u0000y"}')), null);
  assert.equal(parseMessage(`dev/${id}/$meta`, Buffer.from('{"props":{"t\\u0000":{}}}')), null);
  assert.equal(parseMessage(`dev/${id}/label`, Buffer.from('ok')).text, 'ok');
});
