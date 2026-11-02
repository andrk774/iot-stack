-- Комнаты дома и главный экран (у каждого пользователя свой набор плиток).

CREATE TABLE IF NOT EXISTS rooms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  sort       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

ALTER TABLE devices ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES rooms(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS devices_room_idx ON devices (room_id);

CREATE TABLE IF NOT EXISTS dashboard_items (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  property  text NOT NULL,
  sort      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, device_id, property)
);
