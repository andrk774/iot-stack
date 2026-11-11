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
import { homeRoutes } from '../src/routes/homes.js';
import { roomRoutes } from '../src/routes/rooms.js';
import { yandexRoutes } from '../src/routes/yandex.js';
import { createWebPush } from '../src/notify/webpush.js';
import crypto from 'node:crypto';
import { totpCode } from '../src/security.js';
import { createServer, Router } from '../src/http.js';
import { publicRoutes } from '../src/routes/public.js';
import { scenarioRoutes } from '../src/routes/scenarios.js';
import { bridgeRoutes } from '../src/routes/bridges.js';
import { internalRoutes } from '../src/routes/internal.js';
import { IngestBuffer, batchToQueries } from '../../ingest/src/buffer.js';
import { parseMessage } from '../../ingest/src/parse.js';
import { tokenRoutes } from '../src/routes/tokens.js';
import { metricsRoutes } from '../src/routes/metrics.js';
import { saveScenarioRun } from '../../scenarios/src/runs.js';
import { makeSenders } from '../src/notify/dispatcher.js';
import { Metrics } from '../../shared/metrics.js';

const URL_ = process.env.PG_TEST_URL;
const skip = !URL_ && 'PG_TEST_URL не задан';
const dbName = `iot_test_${Date.now()}`;

let admin; let db; let api; let hooks; let apiUrl; let hooksUrl;
const published = [];
const kicked = [];
const emqx = { kick: async (id) => { kicked.push(id); return true; }, kickUser: async (u) => { kicked.push(u); return 1; } };
const mqttFake = { connected: true, publish: async (t, v, o) => { published.push([t, v, o]); } };
const testSent = [];
const mails = [];
const testMail = { send: async (to, subject, text) => { mails.push({ to, subject, text }); } };
const testSenders = {
  webhook: async (ch, n) => { testSent.push([ch.id, n.message]); },
  telegram: async (ch, n) => { testSent.push([ch.id, n.message]); },
  email: makeSenders({ mail: testMail, publicHost: 'iot.test' }).email,
};
const config = {
  yandex: { clientId: 'yandex-alice', clientSecret: 's'.repeat(40) },
  firmwareMaxBytes: 64 * 1024,
  telegramBotToken: '1:x', webhookAllowPrivate: false,
  jwtSecret: 'j'.repeat(40), jwtTtlSec: 3600, allowRegistration: true, maxDevicesPerUser: 5, maxBridgeDevices: 3,
  claimTtlMin: 30, publicHost: 'iot.test', mqttPublicPort: 8883, serviceUsers: { backend: 'b', ingest: 'i', scenarios: 's' },
  metricsToken: 'metrics-token-1234567890', metricsSources: {},
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
  const webpush = await createWebPush({ db, subject: 'https://iot.test', log: {} });
  api = createServer(new Router().use(accountRoutes({ db, config, emqx })).use(homeRoutes({ db, config, emqx })).use(roomRoutes({ db, config })).use(yandexRoutes({ db, mqtt: mqttFake, config, log: {} })).use(publicRoutes({ db, mqtt, config, emqx })).use(scenarioRoutes({ db, config }))
    .use(bridgeRoutes({ db, config, log: {}, emqx }))
    .use(channelRoutes({ db, config, senders: testSenders, telegramBot: { username: 'iot_test_bot' }, webpush, mail: testMail, log: {} }))
    .use(otaRoutes({ db, mqtt: mqttFake, config }))
    .use(tokenRoutes({ db, config, emqx }))
    .use(metricsRoutes({ db, config, emqx: { stats: async () => ({ 'connections.count': 7 }) }, httpMetrics: new Metrics(), log: {} })), { log: { error: (...a) => console.error(...a) } });
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

test('web push subscription channel on real SQL', { skip }, async () => {
  const reg = await call(apiUrl, 'POST', '/api/auth/register', { email: 'push@x.ru', password: 'password123' });
  const auth = `Bearer ${reg.body.token}`;
  const list = await call(apiUrl, 'GET', '/api/channels', null, auth);
  assert.equal(Buffer.from(list.body.webpush_public_key, 'base64url').length, 65);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const sub = (endpoint, p256dh = ecdh.getPublicKey().toString('base64url')) => ({
    type: 'webpush', device: 'Chrome, Android',
    subscription: { endpoint, keys: { p256dh, auth: crypto.randomBytes(16).toString('base64url') } },
  });
  const ep = 'https://fcm.googleapis.com/fcm/send/abc123';
  const c1 = await call(apiUrl, 'POST', '/api/channels', sub(ep), auth);
  assert.equal(c1.status, 201);
  assert.equal(c1.body.channel.endpoint_host, 'fcm.googleapis.com');
  assert.ok(!JSON.stringify(c1.body).includes('p256dh'));
  const c2 = await call(apiUrl, 'POST', '/api/channels', sub(ep), auth); // тот же браузер подписался заново
  assert.equal(c2.body.channel.id, c1.body.channel.id);
  assert.equal((await call(apiUrl, 'POST', '/api/channels', sub('https://192.168.1.5/push'), auth)).status, 400);
  assert.equal((await call(apiUrl, 'POST', '/api/channels', sub(ep + 'x', Buffer.alloc(65, 4).toString('base64url')), auth)).status, 400);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM server_settings WHERE key = 'vapid'");
  assert.equal(rows[0].n, 1);
});

test('shared homes: roles, invites, MQTT ACL, notifications on real SQL', { skip }, async () => {
  const reg = async (email, extra = {}) => {
    const r = await call(apiUrl, 'POST', '/api/auth/register', { email, password: 'password123', ...extra });
    return { status: r.status, auth: `Bearer ${r.body?.token}`, id: r.body?.user?.id, body: r.body };
  };
  const A = await reg('owner@h.ru');
  const E = await reg('admin@h.ru');
  const C = await reg('viewer@h.ru');
  const D = await reg('stranger@h.ru');
  const dev = (await call(apiUrl, 'POST', '/api/devices', { name: 'Котёл' }, A.auth)).body.device;
  await call(apiUrl, 'POST', '/api/provision', { claim_token: (await call(apiUrl, 'POST', `/api/devices/${dev.id}/claim`, {}, A.auth)).body.claim_token });
  const sc = (await call(apiUrl, 'POST', '/api/scenarios', { name: 'Ручной', trigger: { type: 'manual' }, actions: [{ type: 'notify', message: 'x' }] }, A.auth)).body;

  const invite = async (role, who = A) => (await call(apiUrl, 'POST', '/api/invites', { role }, who.auth)).body;
  // регистрация по приглашению работает и при выключенной регистрации
  const invB = await invite('control');
  assert.match(invB.url, /^https:\/\/iot\.test\/#\/join\//);
  config.allowRegistration = false;
  assert.equal((await reg('nobody@h.ru')).status, 403);
  assert.equal((await reg('nobody@h.ru', { invite: 'x'.repeat(32) })).status, 404); // неверный код — аккаунт не создаётся
  const B = await reg('member@h.ru', { invite: invB.code });
  config.allowRegistration = true;
  assert.equal(B.status, 201);
  assert.equal((await reg('nobody@h.ru')).status, 201); // предыдущая попытка откатилась целиком
  assert.equal((await call(apiUrl, 'POST', '/api/invites/accept', { code: invB.code }, D.auth)).status, 404); // одноразовое
  const own = await invite('view');
  assert.equal((await call(apiUrl, 'POST', '/api/invites/accept', { code: own.code }, A.auth)).status, 409);
  assert.equal((await call(apiUrl, 'POST', '/api/invites/accept', { code: (await invite('view')).code }, C.auth)).body.owner_email, 'owner@h.ru');
  assert.equal((await call(apiUrl, 'POST', '/api/invites/accept', { code: (await invite('admin')).code }, E.auth)).body.role, 'admin');

  // control: видит и управляет, но не меняет
  const listB = await call(apiUrl, 'GET', '/api/devices', null, B.auth);
  assert.deepEqual(listB.body.devices.map((d) => [d.id, d.my_role, d.owner_id]), [[dev.id, 'control', A.id]]);
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${dev.id}/commands`, { property: 'relay', value: true }, B.auth)).status, 202);
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${dev.id}/telemetry?property=t`, null, B.auth)).status, 200);
  assert.equal((await call(apiUrl, 'PUT', `/api/devices/${dev.id}`, { name: 'x' }, B.auth)).status, 403);
  assert.equal((await call(apiUrl, 'DELETE', `/api/devices/${dev.id}`, null, B.auth)).status, 403);
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${dev.id}/claim`, {}, B.auth)).status, 403);
  assert.equal((await call(apiUrl, 'POST', `/api/scenarios/${sc.id}/run`, {}, B.auth)).status, 202);
  assert.equal((await call(apiUrl, 'PUT', `/api/scenarios/${sc.id}`, { name: 'y', trigger: { type: 'manual' }, actions: [{ type: 'notify', message: 'x' }] }, B.auth)).status, 403);
  assert.equal((await call(apiUrl, 'GET', '/api/scenarios', null, B.auth)).body.scenarios[0].my_role, 'control');
  assert.equal((await call(apiUrl, 'GET', '/api/bridges', null, B.auth)).body.bridges.length, 0);
  assert.equal((await call(apiUrl, 'POST', '/api/devices', { name: 'чужой', home: A.id }, B.auth)).status, 403);
  // в свой дом B добавляет устройства как обычно
  assert.equal((await call(apiUrl, 'POST', '/api/devices', { name: 'своё' }, B.auth)).body.device.owner_id, B.id);

  // view: только смотреть
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${dev.id}`, null, C.auth)).body.my_role, 'view');
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${dev.id}/commands`, { property: 'relay', value: true }, C.auth)).status, 403);
  assert.equal((await call(apiUrl, 'POST', `/api/scenarios/${sc.id}/run`, {}, C.auth)).status, 403);

  // посторонний не видит ничего
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${dev.id}`, null, D.auth)).status, 404);
  assert.equal((await call(apiUrl, 'GET', `/api/scenarios/${sc.id}`, null, D.auth)).status, 404);
  assert.equal((await call(apiUrl, 'POST', '/api/devices', { name: 'x', home: A.id }, D.auth)).status, 404);
  const acl = async (who) => (await call(hooksUrl, 'POST', '/internal/mqtt/acl', { username: `u:${who.id}`, topic: `dev/${dev.id}/#`, action: 'subscribe' })).body.result;
  assert.deepEqual([await acl(A), await acl(B), await acl(C), await acl(D)], ['allow', 'allow', 'allow', 'deny']);

  // admin: создаёт в доме владельца, но только с устройствами этого дома
  const eDev = (await call(apiUrl, 'POST', '/api/devices', { name: 'Насос', home: A.id }, E.auth)).body.device;
  assert.equal(eDev.owner_id, A.id);
  assert.equal(eDev.my_role, 'admin');
  const eOwn = (await call(apiUrl, 'POST', '/api/devices', { name: 'моё' }, E.auth)).body.device;
  const mk = (devId) => ({ name: 'S', home: A.id, trigger: { type: 'state', device_id: devId, state: 'lost' }, actions: [{ type: 'notify', message: 'x' }] });
  assert.equal((await call(apiUrl, 'POST', '/api/scenarios', mk(eDev.id), E.auth)).body.owner_id, A.id);
  assert.equal((await call(apiUrl, 'POST', '/api/scenarios', mk(eOwn.id), E.auth)).body.error, 'device_not_found');
  assert.equal((await call(apiUrl, 'POST', '/api/bridges', { name: 'Z', type: 'zigbee2mqtt', config: {}, home: A.id }, E.auth)).status, 201);
  assert.equal((await call(apiUrl, 'GET', '/api/bridges', null, A.auth)).body.bridges.length, 1);
  assert.equal((await call(apiUrl, 'GET', '/api/bridges', null, B.auth)).body.bridges.length, 0);

  // уведомления дома видят и получают участники
  const before = (await call(apiUrl, 'GET', '/api/notifications', null, B.auth)).body.notifications.length;
  await db.query("INSERT INTO notifications (owner_id, level, message) VALUES ($1, 'alert', 'Протечка')", [A.id]);
  assert.equal((await call(apiUrl, 'GET', '/api/notifications', null, B.auth)).body.notifications.length, before + 1);
  assert.equal((await call(apiUrl, 'GET', '/api/notifications', null, D.auth)).body.notifications.length, 0);
  const chB = (await call(apiUrl, 'POST', '/api/channels', { type: 'webhook', url: 'https://example.com/b' }, B.auth)).body.channel;
  const chD = (await call(apiUrl, 'POST', '/api/channels', { type: 'webhook', url: 'https://example.com/d' }, D.auth)).body.channel;
  testSent.length = 0;
  await new Dispatcher({ db, log: {}, sleep: async () => {}, senders: testSenders }).kick();
  assert.ok(testSent.some(([id, m]) => id === chB.id && m === 'Протечка'));
  assert.ok(!testSent.some(([id]) => id === chD.id));

  // владелец меняет роль и убирает участника; участник может выйти сам
  const homesB = await call(apiUrl, 'GET', '/api/homes', null, B.auth);
  assert.deepEqual(homesB.body.homes.map((h) => h.role), ['owner', 'control']);
  const members = await call(apiUrl, 'GET', '/api/members', null, A.auth);
  assert.equal(members.body.members.length, 3);
  assert.equal((await call(apiUrl, 'PUT', `/api/members/${B.id}`, { role: 'view' }, A.auth)).body.role, 'view');
  assert.equal((await call(apiUrl, 'PUT', `/api/members/${A.id}`, { role: 'admin' }, B.auth)).status, 404); // не владелец
  assert.equal((await call(apiUrl, 'POST', `/api/devices/${dev.id}/commands`, { property: 'relay', value: true }, B.auth)).status, 403);
  kicked.length = 0;
  assert.equal((await call(apiUrl, 'DELETE', `/api/members/${B.id}`, null, A.auth)).status, 204);
  assert.ok(kicked.includes(`u:${B.id}`));
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${dev.id}`, null, B.auth)).status, 404);
  assert.equal(await acl(B), 'deny');
  assert.equal((await call(apiUrl, 'DELETE', `/api/members/${C.id}?owner=${A.id}`, null, C.auth)).status, 204);
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${dev.id}`, null, C.auth)).status, 404);
});

test('rooms and dashboard on real SQL', { skip }, async () => {
  const reg = async (email) => {
    const r = await call(apiUrl, 'POST', '/api/auth/register', { email, password: 'password123' });
    return { auth: `Bearer ${r.body.token}`, id: r.body.user.id };
  };
  const A = await reg('rooms-a@x.ru');
  const B = await reg('rooms-b@x.ru');
  const V = await reg('rooms-v@x.ru');
  const inv = (await call(apiUrl, 'POST', '/api/invites', { role: 'view' }, A.auth)).body;
  await call(apiUrl, 'POST', '/api/invites/accept', { code: inv.code }, V.auth);
  const dev = (await call(apiUrl, 'POST', '/api/devices', { name: 'Лампа' }, A.auth)).body.device;
  const bdev = (await call(apiUrl, 'POST', '/api/devices', { name: 'Чужая' }, B.auth)).body.device;

  const kitchen = await call(apiUrl, 'POST', '/api/rooms', { name: 'Кухня' }, A.auth);
  assert.equal(kitchen.status, 201);
  assert.equal((await call(apiUrl, 'POST', '/api/rooms', { name: 'Кухня' }, A.auth)).status, 409);
  const hall = (await call(apiUrl, 'POST', '/api/rooms', { name: 'Зал' }, A.auth)).body;
  assert.equal(hall.sort, 1);
  const bRoom = (await call(apiUrl, 'POST', '/api/rooms', { name: 'Б' }, B.auth)).body;
  assert.equal((await call(apiUrl, 'POST', '/api/rooms', { name: 'X', home: A.id }, V.auth)).status, 403); // просмотр не создаёт

  // устройство в комнату своего дома — да, в чужую — нет
  assert.equal((await call(apiUrl, 'PUT', `/api/devices/${dev.id}`, { room_id: kitchen.body.id }, A.auth)).body.room_id, kitchen.body.id);
  assert.equal((await call(apiUrl, 'PUT', `/api/devices/${dev.id}`, { room_id: bRoom.id }, A.auth)).status, 400);
  assert.equal((await call(apiUrl, 'PUT', `/api/devices/${dev.id}`, { name: 'Лампа 2' }, A.auth)).body.room_id, kitchen.body.id); // имя без комнаты — комната не меняется
  const roomsV = await call(apiUrl, 'GET', '/api/rooms', null, V.auth);
  assert.deepEqual(roomsV.body.rooms.map((x) => x.name), ['Кухня', 'Зал']);
  assert.equal((await call(apiUrl, 'PUT', `/api/rooms/${hall.id}`, { sort: 0 }, A.auth)).body.sort, 0);
  assert.equal((await call(apiUrl, 'DELETE', `/api/rooms/${kitchen.body.id}`, null, V.auth)).status, 403);
  assert.equal((await call(apiUrl, 'DELETE', `/api/rooms/${kitchen.body.id}`, null, A.auth)).status, 204);
  assert.equal((await call(apiUrl, 'GET', `/api/devices/${dev.id}`, null, A.auth)).body.room_id, null);

  // главный экран: у каждого свой, только доступные устройства
  assert.equal((await call(apiUrl, 'PUT', '/api/dashboard', { items: [{ device_id: bdev.id, property: 't' }] }, V.auth)).status, 400);
  const items = [{ device_id: dev.id, property: 'relay' }, { device_id: dev.id, property: 'power' }];
  assert.deepEqual((await call(apiUrl, 'PUT', '/api/dashboard', { items }, V.auth)).body.items, items);
  assert.deepEqual((await call(apiUrl, 'GET', '/api/dashboard', null, V.auth)).body.items, items);
  assert.deepEqual((await call(apiUrl, 'GET', '/api/dashboard', null, A.auth)).body.items, []);
  assert.equal((await call(apiUrl, 'PUT', '/api/dashboard', { items: [items[0], items[0]] }, V.auth)).status, 400);
  // убрали из дома — плитки пропадают
  await call(apiUrl, 'DELETE', `/api/members/${V.id}`, null, A.auth);
  assert.deepEqual((await call(apiUrl, 'GET', '/api/dashboard', null, V.auth)).body.items, []);
});

test('bridge devices deleted by user stay hidden; tasmota/shelly configs', { skip }, async () => {
  const reg = await call(apiUrl, 'POST', '/api/auth/register', { email: 'ign@x.ru', password: 'password123' });
  const auth = `Bearer ${reg.body.token}`;
  const br = await call(apiUrl, 'POST', '/api/bridges', { name: 'T', type: 'tasmota', config: { topics: ['hall', 'hall'] } }, auth);
  assert.equal(br.status, 201);
  assert.deepEqual(br.body.bridge.config, { discovery_prefix: 'tasmota/discovery', topics: ['hall'] });
  assert.equal((await call(apiUrl, 'POST', '/api/bridges', { name: 'T', type: 'tasmota', config: { topics: ['a/b'] } }, auth)).status, 400);
  const sh = await call(apiUrl, 'POST', '/api/bridges', { name: 'S', type: 'shelly', config: {} }, auth);
  assert.deepEqual(sh.body.bridge.config, { prefixes: [], gen1: true });
  const bauth = `Bridge ${br.body.bridge.id}:${br.body.token}`;
  const d = await call(apiUrl, 'POST', '/api/bridge/devices', { key: 'a4cf12aabbcc', name: 'Розетка' }, bauth);
  assert.equal((await call(apiUrl, 'DELETE', `/api/devices/${d.body.id}`, null, auth)).status, 204);
  const again = await call(apiUrl, 'POST', '/api/bridge/devices', { key: 'a4cf12aabbcc', name: 'Розетка' }, bauth);
  assert.deepEqual([again.status, again.body.error], [409, 'device_ignored']);
  const ign = await call(apiUrl, 'GET', `/api/bridges/${br.body.bridge.id}/ignored`, null, auth);
  assert.deepEqual(ign.body.ignored.map((x) => [x.key, x.name]), [['a4cf12aabbcc', 'Розетка']]);
  assert.equal((await call(apiUrl, 'DELETE', `/api/bridges/${br.body.bridge.id}/ignored/a4cf12aabbcc`, null, auth)).status, 204);
  assert.equal((await call(apiUrl, 'POST', '/api/bridge/devices', { key: 'a4cf12aabbcc', name: 'Розетка' }, bauth)).status, 201);
  // обычное устройство в «скрытые» не попадает
  const plain = (await call(apiUrl, 'POST', '/api/devices', { name: 'x' }, auth)).body.device;
  await call(apiUrl, 'DELETE', `/api/devices/${plain.id}`, null, auth);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM bridge_ignored');
  assert.equal(rows[0].n, 0);
});

test('Alice: OAuth account linking and smart home API on real SQL', { skip }, async () => {
  const reg = await call(apiUrl, 'POST', '/api/auth/register', { email: 'alice@x.ru', password: 'password123' });
  const auth = `Bearer ${reg.body.token}`;
  const dev = (await call(apiUrl, 'POST', '/api/devices', { name: 'Розетка' }, auth)).body.device;
  await call(apiUrl, 'POST', '/api/provision', { claim_token: (await call(apiUrl, 'POST', `/api/devices/${dev.id}/claim`, {}, auth)).body.claim_token });
  await db.query(`UPDATE devices SET state = 'ready', meta = $2::jsonb, last_values = $3::jsonb WHERE id = $1`, [dev.id,
    JSON.stringify({ props: { power: { type: 'boolean', settable: true }, energy_power: { type: 'float', unit: 'W' } } }),
    JSON.stringify({ power: false, energy_power: 0 })]);
  const redirect = 'https://social.yandex.net/broker/redirect';

  // шаг 1: Яндекс -> /oauth/authorize -> панель
  const a1 = await fetch(`${apiUrl}/oauth/authorize?response_type=code&client_id=yandex-alice&redirect_uri=${encodeURIComponent(redirect)}&state=xyz`, { redirect: 'manual' });
  assert.equal(a1.status, 302);
  assert.match(a1.headers.get('location'), /^\/#\/oauth\?client_id=yandex-alice&redirect_uri=/);
  assert.equal((await fetch(`${apiUrl}/oauth/authorize?response_type=code&client_id=yandex-alice&redirect_uri=${encodeURIComponent('https://evil.com/cb')}`, { redirect: 'manual' })).status, 400);
  // шаг 2: согласие пользователя
  const consent = await call(apiUrl, 'POST', '/api/oauth/authorize', { client_id: 'yandex-alice', redirect_uri: redirect, state: 'xyz' }, auth);
  const back = new URL(consent.body.redirect);
  assert.equal(back.origin + back.pathname, redirect);
  assert.equal(back.searchParams.get('state'), 'xyz');
  const code = back.searchParams.get('code');
  // шаг 3: обмен кода (form-urlencoded, секрет в Basic)
  const token = (form, basic = true) => fetch(`${apiUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(basic ? { authorization: `Basic ${Buffer.from(`yandex-alice:${'s'.repeat(40)}`).toString('base64')}` } : {}) },
    body: new URLSearchParams(form).toString(),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await token({ grant_type: 'authorization_code', code, client_id: 'yandex-alice', client_secret: 'wrong' }, false)).status, 401);
  const t1 = await token({ grant_type: 'authorization_code', code, redirect_uri: redirect });
  assert.equal(t1.status, 200);
  assert.equal(t1.body.token_type, 'bearer');
  assert.equal((await token({ grant_type: 'authorization_code', code })).body.error, 'invalid_grant'); // код одноразовый
  const t2 = await token({ grant_type: 'refresh_token', refresh_token: t1.body.refresh_token });
  assert.equal(t2.status, 200);
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: t1.body.refresh_token })).body.error, 'invalid_grant');

  const Y = (method, path, body, tok = t2.body.access_token) => call(apiUrl, method, `/yandex/v1.0${path}`, body, `Bearer ${tok}`);
  assert.equal((await Y('GET', '/user/devices', null, t1.body.access_token)).status, 401); // старый токен отозван при обновлении
  const list = await Y('GET', '/user/devices');
  assert.equal(list.body.payload.user_id, reg.body.user.id);
  assert.deepEqual(list.body.payload.devices.map((d) => [d.id, d.type]), [[dev.id, 'devices.types.socket']]);
  const q = await Y('POST', '/user/devices/query', { devices: [{ id: dev.id }, { id: 'dffffffffffffffff' }] });
  assert.deepEqual(q.body.payload.devices[0].capabilities, [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: false } }]);
  assert.equal(q.body.payload.devices[1].error_code, 'DEVICE_NOT_FOUND');
  published.length = 0;
  const act = await Y('POST', '/user/devices/action', { payload: { devices: [{ id: dev.id, capabilities: [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: true } }] }] } });
  assert.equal(act.body.payload.devices[0].capabilities[0].state.action_result.status, 'DONE');
  assert.deepEqual(published.at(-1).slice(0, 2), [`dev/${dev.id}/power/set`, 'true']);
  await db.query(`UPDATE devices SET state = 'lost' WHERE id = $1`, [dev.id]);
  assert.equal((await Y('POST', '/user/devices/query', { devices: [{ id: dev.id }] })).body.payload.devices[0].error_code, 'DEVICE_UNREACHABLE');
  assert.equal((await call(apiUrl, 'GET', '/api/oauth/links', null, auth)).body.links.length, 1);
  assert.equal((await Y('POST', '/user/unlink', {})).status, 200);
  assert.equal((await Y('GET', '/user/devices')).status, 401);
});

test('API-токены, канал email, журнал сценариев, /metrics — на настоящем SQL', { skip }, async () => {
  const reg = await call(apiUrl, 'POST', '/api/auth/register', { email: 'port@x.ru', password: 'password123' });
  const J = `Bearer ${reg.body.token}`;
  const uid = reg.body.user.id;

  // ---------- API-токены ----------
  const ro = await call(apiUrl, 'POST', '/api/tokens', { name: 'HA', scope: 'read' }, J);
  assert.equal(ro.status, 201);
  assert.match(ro.body.token, /^iot_[\w-]{40}$/);
  const rw = await call(apiUrl, 'POST', '/api/tokens', { name: 'Node-RED', scope: 'write', expires_days: 30 }, J);
  const RO = `Bearer ${ro.body.token}`;
  const RW = `Bearer ${rw.body.token}`;
  assert.equal((await call(apiUrl, 'GET', '/api/devices', null, RO)).status, 200);
  const roPost = await call(apiUrl, 'POST', '/api/devices', { name: 'x' }, RO);
  assert.deepEqual([roPost.status, roPost.body.error], [403, 'token_read_only']);
  const dev = await call(apiUrl, 'POST', '/api/devices', { name: 'Термостат' }, RW);
  assert.equal(dev.status, 201, 'токен на запись создаёт устройство');
  for (const [m, p] of [['GET', '/api/tokens'], ['GET', '/api/channels'], ['GET', '/api/sessions'], ['GET', '/api/me']]) {
    const r = await call(apiUrl, m, p, null, RW);
    assert.deepEqual([r.status, r.body.error], [403, 'session_required'], `${m} ${p} — только из панели`);
  }
  const list = await call(apiUrl, 'GET', '/api/tokens', null, J);
  assert.equal(list.body.tokens.length, 2);
  assert.ok(!JSON.stringify(list.body).includes(ro.body.token), 'сам токен не отдаётся');
  const mqttTok = (pw) => call(hooksUrl, 'POST', '/internal/mqtt/auth', { username: `u:${uid}`, password: pw, clientid: `web-${uid}-node1` });
  assert.equal((await mqttTok(ro.body.token)).body.result, 'allow', 'токен годится для живых данных по MQTT');
  await db.query("UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [rw.body.id]);
  assert.equal((await call(apiUrl, 'GET', '/api/devices', null, RW)).status, 401, 'истёк');
  assert.equal((await call(apiUrl, 'DELETE', `/api/tokens/${ro.body.id}`, null, J)).status, 204);
  assert.equal((await call(apiUrl, 'GET', '/api/devices', null, RO)).status, 401, 'отозван');
  assert.equal((await mqttTok(ro.body.token)).body.result, 'deny');
  assert.ok(kicked.includes(`u:${uid}`));

  // ---------- канал email ----------
  const start = await call(apiUrl, 'POST', '/api/channels', { type: 'email', email: 'Me@Example.com', min_level: 'warning' }, J);
  assert.equal(start.status, 202);
  const code = /(\d{6})/.exec(mails.at(-1).subject)[1];
  assert.equal(mails.at(-1).to, 'me@example.com');
  assert.equal((await call(apiUrl, 'POST', '/api/channels', { type: 'email', email: 'me@example.com' }, J)).status, 429, 'не чаще раза в минуту');
  assert.equal((await call(apiUrl, 'GET', '/api/channels', null, J)).body.email_pending, 'me@example.com');
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await call(apiUrl, 'POST', '/api/channels/email-confirm', { code: wrong }, J)).status, 400);
  const ok = await call(apiUrl, 'POST', '/api/channels/email-confirm', { code }, J);
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.body.channel.type, ok.body.channel.email, ok.body.channel.min_level], ['email', 'me@example.com', 'warning']);
  assert.equal((await call(apiUrl, 'POST', '/api/channels/email-confirm', { code }, J)).status, 410, 'код одноразовый');
  const chList = await call(apiUrl, 'GET', '/api/channels', null, J);
  assert.equal(chList.body.email_available, true);
  assert.equal(chList.body.email_pending, null);
  // рассылка: диспетчер берёт канал email из БД
  mails.length = 0;
  await db.query("INSERT INTO notifications (owner_id, level, message) VALUES ($1, 'info', 'тихо'), ($1, 'alert', 'Протечка')", [uid]);
  await new Dispatcher({ db, senders: testSenders, log: {} }).kick();
  assert.deepEqual(mails.map((m) => [m.to, m.subject]), [['me@example.com', '[IoT] Тревога']], 'ниже min_level не отправляется');
  assert.equal((await call(apiUrl, 'POST', `/api/channels/${ok.body.channel.id}/test`, {}, J)).status, 200);

  // ---------- журнал сценария ----------
  const sc = await call(apiUrl, 'POST', '/api/scenarios', {
    name: 'Журнал', trigger: { type: 'manual' }, actions: [{ type: 'notify', message: 'x' }],
  }, J);
  assert.equal(sc.status, 201);
  for (let i = 0; i < 205; i++) {
    await saveScenarioRun(db, sc.body.id, {
      status: i % 2 ? 'ok' : 'skipped', cause: { kind: 'manual', n: i }, steps: [{ type: 'notify', ok: true, info: `#${i}` }],
      error: i % 2 ? null : 'условия не выполнены', started_at: new Date(), finished_at: new Date(),
    });
  }
  const runs = await call(apiUrl, 'GET', `/api/scenarios/${sc.body.id}/runs?limit=3`, null, J);
  assert.deepEqual(runs.body.runs.map((r) => r.cause.n), [204, 203, 202]);
  const kept = await db.query('SELECT count(*)::int AS n FROM scenario_runs WHERE scenario_id = $1', [sc.body.id]);
  assert.equal(kept.rows[0].n, 200, 'хранятся последние 200');
  const stranger = await call(apiUrl, 'POST', '/api/auth/register', { email: 'stranger@x.ru', password: 'password123' });
  assert.equal((await call(apiUrl, 'GET', `/api/scenarios/${sc.body.id}/runs`, null, `Bearer ${stranger.body.token}`)).status, 404);

  // ---------- /metrics ----------
  assert.equal((await fetch(`${apiUrl}/metrics`)).status, 401);
  const met = await fetch(`${apiUrl}/metrics`, { headers: { authorization: `Bearer ${config.metricsToken}` } });
  assert.equal(met.status, 200);
  const text = await met.text();
  assert.match(text, /^iot_up\{service="emqx"\} 1$/m);
  assert.match(text, /^iot_emqx_connections 7$/m);
  assert.match(text, /^iot_users \d+$/m);
  assert.match(text, /^iot_notifications_queued \d+$/m);
});
