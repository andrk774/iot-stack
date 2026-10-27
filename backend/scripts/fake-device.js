// Эмулятор устройства для проверки всей цепочки без ESP32.
// Запуск внутри контейнера бэкенда (ходит во внутреннюю сеть):
//   docker compose exec backend node scripts/fake-device.js <claim_token>
// Повторный запуск с теми же учётками:
//   docker compose exec backend node scripts/fake-device.js --id d... --password ...
import mqtt from 'mqtt';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

let id = opt('id');
let password = opt('password');

if (!id) {
  const claimToken = args[0];
  if (!claimToken) {
    console.error('usage: fake-device.js <claim_token> | --id <id> --password <pass>');
    process.exit(1);
  }
  const res = await fetch('http://127.0.0.1:8000/api/provision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claim_token: claimToken }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('provision failed:', res.status, data);
    process.exit(1);
  }
  ({ device_id: id } = data);
  ({ password } = data.mqtt);
  console.log(`provisioned: --id ${id} --password ${password}`);
}

const base = `dev/${id}`;
const client = mqtt.connect(process.env.FAKE_MQTT_URL || 'mqtt://emqx:1883', {
  clientId: id,
  username: id,
  password,
  will: { topic: `${base}/$state`, payload: 'lost', qos: 1, retain: true },
});

let relay = false;
const meta = {
  name: 'Fake device',
  fw: 'fake-1.0',
  props: {
    temperature: { type: 'float', unit: '°C' },
    humidity: { type: 'float', unit: '%' },
    relay: { type: 'boolean', settable: true },
  },
};

client.on('connect', async () => {
  console.log('mqtt connected');
  await client.publishAsync(`${base}/$state`, 'init', { qos: 1, retain: true });
  await client.publishAsync(`${base}/$meta`, JSON.stringify(meta), { qos: 1, retain: true });
  await client.subscribeAsync(`${base}/+/set`, { qos: 1 });
  await client.publishAsync(`${base}/relay`, String(relay), { qos: 1 });
  await client.publishAsync(`${base}/$state`, 'ready', { qos: 1, retain: true });
});

client.on('message', async (topic, payload) => {
  if (topic === `${base}/relay/set`) {
    const v = payload.toString().trim().toLowerCase();
    relay = v === 'true' || v === '1' || v === 'on';
    console.log(`relay -> ${relay}`);
    await client.publishAsync(`${base}/relay`, String(relay), { qos: 1 });
  }
});

client.on('error', (e) => console.error('mqtt error:', e.message));

setInterval(() => {
  if (!client.connected) return;
  const t = (22 + Math.random() * 3).toFixed(2);
  const h = (40 + Math.random() * 10).toFixed(1);
  client.publish(`${base}/temperature`, t, { qos: 0 });
  client.publish(`${base}/humidity`, h, { qos: 0 });
  console.log(`temperature=${t} humidity=${h}`);
}, 5000);
