// Интеграционные тесты HTTP-слоя с фейковой БД (без PostgreSQL/EMQX).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http.js';
import { publicRoutes } from '../src/routes/public.js';
import { internalRoutes } from '../src/routes/internal.js';
import { accountRoutes } from '../src/routes/account.js';
import { Router } from '../src/http.js';
import crypto from 'node:crypto';
import { hashSecret, signJwt, sha256 } from '../src/security.js';

const config = {
  jwtSecret: 's'.repeat(40),
  jwtTtlSec: 3600,
  allowRegistration: true,
  maxDevicesPerUser: 2,
  claimTtlMin: 30,
  publicHost: 'iot.test',
  mqttPublicPort: 8883,
  serviceUsers: { backend: 'b-pass', ingest: 'i-pass' },
};

// --- крошечная in-memory "БД", понимающая только нужные запросы ---
const store = { users: [], devices: [], sessions: [] };
const db = {
  // транзакции: в памяти всё и так последовательно
  async connect() { return { query: (sql, p) => db.query(sql, p), release() {} }; },
  async query(sql, p = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s) || s.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
    if (s.startsWith('INSERT INTO users')) {
      if (store.users.some((u) => u.email === p[0])) throw Object.assign(new Error('dup'), { code: '23505' });
      const u = { id: crypto.randomUUID(), email: p[0], password_hash: p[1], totp_secret: null, totp_last_step: 0 };
      store.users.push(u);
      return { rows: [{ id: u.id, email: u.email }] };
    }
    if (s.startsWith('DELETE FROM sessions WHERE user_id = $1 AND expires_at') || s.startsWith('DELETE FROM sessions WHERE id IN')) return { rows: [], rowCount: 0 };
    if (s.startsWith('INSERT INTO sessions')) {
      const row = { id: crypto.randomUUID(), user_id: p[0], last_seen_at: new Date() };
      store.sessions.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (s.startsWith('SELECT last_seen_at FROM sessions')) {
      return { rows: store.sessions.filter((x) => x.id === p[0] && x.user_id === p[1]) };
    }
    if (s.startsWith('SELECT id, email, password_hash')) {
      return { rows: store.users.filter((u) => u.email === p[0]) };
    }
    if (s.startsWith('SELECT count(*)')) {
      return { rows: [{ n: store.devices.filter((d) => d.owner_id === p[0]).length }] };
    }
    if (s.startsWith('INSERT INTO devices')) {
      const d = {
        id: p[0], owner_id: p[1], name: p[2], claim_token_hash: p[3], claim_expires_at: p[4],
        mqtt_password_hash: null, state: 'new', meta: null,
      };
      store.devices.push(d);
      return { rows: [view(d)] };
    }
    if (s.includes('FROM devices WHERE id = $1 AND owner_id = $2')) {
      return { rows: store.devices.filter((d) => d.id === p[0] && d.owner_id === p[1]).map(view) };
    }
    if (s.startsWith('SELECT id FROM devices WHERE claim_token_hash')) {
      return { rows: store.devices.filter((d) => d.claim_token_hash === p[0] && d.claim_expires_at > new Date()) };
    }
    if (s.startsWith('UPDATE devices SET mqtt_password_hash')) {
      const d = store.devices.find((x) => x.id === p[0] && x.claim_token_hash === p[1]);
      if (!d) return { rowCount: 0 };
      Object.assign(d, { mqtt_password_hash: p[2], claim_token_hash: null, state: 'init' });
      return { rowCount: 1 };
    }
    if (s.startsWith('SELECT mqtt_password_hash FROM devices')) {
      return { rows: store.devices.filter((d) => d.id === p[0]) };
    }
    throw new Error(`fake db: unexpected query: ${s}`);
  },
};
const view = (d) => ({
  id: d.id, name: d.name, state: d.state, meta: d.meta, provisioned: d.mqtt_password_hash !== null,
});

const published = [];
const mqtt = { connected: true, publish: async (t, v) => { published.push([t, v]); } };

let api; let hooks; let apiUrl; let hooksUrl;
before(async () => {
  api = createServer(new Router().use(accountRoutes({ db, config })).use(publicRoutes({ db, mqtt, config })), { log: { error() {} } });
  hooks = createServer(internalRoutes({ db, config, log: { warn() {} } }));
  await new Promise((r) => api.listen(0, r));
  await new Promise((r) => hooks.listen(0, r));
  apiUrl = `http://127.0.0.1:${api.address().port}`;
  hooksUrl = `http://127.0.0.1:${hooks.address().port}`;
});
after(() => { api.close(); hooks.close(); });

const call = async (base, method, path, body, token) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test('full flow: register -> device -> provision -> mqtt auth -> command', async () => {
  const reg = await call(apiUrl, 'POST', '/api/auth/register', { email: 'A@Example.com', password: 'password123' });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.email, 'a@example.com');

  const dup = await call(apiUrl, 'POST', '/api/auth/register', { email: 'a@example.com', password: 'password123' });
  assert.equal(dup.status, 409);

  const bad = await call(apiUrl, 'POST', '/api/auth/login', { email: 'a@example.com', password: 'wrong-pass' });
  assert.equal(bad.status, 401);
  const login = await call(apiUrl, 'POST', '/api/auth/login', { email: 'a@example.com', password: 'password123' });
  assert.equal(login.status, 200);
  const { token } = login.body;

  assert.equal((await call(apiUrl, 'POST', '/api/devices', { name: 'x' })).status, 401);
  const dev = await call(apiUrl, 'POST', '/api/devices', { name: 'Kitchen sensor' }, token);
  assert.equal(dev.status, 201);
  const deviceId = dev.body.device.id;
  assert.match(deviceId, /^d[0-9a-f]{16}$/);

  // команда до привязки — 409
  const early = await call(apiUrl, 'POST', `/api/devices/${deviceId}/commands`, { property: 'relay', value: true }, token);
  assert.equal(early.status, 409);

  const prov = await call(apiUrl, 'POST', '/api/provision', { claim_token: dev.body.claim_token });
  assert.equal(prov.status, 200);
  assert.equal(prov.body.mqtt.username, deviceId);
  assert.equal(prov.body.mqtt.host, 'iot.test');
  const again = await call(apiUrl, 'POST', '/api/provision', { claim_token: dev.body.claim_token });
  assert.equal(again.status, 401, 'claim token is single-use');

  // MQTT-хуки
  const { password } = prov.body.mqtt;
  const ok = await call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: deviceId, password, clientid: deviceId });
  assert.deepEqual(ok.body, { result: 'allow', is_superuser: false });
  const wrongCid = await call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: deviceId, password, clientid: 'x' });
  assert.equal(wrongCid.body.result, 'deny');
  const wrongPw = await call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: deviceId, password: 'nope', clientid: deviceId });
  assert.equal(wrongPw.body.result, 'deny');
  const svc = await call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: 'ingest', password: 'i-pass', clientid: 'ingest-1' });
  assert.deepEqual(svc.body, { result: 'allow', is_superuser: true });
  const svcBad = await call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: 'ingest', password: 'b-pass', clientid: 'i' });
  assert.equal(svcBad.body.result, 'deny');
  const proto = await call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: '__proto__', password: 'x', clientid: 'x' });
  assert.equal(proto.body.result, 'deny');

  const acl = await call(hooksUrl, 'POST', '/internal/mqtt/acl', { username: deviceId, topic: `dev/${deviceId}/temp`, action: 'publish' });
  assert.equal(acl.body.result, 'allow');

  // команда
  const cmd = await call(apiUrl, 'POST', `/api/devices/${deviceId}/commands`, { property: 'relay', value: true }, token);
  assert.equal(cmd.status, 202);
  assert.deepEqual(published.at(-1), [`dev/${deviceId}/relay/set`, 'true']);

  // панель по MQTT: пароль — токен с живой сессией
  const uid = login.body.user.id;
  const web = (pw) => call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: `u:${uid}`, password: pw, clientid: `web-${uid}-abcd` });
  assert.equal((await web(token)).body.result, 'allow');
  store.sessions = store.sessions.filter((x) => x.user_id !== uid);
  assert.equal((await web(token)).body.result, 'deny');
  assert.equal((await call(apiUrl, 'GET', '/api/me', null, token)).status, 401);
});

test('ownership, validation and limits', async () => {
  const mk = (uid) => {
    const sid = crypto.randomUUID();
    store.sessions.push({ id: sid, user_id: uid, last_seen_at: new Date() });
    return signJwt({ sub: uid, sid }, config.jwtSecret, 60);
  };
  const owner = store.users[0].id;
  const other = mk(crypto.randomUUID());
  const ownerToken = mk(owner);
  // подпись верна, но сессии нет (отозвана) или токен старого формата без sid — 401
  const [d] = store.devices;
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${d.id}`, null, signJwt({ sub: owner, sid: crypto.randomUUID() }, config.jwtSecret, 60))).status, 401);
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${d.id}`, null, signJwt({ sub: owner }, config.jwtSecret, 60))).status, 401);
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${d.id}`, null, ownerToken)).status, 200);
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${d.id}`, null, other)).status, 404);
  assert.equal((await call(apiUrl, 'GET', '/api/devices/../../etc', null, ownerToken)).status, 404);
  assert.equal((await call(apiUrl, 'POST', '/api/devices', { name: '' }, ownerToken)).status, 400);
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${d.id}/commands`, { property: 'Bad/Topic', value: 1 }, ownerToken)).status, 400);

  assert.equal((await call(apiUrl, 'POST', '/api/devices', { name: 'second' }, ownerToken)).status, 201);
  assert.equal((await call(apiUrl, 'POST', '/api/devices', { name: 'third' }, ownerToken)).status, 409);

  // meta объявляет свойства — несуществующее/не settable отклоняется
  d.meta = { props: { relay: { settable: true }, temp: { type: 'float' } } };
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${d.id}/commands`, { property: 'temp', value: 1 }, ownerToken)).status, 400);
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${d.id}/commands`, { property: 'relay', value: false }, ownerToken)).status, 202);
});

test('http layer: bad json, wrong type, 404', async () => {
  const raw = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
  });
  assert.equal(raw.status, 400);
  const txt = await fetch(`${apiUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(txt.status, 415);
  assert.equal((await call(apiUrl, 'GET', '/nope')).status, 404);
  assert.equal((await call(apiUrl, 'GET', '/api/devices/%E0%A4%A')).status, 400);
});

test('expired claim token is rejected', async () => {
  const token = 'expired-token-1234567890';
  store.devices.push({ id: 'daaaaaaaaaaaaaaaa', owner_id: 'u1', claim_token_hash: sha256(token), claim_expires_at: new Date(Date.now() - 1000), mqtt_password_hash: await hashSecret('x') });
  assert.equal((await call(apiUrl, 'POST', '/api/provision', { claim_token: token })).status, 401);
});
