// Ingest: MQTT (shared subscription) -> TimescaleDB, пачками.
import pg from 'pg';
import mqtt from 'mqtt';
import crypto from 'node:crypto';
import { parseMessage } from './parse.js';
import { IngestBuffer } from './buffer.js';
import { writeBatch } from './write.js';

const env = process.env;
for (const k of ['DATABASE_URL', 'MQTT_PASSWORD']) {
  if (!env[k]) throw new Error(`Missing env ${k}`);
}
const FLUSH_MS = Number(env.FLUSH_MS || 1000);
const BATCH_MAX = Number(env.BATCH_MAX || 1000);

const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
db.on('error', (e) => console.error('pg pool error', e.message));

const buffer = new IngestBuffer();
let flushing = false;
let written = 0;
let rejected = 0;

async function flush() {
  if (flushing || buffer.size === 0) return;
  flushing = true;
  const batch = buffer.take();
  const client = await db.connect().catch((e) => {
    console.error('db connect failed', e.message);
    return null;
  });
  try {
    if (!client) throw new Error('no db connection');
    // плохие строки writeBatch выбрасывает сам; сюда попадают только ошибки связи/БД
    const res = await writeBatch(client, batch);
    written += res.written;
    rejected += res.dropped.length;
  } catch (e) {
    console.error(`flush failed (${batch.rows.length} rows requeued):`, e.message);
    buffer.restore(batch);
  } finally {
    client?.release();
    flushing = false;
  }
}

const timer = setInterval(flush, FLUSH_MS);
setInterval(() => {
  console.log(`stats: written=${written} buffered=${buffer.rows.length} dropped=${buffer.dropped} rejected=${rejected}`);
}, 60_000);

// Shared subscription: можно запустить несколько реплик ingest — EMQX раскидает сообщения.
const client = mqtt.connect(env.MQTT_URL || 'mqtt://emqx:1883', {
  username: 'ingest',
  password: env.MQTT_PASSWORD,
  clientId: `ingest-${crypto.randomBytes(4).toString('hex')}`,
  reconnectPeriod: 3000,
});

client.on('connect', async () => {
  console.log('mqtt connected');
  try {
    await client.subscribeAsync('$share/ingest/dev/+/+', { qos: 1 });
    await client.subscribeAsync('$share/ingest/bridge/+/$state', { qos: 1 });
  } catch (e) {
    console.error('subscribe failed', e.message);
  }
});
client.on('error', (e) => console.error('mqtt error', e.message));

client.on('message', (topic, payload) => {
  const ev = parseMessage(topic, payload);
  if (!ev) return;
  buffer.add(ev);
  if (buffer.rows.length >= BATCH_MAX) flush();
});

async function shutdown(sig) {
  console.log(`${sig}: flushing and exiting`);
  clearInterval(timer);
  await client.endAsync().catch(() => {});
  while (flushing) await new Promise((r) => setTimeout(r, 50));
  await flush();
  await db.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
