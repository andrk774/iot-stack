// Настоящий TimescaleDB: схема без заглушек, все миграции (в том числе непрерывный агрегат), телеметрия за месяцы.
// Запуск: PG_TS_URL=postgres://iot@127.0.0.1:54331/postgres node --test test/timescale.integration.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from '../../devtools/pgwire.js';
import { migrate, listMigrations, backfillAggregates } from '../src/migrate.js';
import { createServer, Router } from '../src/http.js';
import { publicRoutes } from '../src/routes/public.js';
import { accountRoutes } from '../src/routes/account.js';
import { IngestBuffer, batchToQueries } from '../../ingest/src/buffer.js';
import { parseMessage } from '../../ingest/src/parse.js';

const URL_ = process.env.PG_TS_URL;
const skip = !URL_ && 'PG_TS_URL не задан (нужен PostgreSQL с TimescaleDB)';
const dbName = `iot_ts_${Date.now()}`;
const config = { jwtSecret: 'j'.repeat(40), jwtTtlSec: 3600, allowRegistration: true, maxDevicesPerUser: 5, claimTtlMin: 30, publicHost: 'iot.test', mqttPublicPort: 8883, serviceUsers: {} };
let admin; let db; let api; let apiUrl;

before(async () => {
  if (skip) return;
  admin = new Pool(URL_);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(URL_);
  u.pathname = `/${dbName}`;
  db = new Pool(u.toString());
  await db.query(await readFile(new URL('../../db/init/01-schema.sql', import.meta.url), 'utf8'));
  await migrate(db, { log: {} });
  await migrate(db, { log: {} });
  api = createServer(new Router().use(accountRoutes({ db, config })).use(publicRoutes({ db, mqtt: { connected: true, publish: async () => {} }, config })),
    { log: { error: (...a) => console.error(...a) } });
  await new Promise((r) => api.listen(0, r));
  apiUrl = `http://127.0.0.1:${api.address().port}`;
});

after(async () => {
  if (skip) return;
  api.close();
  await db.end();
  await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await admin.end();
});

const call = async (method, path, body, auth) => {
  const res = await fetch(apiUrl + path, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: auth } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* csv */ }
  return { status: res.status, body: parsed, headers: res.headers };
};

test('real TimescaleDB: schema, migrations, policies', { skip }, async () => {
  const { rows } = await db.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((r) => r.version), (await listMigrations()).map((m) => m.version));
  const { rows: ht } = await db.query("SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1");
  assert.ok(ht.some((r) => r.hypertable_name === 'telemetry'));
  const { rows: ca } = await db.query("SELECT view_name, materialized_only FROM timescaledb_information.continuous_aggregates");
  assert.deepEqual(ca.map((r) => [r.view_name, r.materialized_only]), [['telemetry_hourly', false]]);
  const { rows: jobs } = await db.query('SELECT proc_name FROM timescaledb_information.jobs ORDER BY 1');
  const procs = jobs.map((j) => j.proc_name);
  for (const p of ['policy_compression', 'policy_refresh_continuous_aggregate', 'policy_retention']) assert.ok(procs.includes(p), p);
  assert.equal(procs.filter((p) => p === 'policy_retention').length, 2); // сырые и почасовые
});

test('hourly aggregates: backfill, long ranges, real-time tail, CSV', { skip }, async () => {
  const reg = await call('POST', '/api/auth/register', { email: 'ts@x.ru', password: 'password123' });
  const auth = `Bearer ${reg.body.token}`;
  const dev = (await call('POST', '/api/devices', { name: 'Теплица' }, auth)).body.device;
  const D = dev.id;
  // 40 суток: каждые 10 минут, значение = номер суток (среднее за сутки известно точно)
  const now = Date.now();
  const start = now - 40 * 86400_000;
  const buf = new IngestBuffer();
  for (let t = start; t < now - 2 * 3600_000; t += 600_000) {
    const day = Math.floor((t - start) / 86400_000);
    buf.add(parseMessage(`dev/${D}/temperature`, Buffer.from(String(day))), new Date(t));
  }
  for (const [sql, params] of batchToQueries(buf.take())) await db.query(sql, params);

  assert.equal(await backfillAggregates(db, { log: {} }), true);
  assert.equal(await backfillAggregates(db, { log: {} }), false); // один раз

  // свежие данные (последний час) ещё не материализованы — видны благодаря real-time агрегации
  const tail = new IngestBuffer();
  tail.add(parseMessage(`dev/${D}/temperature`, Buffer.from('100')), new Date(now - 10 * 60_000));
  for (const [sql, params] of batchToQueries(tail.take())) await db.query(sql, params);

  const from = new Date(start).toISOString();
  const to = new Date(now).toISOString();
  const daily = await call('GET', `/api/devices/${D}/telemetry?property=temperature&bucket=1d&from=${from}&to=${to}`, null, auth);
  assert.equal(daily.status, 200);
  assert.equal(daily.body.source, 'hourly');
  const total = daily.body.points.reduce((s, p) => s + p.n, 0);
  assert.ok(daily.body.points.some((p) => p.max === 100), 'хвост последнего часа виден');
  // точное среднее по часу из агрегата совпадает с сырыми данными
  const hourly = await call('GET', `/api/devices/${D}/telemetry?property=temperature&bucket=1h&from=${new Date(start + 5 * 86400_000).toISOString()}&to=${new Date(start + 5 * 86400_000 + 3 * 3600_000).toISOString()}`, null, auth);
  assert.deepEqual(hourly.body.points.map((p) => [Number(p.avg), p.n]), [[5, 6], [5, 6], [5, 6]]);
  // агрегат берёт часы целиком: неполный первый час (до from) не входит
  const raw = await db.query(
    "SELECT count(*)::int AS n FROM telemetry WHERE device_id = $1 AND time >= date_trunc('hour', $2::timestamptz) + INTERVAL '1 hour' * (CASE WHEN date_trunc('hour', $2::timestamptz) < $2::timestamptz THEN 1 ELSE 0 END)",
    [D, new Date(start)]);
  assert.equal(total, raw.rows[0].n);

  // диапазоны: год с шагом в сутки — можно, 100 дней по 5 минут — нельзя
  const yearAgo = new Date(now - 365 * 86400_000).toISOString();
  assert.equal((await call('GET', `/api/devices/${D}/telemetry?property=temperature&bucket=1d&from=${yearAgo}&to=${to}`, null, auth)).status, 200);
  const d100 = new Date(now - 100 * 86400_000).toISOString();
  assert.equal((await call('GET', `/api/devices/${D}/telemetry?property=temperature&bucket=5m&from=${d100}&to=${to}`, null, auth)).status, 400);
  assert.equal((await call('GET', `/api/devices/${D}/telemetry?property=temperature&bucket=90m&from=${d100}&to=${to}`, null, auth)).status, 400);

  // CSV
  const csv = await call('GET', `/api/devices/${D}/telemetry.csv?properties=temperature&bucket=1d&from=${from}&to=${to}&format=excel`, null, auth);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename=".+\.csv"/);
  const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'time;property;avg;min;max;count');
  assert.equal(lines.length, daily.body.points.length + 1);
  const rawCsv = await call('GET', `/api/devices/${D}/telemetry.csv?properties=temperature,humidity&from=${new Date(now - 3600_000 * 3).toISOString()}&to=${to}`, null, auth);
  assert.equal(rawCsv.body.split('\r\n')[0], 'time,property,value');
  assert.ok(rawCsv.body.includes(',temperature,100'));
  assert.equal((await call('GET', `/api/devices/${D}/telemetry.csv?properties=Bad/Name`, null, auth)).status, 400);
});
