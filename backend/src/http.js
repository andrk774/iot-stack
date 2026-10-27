import http from 'node:http';

export class HttpError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Ответ с нестандартным статусом: return reply(201, {...}) */
export class Reply {
  constructor(status, body) {
    this.status = status;
    this.body = body;
  }
}
export const reply = (status, body) => new Reply(status, body);

export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, path, handler) {
    const keys = [];
    const pattern = path.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${pattern}$`), keys, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }
  use(other) {
    this.routes.push(...other.routes);
    return this;
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      try {
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      } catch {
        throw new HttpError(400, 'bad_path');
      }
      return { handler: r.handler, params };
    }
    return null;
  }
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      if (!ct.includes('application/json')) return reject(new HttpError(415, 'expected_json'));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

export function createServer(router, { bodyLimit = 16 * 1024, log = console } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'not_found');
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req, bodyLimit) : undefined;
      const result = await m.handler({
        req,
        params: m.params,
        query: Object.fromEntries(url.searchParams),
        body,
      });
      if (result instanceof Reply) send(res, result.status, result.body);
      else send(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.code, ...(err.details ? { details: err.details } : {}) });
      } else {
        log.error?.('unhandled error', err);
        send(res, 500, { error: 'internal' });
      }
    }
  });
}

// ---------- валидация ----------
export function str(value, field, { min = 1, max = 255, re } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, 'validation', { field, reason: 'string required' });
  const v = value.trim();
  if (v.length < min || v.length > max) throw new HttpError(400, 'validation', { field, reason: `length ${min}..${max}` });
  if (re && !re.test(v)) throw new HttpError(400, 'validation', { field, reason: 'format' });
  return v;
}
