// Ingest: MQTT (shared subscription) -> TimescaleDB, пачками.
import pg from 'pg';
import mqtt from 'mqtt';
import crypto from 'node:crypto';
import { parseMessage } from './parse.js';
import { IngestBuffer } from './buffer.js';
import { writeBatch } from './write.js';
import { Journal } from './journal.js';
import { Metrics, serveMetrics } from '../../shared/metrics.js';

const env = process.env;
for (const k of ['DATABASE_URL', 'MQTT_PASSWORD']) {
  if (!env[k]) throw new Error(`Missing env ${k}`);
}
const FLUSH_MS = Number(env.FLUSH_MS || 1000);
const BATCH_MAX = Number(env.BATCH_MAX || 1000);

const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
db.on('error', (e) => console.error('pg pool error', e.message));

const buffer = new IngestBuffer();
// журнал на томе: сообщения, подтверждённые брокеру, но ещё не записанные в БД, переживают падение процесса
const journal = new Journal(env.JOURNAL_DIR === '' ? null : (env.JOURNAL_DIR || '/journal'));
const recovered = journal.replay();
for (const { ev, time } of recovered) buffer.add(ev, time);
if (recovered.length) console.log(`journal: восстановлено ${recovered.length} событий с прошлого запуска`);
let flushing = false;
let written = 0;
let rejected = 0;
let flushFailures = 0;
let journalErrors = 0;
let messages = 0;
let lastFlushMs = 0;

// ---------- метрики (http://ingest:9100/metrics внутри docker-сети; снаружи — через /metrics бэкенда) ----------
const metrics = new Metrics();
metrics.counterFn('iot_ingest_messages_total', 'Сообщений получено из брокера', () => messages);
metrics.counterFn('iot_ingest_written_rows_total', 'Точек телеметрии записано в БД', () => written);
metrics.counterFn('iot_ingest_rejected_rows_total', 'Строк, отклонённых БД (неверные данные)', () => rejected);
metrics.counterFn('iot_ingest_dropped_rows_total', 'Точек выброшено из-за переполнения буфера', () => buffer.dropped);
metrics.counterFn('iot_ingest_flush_failures_total', 'Неудачных сбросов в БД (пачка возвращена в буфер)', () => flushFailures);
metrics.counterFn('iot_ingest_journal_errors_total', 'Ошибок записи журнала на диск', () => journalErrors);
metrics.gaugeFn('iot_ingest_buffered_rows', 'Точек в буфере, ждут записи', () => buffer.rows.length);
metrics.gaugeFn('iot_ingest_journal_bytes', 'Размер журнала на диске (данные, ещё не записанные в БД)', () => journal.bytes);
metrics.gaugeFn('iot_ingest_last_flush_seconds', 'Длительность последнего сброса в БД', () => lastFlushMs / 1000);
metrics.gaugeFn('iot_ingest_mqtt_connected', 'Подключение ingest к брокеру (1/0)', () => (client.connected ? 1 : 0));
serveMetrics(metrics, Number(env.METRICS_PORT || 9100));

async function flush() {
  if (flushing || buffer.size === 0) return;
  flushing = true;
  const started = Date.now();
  const batch = buffer.take();
  const seq = journal.rotate(); // файл журнала = ровно эта пачка (take и rotate идут подряд, без await)
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
    journal.commit(seq);
  } catch (e) {
    flushFailures++;
    console.error(`flush failed (${batch.rows.length} rows requeued):`, e.message);
    buffer.restore(batch);
  } finally {
    client?.release();
    lastFlushMs = Date.now() - started;
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

// Обработчик синхронный: событие попадает в журнал до того, как mqtt.js отправит PUBACK
client.on('message', (topic, payload) => {
  messages++;
  const ev = parseMessage(topic, payload);
  if (!ev) return;
  const now = new Date();
  try {
    journal.append(ev, now);
  } catch (e) {
    journalErrors++;
    console.error('journal append failed', e.message);
  }
  buffer.add(ev, now);
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
