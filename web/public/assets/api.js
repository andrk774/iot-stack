// REST-клиент. Токен хранится в localStorage (если доступен), иначе только в памяти.

const KEY = 'iot.token';
let token = null;
try { token = localStorage.getItem(KEY); } catch { /* приватный режим */ }

const listeners = new Set();
export const onAuthChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function getToken() { return token; }

export function setToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem(KEY, t);
    else localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  for (const fn of listeners) fn(t);
}

export class ApiError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) {
    if (res.status === 401 && token) setToken(null);
    if (res.status === 429) throw new ApiError(429, 'too_many_requests');
    throw new ApiError(res.status, data?.error || `http_${res.status}`, data?.details);
  }
  return data;
}

/** Загрузка файла как есть (application/octet-stream) */
export async function upload(path, file) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* пусто */ }
  if (!res.ok) {
    if (res.status === 401 && token) setToken(null);
    if (res.status === 413) throw new ApiError(413, 'payload_too_large');
    throw new ApiError(res.status, data?.error || `http_${res.status}`, data?.details);
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);
