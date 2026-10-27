// Мост: внешний MQTT-брокер (zigbee2mqtt / ESPHome / свой) <-> платформа.
// Может работать на VPS или дома рядом с zigbee2mqtt — тогда к платформе он ходит через mqtts:8883 и https.
import mqtt from 'mqtt';
import { readFileSync } from 'node:fs';
import { BridgeApi } from './api.js';
import { BridgeCore } from './core.js';
import { Zigbee2MqttAdapter } from './adapters/zigbee2mqtt.js';
import { EsphomeAdapter } from './adapters/esphome.js';
import { GenericAdapter } from './adapters/generic.js';

const env = process.env;
for (const k of ['BRIDGE_ID', 'BRIDGE_TOKEN', 'EXTERNAL_MQTT_URL']) {
  if (!env[k]) {
    console.error(`Missing env ${k}. Создайте мост в панели (раздел «Мосты») и впишите выданные BRIDGE_ID и BRIDGE_TOKEN.`);
    process.exit(1);
  }
}
const API_URL = env.API_URL || 'http://backend:8000';
const MQTT_URL = env.MQTT_URL || 'mqtt://emqx:1883';
const ca = env.PLATFORM_CA_FILE ? readFileSync(env.PLATFORM_CA_FILE) : undefined;

const ADAPTERS = { zigbee2mqtt: Zigbee2MqttAdapter, esphome: EsphomeAdapter, generic: GenericAdapter };

const api = new BridgeApi({ url: API_URL, id: env.BRIDGE_ID, token: env.BRIDGE_TOKEN });
const self = await api.self();
const Adapter = ADAPTERS[self.type];
if (!Adapter) throw new Error(`unknown bridge type ${self.type}`);
console.log(`bridge ${self.id} '${self.name}' type=${self.type}`);

const stateTopic = `bridge/${self.id}/$state`;
const platform = mqtt.connect(MQTT_URL, {
  clientId: self.id,
  username: self.id,
  password: env.BRIDGE_TOKEN,
  reconnectPeriod: 3000,
  will: { topic: stateTopic, payload: 'lost', qos: 1, retain: true },
  ...(ca ? { ca } : {}),
});
const external = mqtt.connect(env.EXTERNAL_MQTT_URL, {
  clientId: `iot-bridge-${self.id.slice(1, 9)}`,
  username: env.EXTERNAL_MQTT_USERNAME || undefined,
  password: env.EXTERNAL_MQTT_PASSWORD || undefined,
  reconnectPeriod: 3000,
});

const core = new BridgeCore({
  api,
  adapter: new Adapter(self.config),
  fw: `bridge:${self.type}`,
  publish: (t, p, o) => platform.publishAsync(t, p, o),
  subscribe: (f) => platform.subscribeAsync(f, { qos: 1 }),
  publishExternal: (t, p) => external.publishAsync(t, p, { qos: 1 }),
  subscribeExternal: (f) => (external.connected ? external.subscribeAsync(f, { qos: 0 }) : Promise.resolve()),
});

let started = false;
platform.on('connect', async () => {
  console.log('platform mqtt connected');
  await platform.publishAsync(stateTopic, 'ready', { qos: 1, retain: true }).catch(() => {});
  if (started) await core.resync();
});
platform.on('error', (e) => console.error('platform mqtt error:', e.message));
platform.on('message', (topic, payload) => {
  core.onCommand(topic, payload).catch((e) => console.error('command failed', e.message));
});

external.on('connect', async () => {
  console.log(`external mqtt connected: ${env.EXTERNAL_MQTT_URL}`);
  if (!started) {
    started = true;
    await core.start();
  } else {
    // после переподключения подписки внешнего брокера восстанавливаем сами
    for (const f of core.externalSubs) await external.subscribeAsync(f, { qos: 0 }).catch(() => {});
  }
});
external.on('error', (e) => console.error('external mqtt error:', e.message));

// Внешние сообщения обрабатываем по очереди: регистрация устройства должна закончиться до его значений
let queue = Promise.resolve();
external.on('message', (topic, payload) => {
  queue = queue.then(() => core.onExternalMessage(topic, payload)).catch((e) => console.error('external message failed', e.message));
});

async function shutdown(sig) {
  console.log(`${sig}: exiting`);
  await platform.publishAsync(stateTopic, 'disconnected', { qos: 1, retain: true }).catch(() => {});
  await Promise.all([platform.endAsync(), external.endAsync()]).catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
