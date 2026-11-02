-- Почасовые агрегаты телеметрии: графики за месяцы и годы без сырых данных (сырые хранятся 90 дней).
-- В TimescaleDB это непрерывный агрегат с фоновым обновлением и хранением 2 года.
-- Без TimescaleDB (тесты) — обычное представление с теми же колонками.
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    -- WITH NO DATA: создание в транзакции миграции; исторические данные дозаливает бэкенд при старте
    EXECUTE $q$
      CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_hourly
      WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
      SELECT time_bucket(INTERVAL '1 hour', time) AS bucket, device_id, property,
             avg(value_num) AS avg, min(value_num) AS min, max(value_num) AS max, count(value_num)::int AS n
      FROM telemetry
      GROUP BY bucket, device_id, property
      WITH NO DATA
    $q$;
    PERFORM add_continuous_aggregate_policy('telemetry_hourly',
      start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '30 minutes', if_not_exists => true);
    PERFORM add_retention_policy('telemetry_hourly', INTERVAL '730 days', if_not_exists => true);
  ELSE
    EXECUTE $q$
      CREATE OR REPLACE VIEW telemetry_hourly AS
      SELECT date_trunc('hour', time) AS bucket, device_id, property,
             avg(value_num) AS avg, min(value_num) AS min, max(value_num) AS max, count(value_num)::int AS n
      FROM telemetry
      GROUP BY 1, 2, 3
    $q$;
  END IF;
END
$mig$;
