import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmqxAdmin } from '../src/emqx.js';

test('kick calls EMQX REST API with basic auth', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, init.method, init.headers.authorization]); return { status: calls.length === 1 ? 204 : 404 }; };
  const e = createEmqxAdmin({ url: 'http://emqx:18083/', key: 'iot-backend', secret: 's3cret', fetchImpl, log: {} });
  assert.equal(e.enabled, true);
  assert.equal(await e.kick('d0123456789abcdef'), true);
  assert.equal(await e.kick('web-x/y'), true); // 404 — не был подключён
  assert.deepEqual(calls[0], ['http://emqx:18083/api/v5/clients/d0123456789abcdef', 'DELETE', `Basic ${Buffer.from('iot-backend:s3cret').toString('base64')}`]);
  assert.equal(calls[1][0], 'http://emqx:18083/api/v5/clients/web-x%2Fy');
});

test('kick failures are reported, not thrown', async () => {
  const errors = [];
  const log = { error: (m) => errors.push(m), warn: (m) => errors.push(m) };
  const down = createEmqxAdmin({ url: 'http://emqx:18083', key: 'k', secret: 's', fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, log });
  assert.equal(await down.kick('d1'), false);
  const denied = createEmqxAdmin({ url: 'http://emqx:18083', key: 'k', secret: 's', fetchImpl: async () => ({ status: 401 }), log });
  assert.equal(await denied.kick('d1'), false);
  const off = createEmqxAdmin({ url: 'http://emqx:18083', key: '', secret: '', log });
  assert.equal(off.enabled, false);
  assert.equal(await off.kick('d1'), false);
  assert.equal(errors.length, 3);
});
