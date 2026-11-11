-- Персональные API-токены, журнал запусков сценариев, канал уведомлений «email».

-- Долгоживущие токены для скриптов, Home Assistant, Node-RED. Хранится только sha256.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  hint         text NOT NULL,                 -- последние символы, чтобы узнать токен в списке
  scope        text NOT NULL CHECK (scope IN ('read', 'write')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_owner_idx ON api_tokens (owner_id);

-- Журнал запусков сценариев (scenario-runner хранит последние 200 записей на сценарий)
CREATE TABLE IF NOT EXISTS scenario_runs (
  id          bigserial PRIMARY KEY,
  scenario_id uuid NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
  cause       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- что запустило: {kind, device_id, property, value}
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{type, ok, info, error?}]
  error       text                                  -- для skipped — причина пропуска
);
CREATE INDEX IF NOT EXISTS scenario_runs_scenario_idx ON scenario_runs (scenario_id, id DESC);

-- Email как канал уведомлений. Канал появляется только после подтверждения адреса кодом из письма —
-- иначе через сценарии можно было бы слать письма на чужой ящик.
ALTER TABLE notification_channels DROP CONSTRAINT IF EXISTS notification_channels_type_check;
ALTER TABLE notification_channels ADD CONSTRAINT notification_channels_type_check
  CHECK (type IN ('telegram', 'webhook', 'webpush', 'email'));
CREATE UNIQUE INDEX IF NOT EXISTS notification_channels_email_idx ON notification_channels
  (owner_id, (config->>'email')) WHERE type = 'email';

CREATE TABLE IF NOT EXISTS email_verifications (
  owner_id   uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,   -- один код на пользователя
  email      text NOT NULL,
  min_level  text NOT NULL DEFAULT 'info' CHECK (min_level IN ('info', 'warning', 'alert')),
  code_hash  text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  attempts   integer NOT NULL DEFAULT 0
);
