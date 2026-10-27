-- Выполняется один раз при первой инициализации тома pgdata.
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- id устройства = MQTT username = MQTT client id
CREATE TABLE devices (
  id                 text PRIMARY KEY CHECK (id ~ '^d[0-9a-f]{16}$'),
  owner_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               text NOT NULL,
  mqtt_password_hash text,                 -- NULL, пока устройство не привязано
  claim_token_hash   text UNIQUE,          -- sha256 одноразового токена привязки
  claim_expires_at   timestamptz,
  provisioned_at     timestamptz,
  state              text NOT NULL DEFAULT 'new',   -- new | init | ready | lost | ...
  meta               jsonb,                -- описание свойств, публикует само устройство
  last_values        jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_owner_idx ON devices (owner_id);

-- Временные ряды
CREATE TABLE telemetry (
  time       timestamptz NOT NULL,
  device_id  text NOT NULL,
  property   text NOT NULL,
  value_num  double precision,
  value_text text
);

SELECT create_hypertable('telemetry', by_range('time', INTERVAL '1 day'));
CREATE INDEX telemetry_dev_prop_time_idx ON telemetry (device_id, property, time DESC);

-- Сжатие чанков старше 7 дней, удаление старше 90 дней
ALTER TABLE telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id, property',
  timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('telemetry', INTERVAL '7 days');
SELECT add_retention_policy('telemetry', INTERVAL '90 days');
