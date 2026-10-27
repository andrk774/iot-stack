// writeBatch на настоящем PostgreSQL: одна плохая строка не блокирует остальные.
// PG_TEST_URL=postgres://iot@127.0.0.1:54329/postgres node --test test/pg.integration.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../../devtools/pgwire.js';
import { writeBatch, isDataError } from '../src/write.js';
import { IngestBuffer } from '../src/buffer.js';
import { parseMessage } from '../src/parse.js';

const URL_ = process.env.PG_TEST_URL;
const skip = !URL_ && 'PG_TEST_URL не задан';
const dbName = `iot_ingest_${Date.now()}`;
const D = 'd0123456789abcdef';
let admin; let db;

before(async () => {
  if (skip) return;
  admin = new Pool(URL_);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(URL_);
  u.pathname = `/${dbName}`;
  db = new Pool(u.toString());
  await db.query(`
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE bridges (id text PRIMARY KEY, state text, last_seen timestamptz);
    CREATE TABLE devices (id text PRIMARY KEY, bridge_id text, state text, meta jsonb,
      last_values jsonb NOT NULL DEFAULT '{}'::jsonb, last_seen timestamptz);
    CREATE TABLE telemetry (time timestamptz NOT NULL, device_id text NOT NULL, property text NOT NULL,
      value_num double precision, value_text text);
    INSERT INTO devices (id) VALUES ('${D}');`);
});

after(async () => {
  if (skip) return;
  await db.end();
  await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await admin.end();
});

test('poisoned rows are isolated and dropped, the rest is written', { skip }, async () => {
  const buf = new IngestBuffer();
  for (let i = 0; i < 9; i++) buf.add(parseMessage(`dev/${D}/t`, Buffer.from(String(i))));
  const batch = buf.take();
  // в обход фильтра: строка с NUL посередине пачки и $meta с \u0000
  batch.rows.splice(4, 0, { time: new Date(), deviceId: D, property: 'label', num: null, text: 'bad\0value' });
  batch.metas.set(D, { name: 'x\u0000' });
  batch.latest.get(D).label = 'bad\0value';

  const c = await db.connect();
  const res = await writeBatch(c, batch, {});
  assert.equal(res.written, 9);
  assert.equal(res.dropped.length, 3); // строка телеметрии, last_values, $meta
  assert.match(res.dropped[0].what, /telemetry .*\/label/);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM telemetry');
  assert.equal(rows[0].n, 9);

  // следующая пачка пишется нормально — запись не встала
  const b2 = new IngestBuffer();
  b2.add(parseMessage(`dev/${D}/t`, Buffer.from('42')));
  b2.add(parseMessage(`dev/${D}/$state`, Buffer.from('ready')));
  const r2 = await writeBatch(c, b2.take(), {});
  assert.deepEqual([r2.written, r2.dropped.length], [1, 0]);
  const { rows: [d] } = await db.query('SELECT state, last_values FROM devices WHERE id = $1', [D]);
  assert.equal(d.state, 'ready');
  assert.equal(d.last_values.t, 42);
});

test('non-data errors propagate so the batch is requeued', { skip }, async () => {
  const c = await db.connect();
  await c.query('ALTER TABLE telemetry RENAME TO telemetry_x');
  try {
    const buf = new IngestBuffer();
    buf.add(parseMessage(`dev/${D}/t`, Buffer.from('1')));
    await assert.rejects(writeBatch(c, buf.take(), {}), (e) => !isDataError(e) && e.code === '42P01');
  } finally {
    await c.query('ALTER TABLE telemetry_x RENAME TO telemetry');
  }
});
