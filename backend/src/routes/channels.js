// Каналы уведомлений пользователя: Telegram (платформенный или свой бот), вебхук, web push.
import { Router, HttpError, reply, str } from '../http.js';
import { makeAuth, withTx, lockScope } from './common.js';
import { checkUrl, OutboundError } from '../notify/net.js';
import { BOT_TOKEN_RE } from '../notify/telegram.js';
import { LEVEL_RANK } from '../notify/dispatcher.js';
import { randomToken, sha256 } from '../security.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHAT_ID_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;
const MAX_CHANNELS = 20;
const LINK_TTL_MIN = 15;
const COLUMNS = 'id, type, name, config, min_level, enabled, last_sent_at, last_error, created_at';

/** Что видит панель: без токенов, секретов и ключей подписки */
export function publicChannel(ch) {
  const c = ch.config || {};
  let info;
  if (ch.type === 'telegram') info = { chat_id: c.chat_id, chat_title: c.chat_title || null, own_bot: c.bot !== 'platform' };
  else if (ch.type === 'webhook') info = { url: c.url };
  else info = { device: c.device || null, endpoint_host: (() => { try { return new URL(c.endpoint).host; } catch { return null; } })() };
  return { id: ch.id, type: ch.type, name: ch.name, min_level: ch.min_level, enabled: ch.enabled,
    last_sent_at: ch.last_sent_at, last_error: ch.last_error, created_at: ch.created_at, ...info };
}

const level = (v) => {
  const l = v ?? 'info';
  if (!(l in LEVEL_RANK)) throw new HttpError(400, 'validation', { field: 'min_level', reason: 'info|warning|alert' });
  return l;
};

/**
 * @param {{ db, config, senders, telegramBot?: {username: string|null}, webpush?: {publicKey: string, checkSubscription: Function} }} deps
 */
export function channelRoutes({ db, config, senders, telegramBot = null, webpush = null }) {
  const r = new Router();
  const auth = makeAuth(config);
  const allowPrivate = Boolean(config.webhookAllowPrivate);

  const own = async (userId, id) => {
    if (!UUID_RE.test(id)) throw new HttpError(404, 'channel_not_found');
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM notification_channels WHERE id = $1 AND owner_id = $2`, [id, userId]);
    if (!rows[0]) throw new HttpError(404, 'channel_not_found');
    return rows[0];
  };

  /** Вставка с лимитом; дубликат того же чата/подписки — 409 */
  const insert = (userId, type, name, cfg, minLevel) => withTx(db, async (tx) => {
    await lockScope(tx, 'channels', userId);
    const { rows: cnt } = await tx.query('SELECT count(*)::int AS n FROM notification_channels WHERE owner_id = $1', [userId]);
    if (cnt[0].n >= MAX_CHANNELS) throw new HttpError(409, 'channel_limit_reached');
    if (type === 'webpush') {
      // тот же браузер подписался заново — обновляем ключи вместо дубля
      const { rows } = await tx.query(
        `UPDATE notification_channels SET config = $3::jsonb, enabled = true, last_error = NULL
         WHERE owner_id = $1 AND type = 'webpush' AND config->>'endpoint' = $2 RETURNING ${COLUMNS}`,
        [userId, cfg.endpoint, JSON.stringify(cfg)]);
      if (rows[0]) return rows[0];
    }
    try {
      const { rows } = await tx.query(
        `INSERT INTO notification_channels (owner_id, type, name, config, min_level)
         VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING ${COLUMNS}`,
        [userId, type, name, JSON.stringify(cfg), minLevel]);
      return rows[0];
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'channel_exists');
      throw e;
    }
  });

  r.get('/api/channels', async ({ req }) => {
    const userId = auth(req);
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM notification_channels WHERE owner_id = $1 ORDER BY created_at`, [userId]);
    return {
      channels: rows.map(publicChannel),
      telegram_bot: config.telegramBotToken ? (telegramBot?.username || '') : null,
      webpush_public_key: webpush?.publicKey || null,
    };
  });

  r.post('/api/channels', async ({ req, body }) => {
    const userId = auth(req);
    const minLevel = level(body.min_level);
    if (body.type === 'webhook') {
      const url = str(body.url, 'url', { max: 2048 });
      try { checkUrl(url, { allowPrivate }); } catch (e) {
        if (e instanceof OutboundError) throw new HttpError(400, 'validation', { field: 'url', reason: e.message });
        throw e;
      }
      const name = body.name ? str(body.name, 'name', { max: 64 }) : new URL(url).host;
      const secret = randomToken(24);
      const ch = await insert(userId, 'webhook', name, { url, secret }, minLevel);
      // секрет подписи показываем один раз
      return reply(201, { channel: publicChannel(ch), secret });
    }
    if (body.type === 'telegram') {
      // свой бот: токен от @BotFather и id чата
      const botToken = str(body.bot_token, 'bot_token', { max: 80, re: BOT_TOKEN_RE });
      const chatId = str(String(body.chat_id ?? ''), 'chat_id', { max: 33, re: CHAT_ID_RE });
      const name = body.name ? str(body.name, 'name', { max: 64 }) : `Telegram ${chatId}`;
      const cfg = { bot: BOT_TOKEN_RE.exec(botToken)[1], bot_token: botToken, chat_id: chatId };
      return reply(201, { channel: publicChannel(await insert(userId, 'telegram', name, cfg, minLevel)) });
    }
    if (body.type === 'webpush') {
      if (!webpush) throw new HttpError(409, 'webpush_not_configured');
      const sub = body.subscription;
      const endpoint = str(sub?.endpoint, 'subscription.endpoint', { max: 1024 });
      try { checkUrl(endpoint); } catch { throw new HttpError(400, 'validation', { field: 'subscription.endpoint', reason: 'https' }); }
      const p256dh = str(sub?.keys?.p256dh, 'subscription.keys.p256dh', { min: 80, max: 100, re: /^[A-Za-z0-9_-]+$/ });
      const authKey = str(sub?.keys?.auth, 'subscription.keys.auth', { min: 16, max: 32, re: /^[A-Za-z0-9_-]+$/ });
      if (!webpush.checkKeys(p256dh, authKey)) throw new HttpError(400, 'validation', { field: 'subscription.keys', reason: 'ключи P-256' });
      const device = body.device ? str(body.device, 'device', { max: 64 }) : null;
      const cfg = { endpoint, p256dh, auth: authKey, device };
      const ch = await insert(userId, 'webpush', body.name ? str(body.name, 'name', { max: 64 }) : (device || 'Браузер'), cfg, minLevel);
      return reply(201, { channel: publicChannel(ch) });
    }
    throw new HttpError(400, 'validation', { field: 'type', reason: 'webhook|telegram|webpush (платформенный Telegram — через /api/channels/telegram-link)' });
  });

  // Ссылка t.me/<бот>?start=<код>: пользователь жмёт Start, бот привязывает чат
  r.post('/api/channels/telegram-link', async ({ req }) => {
    const userId = auth(req);
    if (!config.telegramBotToken) throw new HttpError(409, 'telegram_not_configured');
    if (!telegramBot?.username) throw new HttpError(503, 'telegram_unavailable');
    const code = randomToken(18); // 24 символа base64url — Telegram принимает до 64 [A-Za-z0-9_-]
    const expires = new Date(Date.now() + LINK_TTL_MIN * 60_000);
    await db.query('DELETE FROM telegram_link_codes WHERE expires_at < now()');
    await db.query('INSERT INTO telegram_link_codes (code_hash, owner_id, expires_at) VALUES ($1, $2, $3)', [sha256(code), userId, expires]);
    return { url: `https://t.me/${telegramBot.username}?start=${code}`, expires_at: expires };
  });

  r.put('/api/channels/:id', async ({ req, params, body }) => {
    const userId = auth(req);
    const ch = await own(userId, params.id);
    const name = body.name === undefined ? ch.name : str(body.name, 'name', { max: 64 });
    const minLevel = body.min_level === undefined ? ch.min_level : level(body.min_level);
    const enabled = body.enabled === undefined ? ch.enabled : body.enabled;
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'validation', { field: 'enabled', reason: 'true/false' });
    const { rows } = await db.query(
      `UPDATE notification_channels SET name = $2, min_level = $3, enabled = $4,
              last_error = CASE WHEN $4 AND NOT enabled THEN NULL ELSE last_error END
       WHERE id = $1 RETURNING ${COLUMNS}`, [ch.id, name, minLevel, enabled]);
    return publicChannel(rows[0]);
  });

  r.delete('/api/channels/:id', async ({ req, params }) => {
    const userId = auth(req);
    const ch = await own(userId, params.id);
    await db.query('DELETE FROM notification_channels WHERE id = $1', [ch.id]);
    return reply(204);
  });

  // Проверка канала: отправить тестовое сообщение прямо сейчас
  r.post('/api/channels/:id/test', async ({ req, params }) => {
    const userId = auth(req);
    const ch = await own(userId, params.id);
    const n = { id: 0, level: 'info', message: 'Проверка канала: уведомления платформы будут приходить сюда.',
      scenario_id: null, scenario_name: null, created_at: new Date() };
    try {
      await senders[ch.type](ch, n);
    } catch (e) {
      await db.query('UPDATE notification_channels SET last_error = $2 WHERE id = $1', [ch.id, String(e.message).slice(0, 300)]);
      throw new HttpError(502, 'channel_send_failed', { reason: String(e.message).slice(0, 300) });
    }
    await db.query('UPDATE notification_channels SET last_sent_at = now(), last_error = NULL WHERE id = $1', [ch.id]);
    return { ok: true };
  });

  return r;
}

/** Для бота: привязать чат по коду (одноразовый). Возвращает 'linked' | 'invalid' | 'limit' */
export async function linkTelegramChat(db, code, chat) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return 'invalid';
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      'DELETE FROM telegram_link_codes WHERE code_hash = $1 AND expires_at > now() RETURNING owner_id', [sha256(code)]);
    if (!rows[0]) return 'invalid';
    await lockScope(tx, 'channels', rows[0].owner_id);
    const { rows: cnt } = await tx.query('SELECT count(*)::int AS n FROM notification_channels WHERE owner_id = $1', [rows[0].owner_id]);
    if (cnt[0].n >= MAX_CHANNELS) return 'limit';
    const cfg = { bot: 'platform', chat_id: chat.id, chat_title: chat.title?.slice(0, 64) || null };
    await tx.query(
      `INSERT INTO notification_channels (owner_id, type, name, config) VALUES ($1, 'telegram', $2, $3::jsonb)
       ON CONFLICT (owner_id, (config->>'chat_id'), (coalesce(config->>'bot', ''))) WHERE type = 'telegram'
       DO UPDATE SET enabled = true, last_error = NULL, config = EXCLUDED.config`,
      [rows[0].owner_id, `Telegram${chat.title ? `: ${chat.title.slice(0, 50)}` : ''}`, JSON.stringify(cfg)]);
    return 'linked';
  });
}

export async function unlinkTelegramChat(db, chatId) {
  const { rowCount } = await db.query(
    "DELETE FROM notification_channels WHERE type = 'telegram' AND config->>'bot' = 'platform' AND config->>'chat_id' = $1", [String(chatId)]);
  return rowCount;
}
