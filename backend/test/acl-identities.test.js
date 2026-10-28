import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aclDecision, identify } from '../src/acl.js';
import { createServer } from '../src/http.js';
import { internalRoutes } from '../src/routes/internal.js';
import { hashSecret, signJwt } from '../src/security.js';

const dev = 'd0123456789abcdef';
const bridge = 'b00112233445566ff';
const uid = '6f1c2b3a-1111-4222-8333-944455556666';
const user = `u:${uid}`;

test('identify', () => {
  assert.deepEqual(identify(dev), { kind: 'device', id: dev });
  assert.deepEqual(identify(bridge), { kind: 'bridge', id: bridge });
  assert.deepEqual(identify(user), { kind: 'user', id: uid });
  assert.equal(identify('u:not-a-uuid'), null);
  assert.equal(identify('backend'), null);
});

test('bridge: own $state, device subtrees via lookup', () => {
  assert.equal(aclDecision({ username: bridge, topic: `bridge/${bridge}/$state`, action: 'publish' }), 'allow');
  assert.equal(aclDecision({ username: bridge, topic: 'bridge/b99999999999999999/$state', action: 'publish' }), 'deny');
  assert.equal(aclDecision({ username: bridge, topic: `bridge/${bridge}/$state`, action: 'subscribe' }), 'deny');
  assert.deepEqual(aclDecision({ username: bridge, topic: `dev/${dev}/temp`, action: 'publish' }),
    { lookup: 'bridge_device', bridgeId: bridge, deviceId: dev });
  assert.deepEqual(aclDecision({ username: bridge, topic: `dev/${dev}/+/set`, action: 'subscribe' }),
    { lookup: 'bridge_device', bridgeId: bridge, deviceId: dev });
  assert.equal(aclDecision({ username: bridge, topic: 'dev/+/+/set', action: 'subscribe' }), 'deny');
  assert.equal(aclDecision({ username: bridge, topic: `dev/${dev}/relay/set`, action: 'publish' }), 'deny');
});

test('user: read-only own devices', () => {
  for (const t of ['#', '+', '$state', '$meta', 'temp', '+/set', 'temp/#']) {
    assert.deepEqual(aclDecision({ username: user, topic: `dev/${dev}/${t}`, action: 'subscribe' }),
      { lookup: 'user_device', userId: uid, deviceId: dev }, t);
  }
  assert.equal(aclDecision({ username: user, topic: `dev/${dev}/relay/set`, action: 'publish' }), 'deny');
  assert.equal(aclDecision({ username: user, topic: `dev/${dev}/temp`, action: 'publish' }), 'deny');
  assert.equal(aclDecision({ username: user, topic: 'dev/#', action: 'subscribe' }), 'deny');
  assert.equal(aclDecision({ username: user, topic: 'dev/+/temp', action: 'subscribe' }), 'deny');
  assert.equal(aclDecision({ username: user, topic: '#', action: 'subscribe' }), 'deny');
  assert.equal(aclDecision({ username: user, topic: `dev/${dev}/a/b/c`, action: 'subscribe' }), 'deny');
});

test('internal hooks: user JWT auth and lookup-based ACL', async (t) => {
  const config = { jwtSecret: 'k'.repeat(40), serviceUsers: { backend: 'x' } };
  const bridgeHash = await hashSecret('bridge-pass');
  const SID = '11111111-2222-4333-8444-555555555555';
  const db = {
    async query(sql, p) {
      if (sql.includes('FROM sessions WHERE id = $1 AND user_id = $2')) return { rows: p[0] === SID && p[1] === uid ? [{ last_seen_at: new Date() }] : [] };
      if (sql.includes('FROM bridges WHERE id')) return { rows: p[0] === bridge ? [{ mqtt_password_hash: bridgeHash }] : [] };
      if (sql.includes('AND bridge_id = $2')) return { rows: p[0] === dev && p[1] === bridge ? [{}] : [] };
      if (sql.includes('AND owner_id = $2')) return { rows: p[0] === dev && p[1] === uid ? [{}] : [] };
      return { rows: [] };
    },
  };
  const srv = createServer(internalRoutes({ db, config, log: {} }));
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = async (path, body) => (await fetch(url + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();

  const jwt = signJwt({ sub: uid, sid: SID }, config.jwtSecret, 60);
  // токен без сессии (отозван) — не пускает
  assert.equal((await post('/internal/mqtt/auth', { username: user, password: signJwt({ sub: uid, sid: '99999999-2222-4333-8444-555555555555' }, config.jwtSecret, 60), clientid: `web-${uid}-a1b2c3d4` })).result, 'deny');
  const webId = `web-${uid}-a1b2c3d4`;
  assert.equal((await post('/internal/mqtt/auth', { username: user, password: jwt, clientid: webId })).result, 'allow');
  assert.equal((await post('/internal/mqtt/auth', { username: user, password: jwt, clientid: dev })).result, 'deny');
  // чужой или «пустой» web-id: нельзя выбить сессию другого пользователя
  assert.equal((await post('/internal/mqtt/auth', { username: user, password: jwt, clientid: 'web-1' })).result, 'deny');
  assert.equal((await post('/internal/mqtt/auth', { username: user, password: jwt, clientid: 'web-00000000-0000-4000-8000-000000000000-a1b2' })).result, 'deny');
  assert.equal((await post('/internal/mqtt/auth', { username: user, password: jwt, clientid: `web-${uid}-` })).result, 'deny');
  const other = signJwt({ sub: '00000000-0000-4000-8000-000000000000', sid: SID }, config.jwtSecret, 60);
  assert.equal((await post('/internal/mqtt/auth', { username: user, password: other, clientid: webId })).result, 'deny');

  assert.equal((await post('/internal/mqtt/auth', { username: bridge, password: 'bridge-pass', clientid: bridge })).result, 'allow');
  assert.equal((await post('/internal/mqtt/auth', { username: bridge, password: 'bridge-pass', clientid: 'x' })).result, 'deny');

  assert.equal((await post('/internal/mqtt/acl', { username: user, topic: `dev/${dev}/#`, action: 'subscribe' })).result, 'allow');
  assert.equal((await post('/internal/mqtt/acl', { username: user, topic: 'dev/dffffffffffffffff/#', action: 'subscribe' })).result, 'deny');
  assert.equal((await post('/internal/mqtt/acl', { username: bridge, topic: `dev/${dev}/temp`, action: 'publish' })).result, 'allow');
  assert.equal((await post('/internal/mqtt/acl', { username: bridge, topic: 'dev/dffffffffffffffff/temp', action: 'publish' })).result, 'deny');
});
