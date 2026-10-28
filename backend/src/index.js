import pg from 'pg';
import mqttLib from 'mqtt';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { createServer, Router } from './http.js';
import { migrate } from './migrate.js';
import { createEmqxAdmin } from './emqx.js';
import { publicRoutes } from './routes/public.js';
import { scenarioRoutes } from './routes/scenarios.js';
import { bridgeRoutes } from './routes/bridges.js';
import { internalRoutes } from './routes/internal.js';
import { channelRoutes, linkTelegramChat, unlinkTelegramChat } from './routes/channels.js';
import { TelegramApi, TelegramBot } from './notify/telegram.js';
import { Dispatcher, makeSenders } from './notify/dispatcher.js';

const config = loadConfig();

const db = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
db.on('error', (e) => console.error('pg pool error', e.message));

// Миграции до приёма запросов; при ошибке контейнер перезапустится (restart: unless-stopped)
for (let attempt = 1; ; attempt++) {
  try {
    await migrate(db);
    break;
  } catch (e) {
    console.error(`migrate failed (attempt ${attempt}): ${e.message}`);
    if (attempt >= 10) process.exit(1);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// MQTT-клиент бэкенда: отправка команд устройствам.
// EMQX аутентифицирует его через наш же внутренний хук, поэтому стартуем HTTP раньше.
const mqttClient = mqttLib.connect(config.mqttUrl, {
  username: 'backend',
  password: config.serviceUsers.backend,
  clientId: `backend-${crypto.randomBytes(4).toString('hex')}`,
  reconnectPeriod: 3000,
  connectTimeout: 10_000,
});
mqttClient.on('connect', () => console.log('mqtt connected'));
mqttClient.on('error', (e) => console.error('mqtt error', e.message));

const mqtt = {
  get connected() { return mqttClient.connected; },
  publish: (topic, payload, opts) => mqttClient.publishAsync(topic, payload, opts),
};

const emqx = createEmqxAdmin({ url: config.emqxApiUrl, key: config.emqxApiKey, secret: config.emqxApiSecret });
if (!emqx.enabled) console.warn('EMQX_API_KEY/EMQX_API_SECRET не заданы: отзыв доступа не разрывает открытые MQTT-сессии');

// ---------- уведомления ----------
const telegram = new TelegramApi({ apiUrl: config.telegramApiUrl });
const telegramBot = config.telegramBotToken
  ? new TelegramBot({
    api: telegram,
    token: config.telegramBotToken,
    linkChat: (code, chat) => linkTelegramChat(db, code, chat),
    unlinkChat: (chatId) => unlinkTelegramChat(db, chatId),
  })
  : null;
const senders = makeSenders({ telegram, platformBotToken: config.telegramBotToken, allowPrivate: config.webhookAllowPrivate });
const dispatcher = new Dispatcher({ db, senders });

// LISTEN на отдельном соединении; при обрыве — переподключение
let listener = null;
async function listenNotifications() {
  const c = new pg.Client({ connectionString: config.databaseUrl });
  c.on('error', (e) => console.error('listen connection error', e.message));
  c.on('end', () => { listener = null; setTimeout(() => listenNotifications().catch(() => {}), 3000); });
  c.on('notification', () => dispatcher.kick());
  await c.connect();
  await c.query('LISTEN notification_new');
  listener = c;
  dispatcher.kick(); // то, что накопилось, пока соединения не было
}
listenNotifications().catch((e) => {
  console.error('listen failed', e.message);
  setTimeout(() => listenNotifications().catch(() => {}), 3000);
});
const sweepTimer = setInterval(() => dispatcher.kick(), 30_000);
telegramBot?.start();

const api = new Router()
  .use(publicRoutes({ db, mqtt, config, emqx }))
  .use(scenarioRoutes({ db, config }))
  .use(bridgeRoutes({ db, config, emqx }))
  .use(channelRoutes({ db, config, senders, telegramBot }));

const publicServer = createServer(api);
const internalServer = createServer(internalRoutes({ db, config }), { bodyLimit: 8 * 1024 });

publicServer.listen(config.publicPort, '0.0.0.0', () => console.log(`api on :${config.publicPort}`));
internalServer.listen(config.internalPort, '0.0.0.0', () => console.log(`internal hooks on :${config.internalPort}`));

async function shutdown(sig) {
  console.log(`${sig} received, shutting down`);
  publicServer.close();
  internalServer.close();
  clearInterval(sweepTimer);
  telegramBot?.stop();
  if (listener) { listener.removeAllListeners('end'); await listener.end().catch(() => {}); }
  await mqttClient.endAsync().catch(() => {});
  await db.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
