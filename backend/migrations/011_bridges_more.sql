-- Мосты Tasmota и Shelly; устройства мостов, удалённые пользователем, больше не регистрируются заново.
ALTER TABLE bridges DROP CONSTRAINT IF EXISTS bridges_type_check;
ALTER TABLE bridges ADD CONSTRAINT bridges_type_check
  CHECK (type IN ('zigbee2mqtt', 'esphome', 'generic', 'tasmota', 'shelly'));

CREATE TABLE IF NOT EXISTS bridge_ignored (
  bridge_id  text NOT NULL REFERENCES bridges(id) ON DELETE CASCADE,
  key        text NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bridge_id, key)
);
