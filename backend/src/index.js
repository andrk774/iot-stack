import pg from 'pg';
import mqttLib from 'mqtt';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { createServer, Router } from './http.js';
import { migrate, backfillAggregates } from './migrate.js';
import { createEmqxAdmin } from './emqx.js';
import { publicRoutes } from './routes/public.js';
import { scenarioRoutes } from './routes/scenarios.js';
import { bridgeRoutes } from './routes/bridges.js';
import { internalRoutes } from './routes/internal.js';
import { channelRoutes, linkTelegramChat, unlinkTelegramChat } from './routes/channels.js';
import { TelegramApi, TelegramBot } from './notify/telegram.js';
import { Dispatcher, makeSenders } from './notify/dispatcher.js';
import { createWebPush } from './notify/webpush.js';
import { otaRoutes, handleOtaStatus } from './routes/ota.js';
import { accountRoutes } from './routes/account.js';
import { homeRoutes } from './routes/homes.js';
import { roomRoutes } from './routes/rooms.js';
import { yandexRoutes } from './routes/yandex.js';
import { YandexNotifier } from './yandex/notify.js';
import { sendMail } from './notify/smtp.js';
import { tokenRoutes } from './routes/tokens.js';
import { metricsRoutes } from './routes/metrics.js';
import { Metrics } from '../../shared/metrics.js';

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

backfillAggregates(db).catch((e) => console.error(`telemetry_hourly backfill: ${e.message}`));

// MQTT-клиент бэкенда: отправка команд устройствам.
// EMQX аутентифицирует его через наш же внутренний хук, поэтому стартуем HTTP раньше.
const mqttClient = mqttLib.connect(config.mqttUrl, {
  username: 'backend',
  password: config.serviceUsers.backend,
  clientId: `backend-${crypto.randomBytes(4).toString('hex')}`,
  reconnectPeriod: 3000,
  connectTimeout: 10_000,
});
const yandexNotifier = new YandexNotifier({ db, skillId: config.yandex.skillId, token: config.yandex.skillToken, clientId: config.yandex.clientId });

mqttClient.on('connect', async () => {
  console.log('mqtt connected');
  if (yandexNotifier.enabled) {
    await mqttClient.subscribeAsync('$share/yandex/dev/+/+', { qos: 0 }).catch((e) => console.error('subscribe failed', e.message));
  }
  // статусы OTA от устройств; $share — при нескольких репликах сообщение получит одна
  await mqttClient.subscribeAsync('$share/backend/dev/+/$ota', { qos: 1 }).catch((e) => console.error('subscribe failed', e.message));
});
mqttClient.on('message', (topic, payload) => {
  const parts = topic.split('/');
  if (parts.length === 3 && parts[0] === 'dev' && parts[2] === '$ota') {
    handleOtaStatus({ db, mqtt }, parts[1], payload).catch((e) => console.error('ota status', e.message));
  } else if (parts.length === 3 && parts[0] === 'dev' && parts[2] !== '$meta') {
    yandexNotifier.touch(parts[1]);
  }
});
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
let webpush = null;
try {
  webpush = await createWebPush({ db, subject: config.webpushSubject, allowPrivate: config.webhookAllowPrivate });
} catch (e) {
  console.error(`web push disabled: ${e.message}`);
}
// почта: SMTP_URL + SMTP_FROM; без них канал email недоступен
const mail = config.smtpUrl && config.smtpFrom
  ? { send: (to, subject, text) => sendMail(config.smtpUrl, { from: config.smtpFrom, to, subject, text }, { name: config.publicHost }) }
  : null;
const senders = makeSenders({
  telegram, platformBotToken: config.telegramBotToken, webpush, mail, publicHost: config.publicHost,
  allowPrivate: config.webhookAllowPrivate,
});
// ---------- метрики бэкенда (отдаются вместе с остальными по /metrics) ----------
const httpMetrics = new Metrics();
const mRequests = httpMetrics.counter('iot_backend_http_requests_total', 'Запросы к API по классу ответа (2xx, 4xx, 5xx)');
const mNotify = httpMetrics.counter('iot_notify_deliveries_total', 'Доставка уведомлений по типу канала и результату');
const dispatcher = new Dispatcher({ db, senders, onResult: (type, ok) => mNotify.inc({ channel: type, result: ok ? 'ok' : 'error' }) });

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
  .use(accountRoutes({ db, config, emqx }))
  .use(homeRoutes({ db, config, emqx }))
  .use(roomRoutes({ db, config }))
  .use(yandexRoutes({ db, mqtt, config }))
  .use(publicRoutes({ db, mqtt, config, emqx }))
  .use(scenarioRoutes({ db, config }))
  .use(bridgeRoutes({ db, config, emqx }))
  .use(channelRoutes({ db, config, senders, telegramBot, webpush, mail }))
  .use(otaRoutes({ db, mqtt, config }))
  .use(tokenRoutes({ db, config, emqx }))
  .use(metricsRoutes({ db, config, emqx, httpMetrics }));
if (!config.metricsToken) console.log('METRICS_TOKEN не задан: /metrics выключен');
if (!mail) console.log('SMTP_URL/SMTP_FROM не заданы: канал email выключен');

const publicServer = createServer(api, { onResponse: (status) => mRequests.inc({ code: `${String(status)[0]}xx` }) });
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
