import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashSecret, verifySecret, signJwt, verifyJwt, safeEqual, newDeviceId,
} from '../src/security.js';

const SECRET = 'x'.repeat(40);

test('scrypt hash round-trip', async () => {
  const h = await hashSecret('hunter22');
  assert.match(h, /^scrypt\$/);
  assert.equal(await verifySecret('hunter22', h), true);
  assert.equal(await verifySecret('hunter23', h), false);
  assert.equal(await verifySecret('hunter22', 'garbage'), false);
  assert.equal(await verifySecret(undefined, h), false);
});

test('jwt sign/verify', () => {
  const t = signJwt({ sub: 'u1' }, SECRET, 60);
  assert.equal(verifyJwt(t, SECRET).sub, 'u1');
  assert.equal(verifyJwt(t, 'y'.repeat(40)), null);
  assert.equal(verifyJwt(t + 'x', SECRET), null);
  assert.equal(verifyJwt('a.b.c', SECRET), null);
  assert.equal(verifyJwt(null, SECRET), null);
});

test('jwt expiry and alg=none rejected', () => {
  const expired = signJwt({ sub: 'u1' }, SECRET, -1);
  assert.equal(verifyJwt(expired, SECRET), null);
  const [, body] = signJwt({ sub: 'u1' }, SECRET, 60).split('.');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(verifyJwt(`${none}.${body}.`, SECRET), null);
});

test('safeEqual and device ids', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', undefined), false);
  assert.match(newDeviceId(), /^d[0-9a-f]{16}$/);
});
