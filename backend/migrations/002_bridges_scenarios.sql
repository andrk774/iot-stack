-- Мосты, сценарии, уведомления.

CREATE TABLE IF NOT EXISTS bridges (
  id                 text PRIMARY KEY CHECK (id ~ '^b[0-9a-f]{16}$'),
  owner_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               text NOT NULL,
  type               text NOT NULL CHECK (type IN ('zigbee2mqtt', 'esphome', 'generic')),
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  mqtt_password_hash text NOT NULL,
  state              text NOT NULL DEFAULT 'new',
  last_seen          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bridges_owner_idx ON bridges (owner_id);

-- Устройства, которые обслуживает мост (у них нет своей MQTT-учётки)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS bridge_id text REFERENCES bridges(id) ON DELETE CASCADE;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS bridge_key text;
CREATE UNIQUE INDEX IF NOT EXISTS devices_bridge_key_idx ON devices (bridge_id, bridge_key) WHERE bridge_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scenarios (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  trigger      jsonb NOT NULL,
  conditions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions      jsonb NOT NULL,
  cooldown_sec integer NOT NULL DEFAULT 0 CHECK (cooldown_sec >= 0),
  last_run_at  timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenarios_owner_idx ON scenarios (owner_id);

CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario_id uuid REFERENCES scenarios(id) ON DELETE SET NULL,
  level       text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'alert')),
  message     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_owner_idx ON notifications (owner_id, created_at DESC);

-- scenario-runner перечитывает сценарии по NOTIFY. Обновление last_run_at/last_error сигнал не шлёт.
CREATE OR REPLACE FUNCTION notify_scenarios_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('scenarios_changed', '');
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scenarios_changed ON scenarios;
CREATE TRIGGER scenarios_changed
  AFTER INSERT OR DELETE OR UPDATE OF name, enabled, trigger, conditions, actions, cooldown_sec
  ON scenarios FOR EACH STATEMENT EXECUTE FUNCTION notify_scenarios_changed();
