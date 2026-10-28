// Telegram: отправка сообщений и привязка чатов к платформенному боту через /start <код>.
// Бот опрашивает getUpdates (long polling), поэтому вебхук и открытый порт не нужны.

export const BOT_TOKEN_RE = /^(\d{5,15}):[A-Za-z0-9_-]{30,50}$/;

export class TelegramApi {
  constructor({ apiUrl = 'https://api.telegram.org', fetchImpl = globalThis.fetch } = {}) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  async call(token, method, params = {}, timeoutMs = 10_000) {
    let res;
    try {
      res = await this.fetch(`${this.apiUrl}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // в тексте ошибки fetch может оказаться URL с токеном — не пробрасываем его
      throw new Error(e.name === 'TimeoutError' ? 'Telegram не ответил вовремя' : 'нет связи с Telegram');
    }
    let data = null;
    try { data = await res.json(); } catch { /* не JSON */ }
    if (!data?.ok) {
      const err = new Error(`Telegram: ${data?.description || `HTTP ${res.status}`}`);
      err.status = res.status;
      err.retryAfter = data?.parameters?.retry_after;
      throw err;
    }
    return data.result;
  }

  sendMessage(token, chatId, text) {
    return this.call(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
  }
}

const ICONS = { info: 'ℹ️', warning: '⚠️', alert: '🚨' };

/** Текст уведомления для мессенджера (без разметки: сообщение приходит из сценария как есть) */
export function formatText(n) {
  const head = `${ICONS[n.level] || ''} ${n.message}`.trim();
  return n.scenario_name ? `${head}\n— ${n.scenario_name}` : head;
}

/**
 * Платформенный бот: принимает /start <код> и /stop.
 * linkChat(code, chat) -> 'linked' | 'invalid'; unlinkChat(chatId) -> число отключённых каналов.
 */
export class TelegramBot {
  constructor({ api, token, linkChat, unlinkChat, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    Object.assign(this, { api, token, linkChat, unlinkChat, log, sleep });
    this.offset = 0;
    this.stopped = false;
    this.username = null;
  }

  async start() {
    try {
      const me = await this.api.call(this.token, 'getMe');
      this.username = me.username;
      this.log.log?.(`telegram bot @${me.username} ready`);
    } catch (e) {
      this.log.error?.(`telegram getMe failed: ${e.message}`);
    }
    this.loop();
  }

  stop() { this.stopped = true; }

  async loop() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const updates = await this.api.call(this.token, 'getUpdates',
          { offset: this.offset, timeout: 25, allowed_updates: ['message'] }, 35_000);
        backoff = 1000;
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.handle(u).catch((e) => this.log.error?.(`telegram update: ${e.message}`));
        }
      } catch (e) {
        this.log.error?.(`telegram getUpdates: ${e.message}`);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  async handle(u) {
    const msg = u.message;
    if (!msg?.chat || typeof msg.text !== 'string') return;
    const chat = { id: String(msg.chat.id), title: msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || '' };
    const [cmd, arg] = msg.text.trim().split(/\s+/, 2);
    const command = cmd.split('@')[0];
    let answer;
    if (command === '/start' && arg) {
      const res = await this.linkChat(arg, chat);
      answer = {
        linked: 'Готово: уведомления платформы будут приходить в этот чат. Отключить — /stop или в настройках панели.',
        limit: 'Не подключено: у аккаунта уже максимум каналов уведомлений. Удалите лишние в панели.',
      }[res] || 'Код не подошёл или устарел. Получите новую ссылку в панели: Настройки → Уведомления.';
    } else if (command === '/stop') {
      const n = await this.unlinkChat(chat.id);
      answer = n ? 'Уведомления в этот чат отключены.' : 'Этот чат не был подключён.';
    } else if (command === '/start') {
      answer = 'Чтобы подключить чат, откройте панель: Настройки → Уведомления → «Подключить Telegram».';
    } else {
      return;
    }
    await this.api.sendMessage(this.token, chat.id, answer).catch((e) => this.log.error?.(`telegram reply: ${e.message}`));
  }
}
