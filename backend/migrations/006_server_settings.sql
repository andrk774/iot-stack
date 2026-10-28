-- Настройки сервера, которые он создаёт сам (ключи VAPID для web push и т. п.)
CREATE TABLE IF NOT EXISTS server_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
