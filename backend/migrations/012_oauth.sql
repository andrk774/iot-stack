-- OAuth 2.0 для связки аккаунтов (умный дом Яндекса): коды авторизации и токены.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash    text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at   timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id         text NOT NULL,
  access_hash       text NOT NULL UNIQUE,
  refresh_hash      text NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_tokens_user_idx ON oauth_tokens (user_id, client_id);
