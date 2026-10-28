-- Каналы доставки уведомлений: Telegram, вебхук, web push (браузер / PWA).

CREATE TABLE IF NOT EXISTS notification_channels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('telegram', 'webhook', 'webpush')),
  name         text NOT NULL,
  config       jsonb NOT NULL,
  min_level    text NOT NULL DEFAULT 'info' CHECK (min_level IN ('info', 'warning', 'alert')),
  enabled      boolean NOT NULL DEFAULT true,
  last_sent_at timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_channels_owner_idx ON notification_channels (owner_id);
-- один чат Telegram у пользователя подключается один раз
CREATE UNIQUE INDEX IF NOT EXISTS notification_channels_tg_idx ON notification_channels
  (owner_id, (config->>'chat_id'), (coalesce(config->>'bot', ''))) WHERE type = 'telegram';

-- Одноразовые коды привязки чата к платформенному боту (/start <код>)
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code_hash  text PRIMARY KEY,
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Очередь рассылки: dispatched_at IS NULL — ещё не разослано. Старые записи считаем разосланными.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
UPDATE notifications SET dispatched_at = created_at WHERE dispatched_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_pending_idx ON notifications (id) WHERE dispatched_at IS NULL;

CREATE OR REPLACE FUNCTION notify_notification_new() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('notification_new', '');
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_new ON notifications;
CREATE TRIGGER notification_new AFTER INSERT ON notifications
  FOR EACH STATEMENT EXECUTE FUNCTION notify_notification_new();
