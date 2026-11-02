// Уведомления Яндексу об изменении состояния (чтобы приложение «Дом с Алисой» показывало свежие значения).
// Нужны YANDEX_SKILL_ID и YANDEX_SKILL_TOKEN (OAuth-токен владельца навыка). Без них Яндекс
// просто запрашивает состояние сам, когда пользователь открывает устройство.
import { loadMapped } from '../routes/yandex.js';
import { stateOf } from './map.js';

export class YandexNotifier {
  constructor({ db, skillId, token, clientId, fetchImpl = globalThis.fetch, log = console, debounceMs = 2500 }) {
    Object.assign(this, { db, skillId, token, clientId, fetch: fetchImpl, log, debounceMs });
    this.timers = new Map();
    this.enabled = Boolean(skillId && token && clientId);
  }

  /** Пришло значение или состояние устройства — отправим через паузу (ingest успеет записать last_values) */
  touch(deviceId) {
    if (!this.enabled || this.timers.has(deviceId)) return;
    this.timers.set(deviceId, setTimeout(() => {
      this.timers.delete(deviceId);
      this.send(deviceId).catch((e) => this.log.error?.(`yandex callback ${deviceId}: ${e.message}`));
    }, this.debounceMs));
  }

  async send(deviceId) {
    // пользователи со связкой, которым доступно устройство (владелец и участники дома)
    const { rows: users } = await this.db.query(
      `SELECT DISTINCT t.user_id FROM oauth_tokens t JOIN devices d ON d.id = $1
       WHERE t.client_id = $2 AND (d.owner_id = t.user_id
         OR EXISTS (SELECT 1 FROM home_members hm WHERE hm.owner_id = d.owner_id AND hm.user_id = t.user_id))`,
      [deviceId, this.clientId]);
    for (const { user_id: userId } of users) {
      const { mapped, byDevice } = await loadMapped(this.db, userId, { reportable: true, deviceIds: [deviceId] });
      const d = byDevice.get(deviceId);
      if (!d || !mapped.length) continue;
      const offline = d.state === 'lost' || d.state === 'disconnected';
      const devices = mapped.map((m) => ({ id: m.yandex.id, status: offline ? 'offline' : 'online', ...stateOf(m, d.last_values) }));
      const res = await this.fetch(`https://dialogs.yandex.net/api/v1/skills/${this.skillId}/callback/state`, {
        method: 'POST',
        headers: { authorization: `OAuth ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ts: Date.now() / 1000, payload: { user_id: userId, devices } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status !== 202 && res.status !== 200) this.log.warn?.(`yandex callback: HTTP ${res.status}`);
    }
  }
}
