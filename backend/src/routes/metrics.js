// /metrics для Prometheus: одна точка сбора на всю платформу.
// Бэкенд собирает свои метрики, сводку из БД, статистику EMQX (REST API) и подтягивает /metrics
// сервисов ingest и scenarios из внутренней сети. Доступ — Authorization: Bearer <METRICS_TOKEN>;
// без METRICS_TOKEN эндпоинт выключен (404).
import { Router, HttpError, RawBody } from '../http.js';
import { safeEqual } from '../security.js';
import { Metrics } from '../../../shared/metrics.js';

// поля REST API EMQX -> имя метрики, тип, описание
const EMQX_FIELDS = [
  ['connections.count', 'iot_emqx_connections', 'gauge', 'Подключённых клиентов MQTT (включая сервисы)'],
  ['live_connections.count', 'iot_emqx_live_connections', 'gauge', 'Активных соединений MQTT'],
  ['subscriptions.count', 'iot_emqx_subscriptions', 'gauge', 'Подписок'],
  ['retained.count', 'iot_emqx_retained', 'gauge', 'Retained-сообщений'],
  ['messages.received', 'iot_emqx_messages_received_total', 'counter', 'Сообщений принято брокером'],
  ['messages.sent', 'iot_emqx_messages_sent_total', 'counter', 'Сообщений отправлено брокером'],
  ['messages.dropped', 'iot_emqx_messages_dropped_total', 'counter', 'Сообщений отброшено брокером'],
  ['authentication.failure', 'iot_emqx_auth_failures_total', 'counter', 'Неудачных входов MQTT'],
  ['authorization.deny', 'iot_emqx_acl_denied_total', 'counter', 'Отказов ACL'],
];

/**
 * @param {{ db, config: { metricsToken: string, metricsSources: Record<string,string> },
 *           emqx?: { stats: () => Promise<object|null> }, httpMetrics: Metrics, fetchImpl?, log? }} deps
 */
export function metricsRoutes({ db, config, emqx, httpMetrics, fetchImpl = globalThis.fetch, log = console }) {
  const r = new Router();

  const scrape = async (url) => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      log.warn?.(`metrics ${url}: ${e.message}`);
      return null;
    }
  };

  r.get('/metrics', async ({ req }) => {
    if (!config.metricsToken) throw new HttpError(404, 'not_found');
    const h = req.headers.authorization || '';
    if (!safeEqual(h.startsWith('Bearer ') ? h.slice(7) : '', config.metricsToken)) throw new HttpError(401, 'unauthorized');

    const m = new Metrics();
    const up = m.gauge('iot_up', 'Источник метрик доступен (1/0)');
    up.set({ service: 'backend' }, 1);

    const [{ rows: [db0] }, stats, ...remote] = await Promise.all([
      db.query(`SELECT
        (SELECT count(*) FROM users)::int AS users,
        (SELECT count(*) FROM devices)::int AS devices,
        (SELECT count(*) FROM devices WHERE state = 'ready')::int AS devices_ready,
        (SELECT count(*) FROM devices WHERE state IN ('lost', 'disconnected'))::int AS devices_lost,
        (SELECT count(*) FROM bridges)::int AS bridges,
        (SELECT count(*) FROM scenarios WHERE enabled)::int AS scenarios_enabled,
        (SELECT count(*) FROM scenarios WHERE enabled AND last_error IS NOT NULL)::int AS scenarios_failing,
        (SELECT count(*) FROM notifications WHERE created_at > now() - interval '1 hour')::int AS notifications_hour,
        (SELECT count(*) FROM notifications WHERE dispatched_at IS NULL)::int AS notifications_queued,
        (SELECT count(*) FROM notification_channels WHERE enabled AND last_error IS NOT NULL)::int AS channels_failing`),
      emqx?.stats ? emqx.stats() : null,
      ...Object.values(config.metricsSources || {}).map(scrape),
    ]);

    m.gauge('iot_users', 'Пользователей').set({}, db0.users);
    const dev = m.gauge('iot_devices', 'Устройств по состоянию');
    dev.set({ state: 'all' }, db0.devices);
    dev.set({ state: 'ready' }, db0.devices_ready);
    dev.set({ state: 'lost' }, db0.devices_lost);
    m.gauge('iot_bridges', 'Мостов').set({}, db0.bridges);
    m.gauge('iot_scenarios_enabled', 'Включённых сценариев').set({}, db0.scenarios_enabled);
    m.gauge('iot_scenarios_failing', 'Включённых сценариев с ошибкой последнего запуска').set({}, db0.scenarios_failing);
    m.gauge('iot_notifications_last_hour', 'Уведомлений за последний час').set({}, db0.notifications_hour);
    m.gauge('iot_notifications_queued', 'Уведомлений ждут рассылки по каналам').set({}, db0.notifications_queued);
    m.gauge('iot_channels_failing', 'Включённых каналов уведомлений с ошибкой последней отправки').set({}, db0.channels_failing);

    up.set({ service: 'emqx' }, stats ? 1 : 0);
    if (stats) {
      for (const [key, name, type, help] of EMQX_FIELDS) {
        if (typeof stats[key] === 'number') m.define(name, type, help).set({}, stats[key]);
      }
    }
    Object.keys(config.metricsSources || {}).forEach((service, i) => up.set({ service }, remote[i] === null ? 0 : 1));

    const body = [httpMetrics.render(), m.render(), ...remote.filter(Boolean)].join('');
    return new RawBody(Buffer.from(body), 'text/plain; version=0.0.4; charset=utf-8');
  });

  return r;
}
