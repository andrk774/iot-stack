-- Общий доступ: пользователь приглашает других в свой «дом» (все свои устройства, сценарии, мосты).
-- Роли: view — смотреть; control — ещё управлять устройствами и запускать сценарии;
--       admin — ещё добавлять/менять/удалять устройства, сценарии, мосты, обновлять прошивки.
-- Владелец (owner_id ресурсов) в таблице не хранится: у него все права, участников меняет только он.

CREATE TABLE IF NOT EXISTS home_members (
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('view', 'control', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, user_id),
  CHECK (owner_id <> user_id)
);
CREATE INDEX IF NOT EXISTS home_members_user_idx ON home_members (user_id);

CREATE TABLE IF NOT EXISTS home_invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL UNIQUE,
  role       text NOT NULL CHECK (role IN ('view', 'control', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS home_invites_owner_idx ON home_invites (owner_id);
