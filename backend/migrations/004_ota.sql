-- OTA: библиотека прошивок пользователя и задания обновления устройств.
-- Прошивка лежит в БД (bytea, до нескольких МБ): попадает в ежедневный бэкап вместе со всем остальным.

CREATE TABLE IF NOT EXISTS firmwares (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  version    text NOT NULL,
  size       integer NOT NULL CHECK (size > 0),
  md5        text NOT NULL,
  sha256     text NOT NULL,
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS firmwares_owner_idx ON firmwares (owner_id);

-- Задание: устройство получает retained-команду dev/<id>/$ota/set и скачивает файл по одноразовой ссылке.
-- Последнее задание устройства — текущее; старые остаются историей.
CREATE TABLE IF NOT EXISTS ota_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  firmware_id uuid REFERENCES firmwares(id) ON DELETE SET NULL,
  version     text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'downloading', 'rebooting', 'done', 'failed', 'cancelled')),
  progress    smallint,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ota_jobs_device_idx ON ota_jobs (device_id, created_at DESC);
