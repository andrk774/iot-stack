// REST-клиент моста: Authorization: Bridge <id>:<token>
export class BridgeApi {
  constructor({ url, id, token, fetchImpl = globalThis.fetch }) {
    this.url = url.replace(/\/$/, '');
    this.auth = `Bridge ${id}:${token}`;
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(this.url + path, {
          method,
          headers: { authorization: this.auth, ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      // лимит nginx или перезапуск бэкенда — подождать и повторить
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** Math.min(attempt, 4)));
        continue;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(`${method} ${path}: HTTP ${res.status} ${data?.error ?? ''}`);
        err.permanent = res.status === 400 || res.status === 401 || res.status === 409;
        throw err;
      }
      return data;
    }
  }

  self() { return this.request('GET', '/api/bridge/self'); }
  registerDevice(key, name) { return this.request('POST', '/api/bridge/devices', { key, name }); }
}
