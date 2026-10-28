// Рассылка уведомлений по каналам пользователя.
// Сценарии пишут строку в notifications; триггер шлёт NOTIFY notification_new, бэкенд забирает
// неразосланные строки (FOR UPDATE SKIP LOCKED — безопасно и при нескольких репликах) и рассылает.
import crypto from 'node:crypto';
import { postOut } from './net.js';
import { formatText } from './telegram.js';

export const LEVEL_RANK = { info: 0, warning: 1, alert: 2 };
const STALE_MS = 60 * 60 * 1000; // старше часа не рассылаем (бэкенд долго лежал) — только в ленте

/** Ошибка, после которой канал выключается (бот заблокирован, подписка браузера удалена) */
export class PermanentError extends Error {}

export function webhookPayload(n) {
  return JSON.stringify({
    id: Number(n.id), level: n.level, message: n.message,
    scenario_id: n.scenario_id ?? null, scenario_name: n.scenario_name ?? null,
    created_at: new Date(n.created_at).toISOString(),
  });
}

/** Подпись тела вебхука: X-Iot-Signature: sha256=<hex HMAC от "<timestamp>.<тело>"> */
export function signWebhook(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function makeSenders({ telegram, platformBotToken, webpush, allowPrivate = false, now = () => Date.now() }) {
  return {
    async telegram(ch, n) {
      const token = ch.config.bot === 'platform' ? platformBotToken : ch.config.bot_token;
      if (!token) throw new Error('платформенный бот не настроен (TELEGRAM_BOT_TOKEN)');
      try {
        await telegram.sendMessage(token, ch.config.chat_id, formatText(n));
      } catch (e) {
        if (e.status === 403 || (e.status === 400 && /chat not found/i.test(e.message))) throw new PermanentError(e.message);
        throw e;
      }
    },
    async webhook(ch, n) {
      const body = webhookPayload(n);
      const ts = String(Math.floor(now() / 1000));
      const res = await postOut(ch.config.url, {
        body,
        allowPrivate,
        headers: {
          'content-type': 'application/json',
          'x-iot-timestamp': ts,
          'x-iot-signature': signWebhook(ch.config.secret, ts, body),
        },
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    },
    async webpush(ch, n) {
      if (!webpush) throw new Error('web push не настроен');
      await webpush.send(ch.config, n);
    },
  };
}

export class Dispatcher {
  constructor({ db, senders, log = console, now = () => Date.now(), retryDelayMs = 2000, sleep }) {
    Object.assign(this, { db, senders, log, now, retryDelayMs });
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.busy = false;
    this.again = false;
  }

  /** Можно звать сколько угодно часто: параллельные вызовы схлопываются */
  async kick() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do {
        this.again = false;
        while (await this.batch() === 50) { /* есть ещё */ }
      } while (this.again);
    } catch (e) {
      this.log.error?.(`notify dispatch: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  async batch() {
    const { rows } = await this.db.query(
      `UPDATE notifications n SET dispatched_at = now()
       FROM (SELECT id FROM notifications WHERE dispatched_at IS NULL ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED) p
       WHERE n.id = p.id
       RETURNING n.id, n.owner_id, n.level, n.message, n.scenario_id, n.created_at,
                 (SELECT name FROM scenarios s WHERE s.id = n.scenario_id) AS scenario_name`,
    );
    const fresh = rows.filter((n) => this.now() - new Date(n.created_at).getTime() < STALE_MS);
    if (!fresh.length) return rows.length;
    const owners = [...new Set(fresh.map((n) => n.owner_id))];
    const { rows: channels } = await this.db.query(
      'SELECT id, owner_id, type, config, min_level FROM notification_channels WHERE enabled AND owner_id = ANY($1::uuid[])',
      [owners],
    );
    const jobs = [];
    for (const n of fresh.sort((a, b) => Number(a.id) - Number(b.id))) {
      for (const ch of channels) {
        if (ch.owner_id !== n.owner_id || LEVEL_RANK[n.level] < LEVEL_RANK[ch.min_level]) continue;
        jobs.push([ch, n]);
      }
    }
    // по каналу — последовательно (порядок сообщений), каналы — параллельно
    const byChannel = new Map();
    for (const [ch, n] of jobs) {
      if (!byChannel.has(ch.id)) byChannel.set(ch.id, { ch, list: [] });
      byChannel.get(ch.id).list.push(n);
    }
    await Promise.all([...byChannel.values()].map(async ({ ch, list }) => {
      for (const n of list) {
        const stop = await this.deliver(ch, n);
        if (stop) break;
      }
    }));
    return rows.length;
  }

  /** true — канал выключен, дальше в него не слать */
  async deliver(ch, n) {
    const send = this.senders[ch.type];
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await send(ch, n);
        await this.db.query('UPDATE notification_channels SET last_sent_at = now(), last_error = NULL WHERE id = $1', [ch.id]);
        return false;
      } catch (e) {
        lastErr = e;
        if (e instanceof PermanentError) break;
        if (attempt === 0) await this.sleep(Math.min((e.retryAfter || 0) * 1000, 30_000) || this.retryDelayMs);
      }
    }
    const permanent = lastErr instanceof PermanentError;
    this.log.warn?.(`channel ${ch.id} (${ch.type}): ${lastErr.message}`);
    await this.db.query(
      `UPDATE notification_channels SET last_error = $2${permanent ? ', enabled = false' : ''} WHERE id = $1`,
      [ch.id, `${new Date(this.now()).toISOString()}: ${String(lastErr.message).slice(0, 300)}${permanent ? ' (канал выключен)' : ''}`],
    ).catch(() => {});
    return permanent;
  }
}
