// REST API EMQX: принудительно разорвать сессию клиента.
// EMQX проверяет пароль только при подключении, поэтому после отзыва доступа (новый claim-токен,
// удаление устройства, смена токена или удаление моста) старое соединение нужно выкинуть явно.
// Вместе с сессией пропадает и кеш авторизации этого клиента.
//
// Ключ задаётся в .env (EMQX_API_KEY/EMQX_API_SECRET) и попадает в EMQX через api_key.bootstrap_file.

export function createEmqxAdmin({ url, key, secret, fetchImpl = globalThis.fetch, log = console, timeoutMs = 3000 }) {
  const enabled = Boolean(url && key && secret);
  const auth = enabled ? `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` : null;

  /** true — клиент выкинут или его и не было; false — не удалось (ошибка уже в логе) */
  async function kick(clientId) {
    if (!enabled) {
      log.warn?.(`emqx api not configured: session of ${clientId} stays open until it reconnects`);
      return false;
    }
    try {
      const res = await fetchImpl(`${url.replace(/\/$/, '')}/api/v5/clients/${encodeURIComponent(clientId)}`, {
        method: 'DELETE',
        headers: { authorization: auth },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 204 || res.status === 404) return true; // 404 — не подключён
      log.error?.(`emqx kick ${clientId}: HTTP ${res.status}`);
      return false;
    } catch (e) {
      log.error?.(`emqx kick ${clientId}: ${e.message}`);
      return false;
    }
  }

  return { enabled, kick };
}
