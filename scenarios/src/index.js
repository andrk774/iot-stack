// scenario-runner: слушает шину, выполняет сценарии из таблицы scenarios.
import pg from 'pg';
import mqtt from 'mqtt';
import crypto from 'node:crypto';
import { Engine } from './engine.js';

const env = process.env;
for (const k of ['DATABASE_URL', 'MQTT_PASSWORD']) {
  if (!env[k]) throw new Error(`Missing env ${k}`);
}
const DEVICE_RE = /^d[0-9a-f]{16}$/;

const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
db.on('error', (e) => console.error('pg pool error', e.message));

const client = mqtt.connect(env.MQTT_URL || 'mqtt://emqx:1883', {
  username: 'scenarios',
  password: env.MQTT_PASSWORD,
  clientId: `scenarios-${crypto.randomBytes(4).toString('hex')}`,
  reconnectPeriod: 3000,
});

const engine = new Engine({
  defaultTz: env.TZ || 'UTC',
  log: console,
  publishSet: async (deviceId, property, value) => {
    if (!client.connected) throw new Error('mqtt not connected');
    await client.publishAsync(`dev/${deviceId}/${property}/set`, String(value), { qos: 1 });
  },
  notify: async (s, level, message) => {
    await db.query('INSERT INTO notifications (owner_id, scenario_id, level, message) VALUES ($1, $2, $3, $4)',
      [s.owner_id, s.id, level, message.slice(0, 1000)]);
  },
  saveRun: async (s, error) => {
    await db.query('UPDATE scenarios SET last_run_at = now(), last_error = $2 WHERE id = $1', [s.id, error]);
  },
});

async function reload() {
  const { rows: scenarios } = await db.query(
    'SELECT id, owner_id, name, enabled, trigger, conditions, actions, cooldown_sec, last_run_at FROM scenarios WHERE enabled',
  );
  const ids = new Set();
  for (const s of scenarios) {
    if (s.trigger?.device_id) ids.add(s.trigger.device_id);
    for (const c of s.conditions || []) ids.add(c.device_id);
    for (const a of s.actions || []) if (a.device_id) ids.add(a.device_id);
  }
  const { rows: devices } = ids.size
    ? await db.query('SELECT id, name, state, meta, last_values FROM devices WHERE id = ANY($1::text[])', [[...ids]])
    : { rows: [] };
  engine.load(scenarios, devices);
  console.log(`loaded ${scenarios.length} scenarios, watching ${devices.length} devices`);
}

let reloadTimer;
const scheduleReload = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => reload().catch((e) => console.error('reload failed', e.message)), 300);
};

// LISTEN на отдельном соединении; при обрыве — переподключение
async function listen() {
  const c = new pg.Client({ connectionString: env.DATABASE_URL });
  c.on('error', (e) => console.error('listen connection error', e.message));
  c.on('end', () => setTimeout(() => listen().catch(() => {}), 3000));
  c.on('notification', (n) => {
    if (n.channel === 'scenarios_changed') scheduleReload();
    if (n.channel === 'scenario_run' && n.payload) Promise.all(engine.runManual(n.payload)).catch(() => {});
  });
  await c.connect();
  await c.query('LISTEN scenarios_changed');
  await c.query('LISTEN scenario_run');
  scheduleReload(); // могли пропустить изменения, пока были отключены
}

client.on('connect', async () => {
  console.log('mqtt connected');
  try {
    await client.subscribeAsync('$share/scenarios/dev/+/+', { qos: 1 });
  } catch (e) {
    console.error('subscribe failed', e.message);
  }
});
client.on('error', (e) => console.error('mqtt error', e.message));
client.on('message', (topic, payload) => {
  const parts = topic.split('/');
  if (parts.length !== 3 || !DEVICE_RE.test(parts[1])) return;
  if (parts[2].startsWith('$') && parts[2] !== '$state' && parts[2] !== '$meta') return; // $ota и прочее служебное
  if (payload.includes(0)) return; // NUL не запишется в уведомление (PostgreSQL text)
  const text = payload.toString('utf8').trim();
  if (parts[2] === '$meta') {
    try { engine.onMeta(parts[1], JSON.parse(payload.toString('utf8'))); } catch { /* мусор */ }
    return;
  }
  if (text.length > 256) return;
  const run = parts[2] === '$state' ? engine.onState(parts[1], text) : engine.onValue(parts[1], parts[2], text);
  Promise.all(run).catch((e) => console.error('run failed', e.message));
});

// Расписания: каждую минуту, выровнено на начало минуты
let lastMinute = -1;
function startTicker() {
  const tick = () => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute !== lastMinute) {
      lastMinute = minute;
      Promise.all(engine.tick(now)).catch((e) => console.error('tick failed', e.message));
    }
    setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  };
  setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
}

await reload().catch((e) => console.error('initial load failed', e.message));
await listen().catch((e) => console.error('listen failed', e.message));
setInterval(scheduleReload, 5 * 60_000);
startTicker();

async function shutdown(sig) {
  console.log(`${sig}: exiting`);
  await client.endAsync().catch(() => {});
  await db.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
