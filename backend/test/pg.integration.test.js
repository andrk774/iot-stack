// Интеграция с настоящим PostgreSQL: схема, миграции, SQL всех маршрутов, ingest.
// Запуск: PG_TEST_URL=postgres://iot@127.0.0.1:54329/postgres node --test test/pg.integration.test.js
// TimescaleDB-функции заменены заглушками (time_bucket -> date_bin), остальное — реальный SQL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from '../../devtools/pgwire.js';
import { migrate, listMigrations } from '../src/migrate.js';
import { channelRoutes, linkTelegramChat, unlinkTelegramChat } from '../src/routes/channels.js';
import { Dispatcher } from '../src/notify/dispatcher.js';
import { otaRoutes, handleOtaStatus } from '../src/routes/ota.js';
import { accountRoutes } from '../src/routes/account.js';
import { totpCode } from '../src/security.js';
import { createServer, Router } from '../src/http.js';
import { publicRoutes } from '../src/routes/public.js';
import { scenarioRoutes } from '../src/routes/scenarios.js';
import { bridgeRoutes } from '../src/routes/bridges.js';
import { internalRoutes } from '../src/routes/internal.js';
import { IngestBuffer, batchToQueries } from '../../ingest/src/buffer.js';
import { parseMessage } from '../../ingest/src/parse.js';

const URL_ = process.env.PG_TEST_URL;
const skip = !URL_ && 'PG_TEST_URL не задан';
const dbName = `iot_test_${Date.now()}`;

let admin; let db; let api; let hooks; let apiUrl; let hooksUrl;
const published = [];
const kicked = [];
const emqx = { kick: async (id) => { kicked.push(id); return true; }, kickUser: async (u) => { kicked.push(u); return 1; } };
const mqttFake = { connected: true, publish: async (t, v, o) => { published.push([t, v, o]); } };
const testSent = [];
const testSenders = {
  webhook: async (ch, n) => { testSent.push([ch.id, n.message]); },
  telegram: async (ch, n) => { testSent.push([ch.id, n.message]); },
};
const config = {
  firmwareMaxBytes: 64 * 1024,
  telegramBotToken: '1:x', webhookAllowPrivate: false,
  jwtSecret: 'j'.repeat(40), jwtTtlSec: 3600, allowRegistration: true, maxDevicesPerUser: 5, maxBridgeDevices: 3,
  claimTtlMin: 30, publicHost: 'iot.test', mqttPublicPort: 8883, serviceUsers: { backend: 'b', ingest: 'i', scenarios: 's' },
};

async function schemaWithoutTimescale() {
  let sql = await readFile(new URL('../../db/init/01-schema.sql', import.meta.url), 'utf8');
  sql = sql
    .replace(/CREATE EXTENSION IF NOT EXISTS timescaledb;/, '')
    .replace(/SELECT create_hypertable[^;]*;/, '')
    .replace(/ALTER TABLE telemetry SET \([\s\S]*?\);/, '')
    .replace(/SELECT add_\w+_policy[^;]*;/g, '');
  return `${sql}
    CREATE FUNCTION time_bucket(i interval, t timestamptz) RETURNS timestamptz
      LANGUAGE sql IMMUTABLE AS $$ SELECT date_bin(i, t, TIMESTAMPTZ '2000-01-01') $$;`;
}

before(async () => {
  if (skip) return;
  admin = new Pool(URL_);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(URL_);
  u.pathname = `/${dbName}`;
  db = new Pool(u.toString());
  await db.query(await schemaWithoutTimescale());
  await migrate(db, { log: {} });
  await migrate(db, { log: {} }); // повторно — ничего не делает
  const mqtt = mqttFake;
  api = createServer(new Router().use(accountRoutes({ db, config, emqx })).use(publicRoutes({ db, mqtt, config, emqx })).use(scenarioRoutes({ db, config }))
    .use(bridgeRoutes({ db, config, log: {}, emqx }))
    .use(channelRoutes({ db, config, senders: testSenders, telegramBot: { username: 'iot_test_bot' } }))
    .use(otaRoutes({ db, mqtt: mqttFake, config })), { log: { error: (...a) => console.error(...a) } });
  hooks = createServer(internalRoutes({ db, config, log: {} }));
  await new Promise((r) => api.listen(0, r));
  await new Promise((r) => hooks.listen(0, r));
  apiUrl = `http://127.0.0.1:${api.address().port}`;
  hooksUrl = `http://127.0.0.1:${hooks.address().port}`;
});

after(async () => {
  if (skip) return;
  api.close();
  hooks.close();
  await db.end();
  await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await admin.end();
});

const call = async (base, method, path, body, auth) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: auth } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test('migrations recorded', { skip }, async () => {
  const { rows } = await db.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((r) => r.version), (await listMigrations()).map((m) => m.version));
});

test('end-to-end on real SQL', { skip }, async () => {
  // аккаунт
  const reg = await call(apiUrl, 'POST', '/api/auth/register', { email: 'me@x.ru', password: 'password123' });
  assert.equal(reg.status, 201);
  const auth = `Bearer ${reg.body.token}`;
  const uid = reg.body.user.id;

  // устройство + привязка + MQTT
  const dev = await call(apiUrl, 'POST', '/api/devices', { name: 'Теплица' }, auth);
  assert.equal(dev.status, 201);
  assert.equal(dev.body.device.provisioned, false);
  const D = dev.body.device.id;
  const prov = await call(apiUrl, 'POST', '/api/provision', { claim_token: dev.body.claim_token });
  assert.equal(prov.status, 200);
  const mq = await call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: D, password: prov.body.mqtt.password, clientid: D });
  assert.equal(mq.body.result, 'allow');
  const renamed = await call(apiUrl, 'PUT', `/api/devices/${D}`, { name: 'Теплица-2' }, auth);
  assert.equal(renamed.body.name, 'Теплица-2');

  // ingest пишет телеметрию и состояние
  const buf = new IngestBuffer();
  const t0 = new Date(Date.now() - 3600_000);
  for (let i = 0; i < 6; i++) buf.add(parseMessage(`dev/${D}/temperature`, Buffer.from(String(20 + i))), new Date(t0.getTime() + i * 600_000));
  buf.add(parseMessage(`dev/${D}/$state`, Buffer.from('ready')));
  buf.add(parseMessage(`dev/${D}/$meta`, Buffer.from('{"props":{"relay":{"type":"boolean","settable":true},"temperature":{"type":"float"}}}')));
  buf.add(parseMessage('dev/dffffffffffffffff/temperature', Buffer.from('99'))); // неизвестное устройство отбросится
  for (const [sql, params] of batchToQueries(buf.take())) await db.query(sql, params);
  const one = await call(apiUrl, 'GET', `/api/devices/${D}`, null, auth);
  assert.equal(one.body.state, 'ready');
  assert.equal(one.body.last_values.temperature, 25);
  const raw = await call(apiUrl, 'GET', `/api/devices/${D}/telemetry?property=temperature`, null, auth);
  assert.deepEqual(raw.body.points.map((p) => p.v), [20, 21, 22, 23, 24, 25]);
  const bucket = await call(apiUrl, 'GET', `/api/devices/${D}/telemetry?property=temperature&bucket=1h`, null, auth);
  assert.equal(bucket.body.points.reduce((s, p) => s + p.n, 0), 6);
  const { rows: orphan } = await db.query("SELECT count(*)::int AS n FROM telemetry WHERE device_id = 'dffffffffffffffff'");
  assert.equal(orphan[0].n, 0);

  // команды учитывают $meta
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${D}/commands`, { property: 'temperature', value: 1 }, auth)).status, 400);
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${D}/commands`, { property: 'relay', value: true }, auth)).status, 202);
  assert.deepEqual(published.at(-1).slice(0, 2), [`dev/${D}/relay/set`, 'true']);

  // веб-панель по MQTT: ACL по владельцу
  const userAcl = await call(hooksUrl, 'POST', '/internal/mqtt/acl', { username: `u:${uid}`, topic: `dev/${D}/#`, action: 'subscribe' });
  assert.equal(userAcl.body.result, 'allow');

  // мост
  const br = await call(apiUrl, 'POST', '/api/bridges', { name: 'Zigbee', type: 'zigbee2mqtt', config: {} }, auth);
  assert.equal(br.status, 201);
  assert.equal(br.body.bridge.config.base_topic, 'zigbee2mqtt');
  const B = br.body.bridge.id;
  const bauth = `Bridge ${B}:${br.body.token}`;
  assert.equal((await call(apiUrl, 'GET', '/api/bridge/self', null, bauth)).body.type, 'zigbee2mqtt');
  assert.equal((await call(apiUrl, 'GET', '/api/bridge/self', null, `Bridge ${B}:${'x'.repeat(32)}`)).status, 401);
  const c1 = await call(apiUrl, 'POST', '/api/bridge/devices', { key: '0x00158d0001a2b3c4', name: 'kitchen' }, bauth);
  const c2 = await call(apiUrl, 'POST', '/api/bridge/devices', { key: '0x00158d0001a2b3c4', name: 'kitchen' }, bauth);
  assert.equal(c1.status, 201);
  assert.equal(c2.body.id, c1.body.id, 'повторная регистрация возвращает то же устройство');
  assert.equal(c1.body.provisioned, true);
  const BD = c1.body.id;
  assert.equal((await call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: B, password: br.body.token, clientid: B })).body.result, 'allow');
  assert.equal((await call(hooksUrl, 'POST', '/internal/mqtt/acl', { username: B, topic: `dev/${BD}/temperature`, action: 'publish' })).body.result, 'allow');
  assert.equal((await call(hooksUrl, 'POST', '/internal/mqtt/acl', { username: B, topic: `dev/${D}/temperature`, action: 'publish' })).body.result, 'deny');
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${BD}/claim`, {}, auth)).status, 409);
  // лимит устройств моста
  await call(apiUrl, 'POST', '/api/bridge/devices', { key: 'k2' }, bauth);
  await call(apiUrl, 'POST', '/api/bridge/devices', { key: 'k3' }, bauth);
  assert.equal((await call(apiUrl, 'POST', '/api/bridge/devices', { key: 'k4' }, bauth)).status, 409);
  // состояние моста -> его устройства
  const bb = new IngestBuffer();
  bb.add(parseMessage(`bridge/${B}/$state`, Buffer.from('lost')));
  for (const [sql, params] of batchToQueries(bb.take())) await db.query(sql, params);
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${BD}`, null, auth)).body.state, 'lost');
  const list = await call(apiUrl, 'GET', '/api/bridges', null, auth);
  assert.equal(list.body.bridges[0].device_count, 3);
  assert.equal(list.body.bridges[0].state, 'lost');

  // сценарии
  const scen = {
    name: 'Жарко', trigger: { type: 'property', device_id: D, property: 'temperature', op: 'gt', value: 30 },
    actions: [{ type: 'set', device_id: BD, property: 'state', value: true }, { type: 'notify', message: 'жарко {value}' }],
  };
  const s1 = await call(apiUrl, 'POST', '/api/scenarios', scen, auth);
  assert.equal(s1.status, 201);
  assert.equal(s1.body.trigger.op, 'gt');
  // D описал $meta: temperature не settable — сценарий не может туда писать (как и /commands)
  const notSettable = await call(apiUrl, 'POST', '/api/scenarios', { ...scen, actions: [{ type: 'set', device_id: D, property: 'temperature', value: 1 }] }, auth);
  assert.equal(notSettable.status, 400);
  assert.equal(notSettable.body.details.field, 'actions[0].property');
  assert.equal((await call(apiUrl, 'POST', '/api/scenarios', { ...scen, name: 'реле', actions: [{ type: 'set', device_id: D, property: 'relay', value: true }] }, auth)).status, 201);
  const bad = await call(apiUrl, 'POST', '/api/scenarios', { ...scen, actions: [{ type: 'set', device_id: 'd0000000000000000', property: 'x', value: 1 }] }, auth);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'device_not_found');
  const upd = await call(apiUrl, 'PUT', `/api/scenarios/${s1.body.id}`, { ...scen, enabled: false, cooldown_sec: 60 }, auth);
  assert.equal(upd.body.enabled, false);
  assert.equal((await call(apiUrl, 'POST', `/api/scenarios/${s1.body.id}/run`, {}, auth)).status, 409);
  await call(apiUrl, 'PUT', `/api/scenarios/${s1.body.id}`, scen, auth);
  assert.equal((await call(apiUrl, 'POST', `/api/scenarios/${s1.body.id}/run`, {}, auth)).status, 202);
  // как пишет scenario-runner
  await db.query('UPDATE scenarios SET last_run_at = now(), last_error = $2 WHERE id = $1', [s1.body.id, null]);
  await db.query('INSERT INTO notifications (owner_id, scenario_id, level, message) VALUES ($1, $2, $3, $4)', [uid, s1.body.id, 'warning', 'жарко 31']);
  const notes = await call(apiUrl, 'GET', '/api/notifications', null, auth);
  assert.equal(notes.body.unread, 1);
  assert.equal(notes.body.notifications[0].scenario_name, 'Жарко');
  assert.equal((await call(apiUrl, 'POST', '/api/notifications/read', {}, auth)).body.updated, 1);
  assert.equal((await call(apiUrl, 'GET', '/api/notifications?unread=true', null, auth)).body.notifications.length, 0);

  // чужой пользователь ничего не видит
  const other = await call(apiUrl, 'POST', '/api/auth/register', { email: 'other@x.ru', password: 'password123' });
  const oauth = `Bearer ${other.body.token}`;
  assert.equal((await call(apiUrl, 'GET', `/api/scenarios/${s1.body.id}`, null, oauth)).status, 404);
  assert.equal((await call(apiUrl, 'GET', `/api/bridges/${B}`, null, oauth)).status, 404);
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${D}`, null, oauth)).status, 404);
  assert.equal((await call(hooksUrl, 'POST', '/internal/mqtt/acl', { username: `u:${other.body.user.id}`, topic: `dev/${D}/#`, action: 'subscribe' })).body.result, 'deny');

  // смена токена моста разрывает его сессию
  kicked.length = 0;
  assert.equal((await call(apiUrl, 'POST', `/api/bridges/${B}/token`, {}, auth)).status, 200);
  assert.deepEqual(kicked, [B]);

  // удаление моста: устройства каскадом, сессия моста разорвана
  assert.equal((await call(apiUrl, 'DELETE', `/api/bridges/${B}`, null, auth)).status, 204);
  assert.deepEqual(kicked, [B, B]);
  const { rows: left } = await db.query('SELECT count(*)::int AS n FROM devices WHERE owner_id = $1', [uid]);
  assert.equal(left[0].n, 1);
  // перепривязка: старая учётка не работает и открытая сессия разорвана
  kicked.length = 0;
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${D}/claim`, {}, auth)).status, 200);
  assert.deepEqual(kicked, [D]);
  assert.equal((await call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: D, password: prov.body.mqtt.password, clientid: D })).body.result, 'deny');
  assert.equal((await call(apiUrl, 'DELETE', `/api/devices/${D}`, null, auth)).status, 204);
  assert.deepEqual(kicked, [D, D]);
  const { rows: tel } = await db.query('SELECT count(*)::int AS n FROM telemetry WHERE device_id = $1', [D]);
  assert.equal(tel[0].n, 0);
});

test('limits hold under concurrent requests', { skip }, async () => {
  const reg = await call(apiUrl, 'POST', '/api/auth/register', { email: 'race@x.ru', password: 'password123' });
  const auth = `Bearer ${reg.body.token}`;
  const res = await Promise.all(Array.from({ length: 12 }, (_, i) => call(apiUrl, 'POST', '/api/devices', { name: `d${i}` }, auth)));
  const codes = res.map((r) => r.status).sort();
  assert.equal(codes.filter((c) => c === 201).length, config.maxDevicesPerUser);
  assert.equal(codes.filter((c) => c === 409).length, 12 - config.maxDevicesPerUser);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM devices WHERE owner_id = $1', [reg.body.user.id]);
  assert.equal(rows[0].n, config.maxDevicesPerUser);

  const br = await call(apiUrl, 'POST', '/api/bridges', { name: 'Z', type: 'zigbee2mqtt', config: {} }, auth);
  const bauth = `Bridge ${br.body.bridge.id}:${br.body.token}`;
  const regs = await Promise.all(Array.from({ length: 8 }, (_, i) => call(apiUrl, 'POST', '/api/bridge/devices', { key: `k${i}` }, bauth)));
  assert.equal(regs.filter((r) => r.status === 201).length, config.maxBridgeDevices);
});

test('scenario trigger NOTIFY fires on definition change only', { skip }, async () => {
  const c = await db.connect();
  const got = [];
  c.onNotify = (body) => got.push(body.toString());
  await c.query('LISTEN scenarios_changed');
  const { rows: [u] } = await db.query("INSERT INTO users (email, password_hash) VALUES ('n@x.ru', 'x') RETURNING id");
  const { rows: [s] } = await db.query(`INSERT INTO scenarios (owner_id, name, trigger, actions) VALUES ($1, 'n', '{"type":"manual"}', '[]') RETURNING id`, [u.id]);
  await db.query('UPDATE scenarios SET last_run_at = now() WHERE id = $1', [s.id]);
  await db.query('UPDATE scenarios SET name = $2 WHERE id = $1', [s.id, 'n2']);
  await c.query('SELECT 1'); // получить накопившиеся уведомления
  assert.equal(got.filter((x) => x.includes('scenarios_changed')).length, 2); // insert + update name
});

test('notification channels and dispatch on real SQL', { skip }, async () => {
  const reg = await call(apiUrl, 'POST', '/api/auth/register', { email: 'ch@x.ru', password: 'password123' });
  const auth = `Bearer ${reg.body.token}`;
  const uid = reg.body.user.id;
  const other = await call(apiUrl, 'POST', '/api/auth/register', { email: 'ch2@x.ru', password: 'password123' });
  const auth2 = `Bearer ${other.body.token}`;

  assert.equal((await call(apiUrl, 'POST', '/api/channels', { type: 'webhook', url: 'http://example.com/' }, auth)).status, 400);
  assert.equal((await call(apiUrl, 'POST', '/api/channels', { type: 'webhook', url: 'https://10.0.0.5/x' }, auth)).status, 400);
  const wh = await call(apiUrl, 'POST', '/api/channels', { type: 'webhook', url: 'https://example.com/hook', min_level: 'warning' }, auth);
  assert.equal(wh.status, 201);
  assert.ok(wh.body.secret.length >= 30);
  assert.equal(wh.body.channel.url, 'https://example.com/hook');
  const tg = await call(apiUrl, 'POST', '/api/channels', { type: 'telegram', bot_token: `123456:${'A'.repeat(35)}`, chat_id: '-100123' }, auth);
  assert.equal(tg.status, 201);
  assert.equal(tg.body.channel.own_bot, true);
  const list = await call(apiUrl, 'GET', '/api/channels', null, auth);
  assert.equal(list.body.channels.length, 2);
  assert.equal(list.body.telegram_bot, 'iot_test_bot');
  assert.ok(!JSON.stringify(list.body).includes('A'.repeat(35)), 'токен бота не отдаётся');
  assert.ok(!JSON.stringify(list.body).includes(wh.body.secret), 'секрет вебхука не отдаётся');
  // чужой канал недоступен
  assert.equal((await call(apiUrl, 'PUT', `/api/channels/${wh.body.channel.id}`, { enabled: false }, auth2)).status, 404);
  assert.equal((await call(apiUrl, 'DELETE', `/api/channels/${wh.body.channel.id}`, null, auth2)).status, 404);

  // привязка платформенного бота: код одноразовый
  const link = await call(apiUrl, 'POST', '/api/channels/telegram-link', {}, auth);
  const code = new URL(link.body.url).searchParams.get('start');
  assert.match(link.body.url, /^https:\/\/t\.me\/iot_test_bot\?start=/);
  assert.equal(await linkTelegramChat(db, code, { id: '555', title: 'Андрей' }), 'linked');
  assert.equal(await linkTelegramChat(db, code, { id: '555', title: 'Андрей' }), 'invalid');
  const link2 = await call(apiUrl, 'POST', '/api/channels/telegram-link', {}, auth);
  assert.equal(await linkTelegramChat(db, new URL(link2.body.url).searchParams.get('start'), { id: '555' }), 'linked'); // тот же чат — без дубля
  const after = await call(apiUrl, 'GET', '/api/channels', null, auth);
  assert.equal(after.body.channels.filter((c) => c.type === 'telegram' && !c.own_bot).length, 1);

  // проверка канала
  assert.equal((await call(apiUrl, 'POST', `/api/channels/${wh.body.channel.id}/test`, {}, auth)).status, 200);

  // рассылка: уведомление уровня info не уходит в вебхук с порогом warning
  testSent.length = 0;
  await db.query("INSERT INTO notifications (owner_id, level, message) VALUES ($1, 'info', 'i1'), ($1, 'alert', 'a1')", [uid]);
  const d = new Dispatcher({ db, log: {}, sleep: async () => {}, senders: testSenders });
  await d.kick();
  const whId = wh.body.channel.id;
  assert.deepEqual(testSent.filter(([id]) => id === whId).map(([, m]) => m), ['a1']);
  assert.equal(testSent.filter(([, m]) => m === 'i1').length, 2); // два telegram-канала
  const { rows: pending } = await db.query('SELECT count(*)::int AS n FROM notifications WHERE dispatched_at IS NULL');
  assert.equal(pending[0].n, 0);

  assert.equal(await unlinkTelegramChat(db, '555'), 1);
  assert.equal((await call(apiUrl, 'DELETE', `/api/channels/${whId}`, null, auth)).status, 204);
});

test('OTA: firmware library, job, download by token, status from device', { skip }, async () => {
  const reg = await call(apiUrl, 'POST', '/api/auth/register', { email: 'ota@x.ru', password: 'password123' });
  const auth = `Bearer ${reg.body.token}`;
  const other = await call(apiUrl, 'POST', '/api/auth/register', { email: 'ota2@x.ru', password: 'password123' });
  const dev = await call(apiUrl, 'POST', '/api/devices', { name: 'Реле' }, auth);
  const D = dev.body.device.id;
  await call(apiUrl, 'POST', '/api/provision', { claim_token: dev.body.claim_token });

  const upload = (buf, q, a = auth) => fetch(`${apiUrl}/api/firmwares?${q}`, { method: 'POST', headers: { authorization: a, 'content-type': 'application/octet-stream' }, body: buf });
  const image = Buffer.alloc(5000, 7);
  image[0] = 0xe9;
  assert.equal((await upload(Buffer.alloc(5000, 1), 'name=x&version=1.0')).status, 400); // не образ ESP
  assert.equal((await upload(image, 'name=x&version=bad version')).status, 400);
  assert.equal((await upload(Buffer.alloc(config.firmwareMaxBytes + 1, 0xe9), 'name=x&version=1.0')).status, 413);
  const up = await upload(image, 'name=Реле&version=1.1.0');
  assert.equal(up.status, 201);
  const fw = await up.json();
  assert.equal(fw.size, 5000);
  assert.equal(fw.md5, (await import('node:crypto')).createHash('md5').update(image).digest('hex'));
  const list = await call(apiUrl, 'GET', '/api/firmwares', null, auth);
  assert.equal(list.body.firmwares.length, 1);
  assert.ok(!('data' in list.body.firmwares[0]));

  // чужая прошивка и чужое устройство
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${D}/ota`, { firmware_id: fw.id }, `Bearer ${other.body.token}`)).status, 404);

  const start = await call(apiUrl, 'POST', `/api/devices/${D}/ota`, { firmware_id: fw.id }, auth);
  assert.equal(start.status, 202);
  const [topic, payload, opts] = published.at(-1);
  assert.equal(topic, `dev/${D}/$ota/set`);
  assert.equal(opts.retain, true);
  const cmd = JSON.parse(payload);
  assert.deepEqual(Object.keys(cmd).sort(), ['job', 'md5', 'path', 'size', 'version']);
  assert.equal(cmd.version, '1.1.0');

  const dl = await fetch(apiUrl + cmd.path);
  assert.equal(dl.status, 200);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(image));
  assert.equal((await fetch(`${apiUrl}/api/ota/${'x'.repeat(32)}`)).status, 404);

  const status = (o) => handleOtaStatus({ db, mqtt: mqttFake, log: {} }, D, Buffer.from(JSON.stringify(o)));
  assert.equal(await status({ job: cmd.job, status: 'bogus' }), null);
  assert.equal((await status({ job: cmd.job, status: 'downloading', progress: 40 })).progress, 40);
  const done = await status({ job: cmd.job, status: 'done' });
  assert.equal(done.status, 'done');
  assert.deepEqual(published.at(-1).slice(0, 2), [`dev/${D}/$ota/set`, '']); // команда снята
  assert.equal(await status({ job: cmd.job, status: 'downloading' }), null); // итог не откатывается
  assert.equal((await fetch(apiUrl + cmd.path)).status, 404); // после итога ссылка не работает

  // новое задание отменяет незавершённое; отмена снимает команду
  const j2 = await call(apiUrl, 'POST', `/api/devices/${D}/ota`, { firmware_id: fw.id }, auth);
  const j3 = await call(apiUrl, 'POST', `/api/devices/${D}/ota`, { firmware_id: fw.id }, auth);
  const { rows } = await db.query('SELECT id, status FROM ota_jobs WHERE id = ANY($1::uuid[])', [[j2.body.job.id, j3.body.job.id]]);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.status])), { [j2.body.job.id]: 'cancelled', [j3.body.job.id]: 'pending' });
  assert.equal((await call(apiUrl, 'DELETE', `/api/devices/${D}/ota`, null, auth)).body.cancelled, 1);
  const cur = await call(apiUrl, 'GET', `/api/devices/${D}/ota`, null, auth);
  assert.equal(cur.body.job.status, 'cancelled');
  assert.equal((await call(apiUrl, 'DELETE', `/api/firmwares/${fw.id}`, null, auth)).status, 204);
});

test('sessions, password change and TOTP on real SQL', { skip }, async () => {
  const reg = await call(apiUrl, 'POST', '/api/auth/register', { email: 'sec@x.ru', password: 'password123' });
  const a1 = `Bearer ${reg.body.token}`;
  const uid = reg.body.user.id;
  const login = async (extra = {}) => call(apiUrl, 'POST', '/api/auth/login', { email: 'sec@x.ru', password: 'password123', ...extra });
  const a2 = `Bearer ${(await login()).body.token}`;
  const list = await call(apiUrl, 'GET', '/api/sessions', null, a1);
  assert.equal(list.body.sessions.length, 2);
  assert.equal(list.body.sessions.filter((x) => x.current).length, 1);

  // завершить другие сеансы: a2 перестаёт работать сразу, в том числе для MQTT панели
  assert.equal((await call(apiUrl, 'POST', '/api/sessions/revoke-others', {}, a1)).body.closed, 1);
  assert.equal((await call(apiUrl, 'GET', '/api/me', null, a2)).status, 401);
  const mq = (tok) => call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: `u:${uid}`, password: tok, clientid: `web-${uid}-abcd` });
  assert.equal((await mq(a2.slice(7))).body.result, 'deny');
  assert.equal((await mq(a1.slice(7))).body.result, 'allow');
  assert.ok(kicked.includes(`u:${uid}`));

  // смена пароля: нужен текущий; остальные сеансы закрываются, текущий живёт
  const a3 = `Bearer ${(await login()).body.token}`;
  assert.equal((await call(apiUrl, 'POST', '/api/auth/password', { current_password: 'wrong', new_password: 'newpassword1' }, a1)).status, 403);
  const ch = await call(apiUrl, 'POST', '/api/auth/password', { current_password: 'password123', new_password: 'newpassword1' }, a1);
  assert.equal(ch.body.sessions_closed, 1);
  assert.equal((await call(apiUrl, 'GET', '/api/me', null, a3)).status, 401);
  assert.equal((await call(apiUrl, 'GET', '/api/me', null, a1)).status, 200);
  assert.equal((await login()).status, 401);
  const relog = (extra = {}) => call(apiUrl, 'POST', '/api/auth/login', { email: 'sec@x.ru', password: 'newpassword1', ...extra });
  assert.equal((await relog()).status, 200);

  // 2FA
  const setup = await call(apiUrl, 'POST', '/api/auth/totp/setup', {}, a1);
  assert.match(setup.body.otpauth_url, /^otpauth:\/\/totp\//);
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await call(apiUrl, 'POST', '/api/auth/totp/enable', { code: '000000' === totpCode(setup.body.secret, step) ? '111111' : '000000' }, a1)).status, 400);
  const en = await call(apiUrl, 'POST', '/api/auth/totp/enable', { code: totpCode(setup.body.secret, step) }, a1);
  assert.equal(en.status, 200);
  assert.equal(en.body.recovery_codes.length, 10);
  assert.equal((await call(apiUrl, 'GET', '/api/me', null, a1)).body.totp_enabled, true);

  assert.equal((await relog()).body.error, 'totp_required');
  // код, использованный при включении, повторно не принимается
  assert.equal((await relog({ code: totpCode(setup.body.secret, step) })).body.error, 'invalid_totp');
  const next = totpCode(setup.body.secret, step + 1);
  assert.equal((await relog({ code: next })).status, 200);
  assert.equal((await relog({ code: next })).body.error, 'invalid_totp');
  // код восстановления — одноразовый, регистр и дефисы не важны
  const rc = en.body.recovery_codes[0];
  assert.equal((await relog({ code: rc.toUpperCase().replace(/-/g, '') })).status, 200);
  assert.equal((await relog({ code: rc })).body.error, 'invalid_totp');
  assert.equal((await call(apiUrl, 'GET', '/api/me', null, a1)).body.recovery_codes_left, 9);

  // выключение: пароль + код
  assert.equal((await call(apiUrl, 'POST', '/api/auth/totp/disable', { password: 'newpassword1', code: '123' }, a1)).status, 400);
  assert.equal((await call(apiUrl, 'POST', '/api/auth/totp/disable', { password: 'newpassword1', code: en.body.recovery_codes[1] }, a1)).status, 200);
  assert.equal((await relog()).status, 200);

  // выход
  assert.equal((await call(apiUrl, 'POST', '/api/auth/logout', {}, a1)).status, 204);
  assert.equal((await call(apiUrl, 'GET', '/api/me', null, a1)).status, 401);
});
