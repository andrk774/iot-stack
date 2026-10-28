-- Сессии входа (токен панели ссылается на сессию: её можно отозвать) и двухфакторная аутентификация.

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  ip           text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;           -- включённая 2FA
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending text;          -- секрет на этапе подключения
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint NOT NULL DEFAULT 0;  -- защита от повтора кода
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes text[] NOT NULL DEFAULT '{}'; -- sha256 кодов восстановления
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
