// Демо-сервер панели без бэкенда: статика + REST в памяти + мини-брокер MQTT over WebSocket.
//   node web/dev/mock-server.js   ->  http://localhost:8080  (любой email, пароль от 8 символов)
// Нужен для разработки интерфейса и снимков экрана; к настоящей платформе отношения не имеет.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const PORT = Number(process.env.PORT || 8080);
const USER = { id: '6f1c2b3a-1111-4222-8333-944455556666', email: 'demo@example.com' };
const now = () => new Date().toISOString();
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

const devices = new Map([
  ['d1a2b3c4d5e6f7081', {
    id: 'd1a2b3c4d5e6f7081', name: 'Теплица', state: 'ready', provisioned: true, bridge_id: null, created_at: ago(86400 * 20), last_seen: ago(4),
    meta: { name: 'Теплица', fw: '1.2.0', props: {
      temperature: { type: 'float', unit: '°C' }, humidity: { type: 'float', unit: '%' },
      target: { type: 'float', unit: '°C', settable: true, min: 5, max: 30 },
      heater: { type: 'boolean', settable: true }, mode: { type: 'string', settable: true },
    } },
    last_values: { temperature: 24.6, humidity: 61, target: 22, heater: 0, mode: 'heat' },
  }],
  ['d9f8e7d6c5b4a3920', {
    id: 'd9f8e7d6c5b4a3920', name: 'Котельная', state: 'lost', provisioned: true, bridge_id: null, created_at: ago(86400 * 40), last_seen: ago(3600 * 5),
    meta: { name: 'Котельная', fw: '0.9.1', props: { water_temp: { type: 'float', unit: '°C' }, pump: { type: 'boolean', settable: true }, rssi: { type: 'integer', unit: 'dBm' } } },
    last_values: { water_temp: 58.2, pump: 1, rssi: -71 },
  }],
  ['d00112233aabbccdd', {
    id: 'd00112233aabbccdd', name: 'kitchen/sensor', state: 'ready', provisioned: true, bridge_id: 'b00112233445566ff', created_at: ago(86400 * 3), last_seen: ago(40),
    meta: { name: 'kitchen/sensor', fw: 'bridge:zigbee2mqtt', props: { temperature: { type: 'float', unit: '°C' }, humidity: { type: 'float', unit: '%' }, battery: { type: 'float', unit: '%', min: 0, max: 100 } } },
    last_values: { temperature: 21.4, humidity: 48, battery: 87 },
  }],
  ['d55aa55aa55aa55aa', {
    id: 'd55aa55aa55aa55aa', name: 'Розетка в гараже', state: 'new', provisioned: false, bridge_id: null, created_at: ago(600), last_seen: null, meta: null, last_values: {},
  }],
]);
const scenarios = new Map([
  ['3d9a7c1e-0000-4000-8000-000000000001', {
    id: '3d9a7c1e-0000-4000-8000-000000000001', name: 'Проветрить теплицу', enabled: true, cooldown_sec: 300,
    trigger: { type: 'property', device_id: 'd1a2b3c4d5e6f7081', property: 'temperature', op: 'gt', value: 30 },
    conditions: [], actions: [{ type: 'set', device_id: 'd1a2b3c4d5e6f7081', property: 'heater', value: false }, { type: 'notify', level: 'warning', message: '{device}: {value} °C' }],
    last_run_at: ago(7200), last_error: null,
  }],
  ['3d9a7c1e-0000-4000-8000-000000000002', {
    id: '3d9a7c1e-0000-4000-8000-000000000002', name: 'Котельная пропала', enabled: true, cooldown_sec: 0,
    trigger: { type: 'state', device_id: 'd9f8e7d6c5b4a3920', state: 'lost' }, conditions: [],
    actions: [{ type: 'notify', level: 'alert', message: '{device} не на связи' }], last_run_at: ago(3600 * 5), last_error: null,
  }],
  ['3d9a7c1e-0000-4000-8000-000000000003', {
    id: '3d9a7c1e-0000-4000-8000-000000000003', name: 'Полив утром', enabled: false, cooldown_sec: 0,
    trigger: { type: 'schedule', cron: '0 7 * * *', tz: 'Asia/Yekaterinburg' }, conditions: [],
    actions: [{ type: 'set', device_id: 'd9f8e7d6c5b4a3920', property: 'pump', value: true }], last_run_at: null, last_error: 'set: mqtt not connected',
  }],
]);
let notifications = [
  { id: 3, level: 'alert', message: 'Котельная не на связи', created_at: ago(3600 * 5), read_at: null, scenario_id: '3d9a7c1e-0000-4000-8000-000000000002', scenario_name: 'Котельная пропала' },
  { id: 2, level: 'warning', message: 'Теплица: 31.2 °C', created_at: ago(7200), read_at: null, scenario_id: '3d9a7c1e-0000-4000-8000-000000000001', scenario_name: 'Проветрить теплицу' },
  { id: 1, level: 'info', message: 'Тестовое уведомление', created_at: ago(86400), read_at: ago(80000), scenario_id: null },
];
const bridges = new Map([
  ['b00112233445566ff', { id: 'b00112233445566ff', name: 'Zigbee дома', type: 'zigbee2mqtt', config: { base_topic: 'zigbee2mqtt' }, state: 'ready', last_seen: ago(40), created_at: ago(86400 * 3), device_count: 1 }],
]);

// ---------- мини-брокер ----------
const sockets = new Set();
function wsFrame(data) {
  const len = data.length;
  const head = len < 126 ? Buffer.from([0x82, len]) : len < 65536 ? Buffer.from([0x82, 126, len >> 8, len & 0xff]) : null;
  return Buffer.concat([head, data]);
}
function mqttPublish(topic, payload) {
  const t = Buffer.from(topic);
  const p = Buffer.from(payload);
  const body = Buffer.concat([Buffer.from([t.length >> 8, t.length & 0xff]), t, p]);
  const rl = [];
  let n = body.length;
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; rl.push(b); } while (n);
  return Buffer.concat([Buffer.from([0x30, ...rl]), body]);
}
function broadcast(topic, payload) {
  for (const s of sockets) if (s.subs.some((f) => f === '#' || topic.startsWith(f.replace(/#$/, '')))) s.write(wsFrame(mqttPublish(topic, payload)));
}
function handleMqtt(sock, pkt) {
  const type = pkt[0] >> 4;
  if (type === 1) sock.write(wsFrame(Buffer.from([0x20, 0x02, 0x00, 0x00])));
  if (type === 8) {
    let i = 1; while (pkt[i] & 0x80) i++; i++;
    const id = [pkt[i], pkt[i + 1]]; i += 2;
    const codes = [];
    while (i < pkt.length) { const l = (pkt[i] << 8) | pkt[i + 1]; sock.subs.push(pkt.slice(i + 2, i + 2 + l).toString()); i += 2 + l + 1; codes.push(1); }
    sock.write(wsFrame(Buffer.from([0x90, 2 + codes.length, ...id, ...codes])));
  }
  if (type === 12) sock.write(wsFrame(Buffer.from([0xd0, 0x00])));
}
function upgrade(req, sock) {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n`);
  sock.subs = [];
  sockets.add(sock);
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      const op = buf[0] & 0x0f;
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { sock.end(); return; }
      if (op === 2) handleMqtt(sock, data);
    }
  });
  sock.on('close', () => sockets.delete(sock));
  sock.on('error', () => sockets.delete(sock));
}
setInterval(() => {
  const d = devices.get('d1a2b3c4d5e6f7081');
  d.last_values.temperature = Math.round((d.last_values.temperature + (Math.random() - 0.5) * 0.4) * 100) / 100;
  broadcast(`dev/${d.id}/temperature`, String(d.last_values.temperature));
}, 3000);

// ---------- REST ----------
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { r(s ? JSON.parse(s) : {}); } catch { r({}); } }); });
const rid = (p, n) => p + crypto.randomBytes(n).toString('hex');

function telemetry(id, q) {
  const from = Date.parse(q.get('from')) || Date.now() - 86400e3;
  const to = Date.parse(q.get('to')) || Date.now();
  const prop = q.get('property');
  const spec = devices.get(id)?.meta?.props?.[prop];
  const n = q.get('bucket') ? 96 : 120;
  const points = [];
  for (let i = 0; i < n; i++) {
    const t = from + ((to - from) * i) / (n - 1);
    const phase = (t / 3600e3) * (Math.PI / 12);
    const v = spec?.type === 'boolean' ? (Math.sin(phase * 3) > 0.3 ? 1 : 0) : 22 + 4 * Math.sin(phase) + Math.random() * 0.6;
    points.push(q.get('bucket') ? { t: new Date(t).toISOString(), avg: v, min: v - 0.8, max: v + 0.8, n: 12 } : { t: new Date(t).toISOString(), v, s: null });
  }
  return { property: prop, points };
}

const totp = { enabled: false };
const firmwares = new Map([
  ['f1', { id: 'f1', name: 'Теплица', version: '1.3.0', size: 912384, md5: 'a'.repeat(32), sha256: '3f9a1c0be41d7a55'.repeat(4), created_at: new Date(Date.now() - 86400e3).toISOString() }],
]);
const otaJobs = new Map([
  ['d9f8e7d6c5b4a3920', { id: 'j-old', device_id: 'd9f8e7d6c5b4a3920', version: '2.0.1', status: 'failed', progress: 40, error: 'после перезагрузки версия 2.0.0, ожидалась 2.0.1 (загрузчик откатил прошивку?)', created_at: new Date(Date.now() - 7200e3).toISOString(), updated_at: new Date(Date.now() - 7000e3).toISOString() }],
]);
const channels = new Map([
  ['c-tg', { id: 'c-tg', type: 'telegram', name: 'Telegram: Андрей', chat_id: '5551234', chat_title: 'Андрей', own_bot: false, min_level: 'info', enabled: true, last_sent_at: new Date(Date.now() - 3600e3).toISOString(), last_error: null }],
  ['c-wh', { id: 'c-wh', type: 'webhook', name: 'hooks.example.com', url: 'https://hooks.example.com/iot', min_level: 'alert', enabled: true, last_sent_at: null, last_error: '2026-10-28T10:00:00Z: HTTP 502' }],
]);

async function api(req, res, url) {
  const p = url.pathname;
  const m = (re) => re.exec(p);
  const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : null;
  let x;
  if (p === '/api/auth/login' || p === '/api/auth/register') return json(res, 200, { token: 'demo.token.value', user: USER });
  if (!req.headers.authorization) return json(res, 401, { error: 'unauthorized' });
  if (p === '/api/me') return json(res, 200, { ...USER, totp_enabled: totp.enabled, recovery_codes_left: totp.enabled ? 10 : 0 });
  if (p === '/api/auth/logout') return json(res, 204);
  if (p === '/api/auth/password') return json(res, 200, { ok: true, sessions_closed: 1 });
  if (p === '/api/auth/totp/setup') return json(res, 200, { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauth_url: `otpauth://totp/IoT%20localhost%3A${encodeURIComponent(USER.email)}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=IoT+localhost&algorithm=SHA1&digits=6&period=30` });
  if (p === '/api/auth/totp/enable') { totp.enabled = true; return json(res, 200, { enabled: true, recovery_codes: Array.from({ length: 10 }, (_, i) => `ab${i}c-d3fg-h4jk`) }); }
  if (p === '/api/auth/totp/disable') { totp.enabled = false; return json(res, 200, { enabled: false }); }
  if (p === '/api/sessions') return json(res, 200, { sessions: [
    { id: 's1', current: true, created_at: ago(86400 * 2), last_seen_at: ago(5), user_agent: req.headers['user-agent'], ip: '91.144.1.20' },
    { id: 's2', current: false, created_at: ago(86400 * 9), last_seen_at: ago(3600 * 20), user_agent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36', ip: '176.59.3.4' },
  ] });
  if (p === '/api/sessions/revoke-others') return json(res, 200, { closed: 1 });
  if (p === '/api/devices' && req.method === 'GET') return json(res, 200, { devices: [...devices.values()] });
  if (p === '/api/devices' && req.method === 'POST') {
    const d = { id: rid('d', 8), name: body.name, state: 'new', provisioned: false, bridge_id: null, created_at: now(), last_seen: null, meta: null, last_values: {} };
    devices.set(d.id, d);
    return json(res, 201, { device: d, claim_token: crypto.randomBytes(24).toString('base64url'), claim_expires_at: new Date(Date.now() + 1800e3).toISOString() });
  }
  if ((x = m(/^\/api\/devices\/(\w+)\/telemetry$/))) return json(res, 200, telemetry(x[1], url.searchParams));
  if ((x = m(/^\/api\/devices\/(\w+)\/commands$/))) {
    const d = devices.get(x[1]);
    setTimeout(() => { d.last_values[body.property] = body.value; broadcast(`dev/${d.id}/${body.property}`, String(body.value)); }, 400);
    return json(res, 202, { queued: true });
  }
  if ((x = m(/^\/api\/devices\/(\w+)\/claim$/))) return json(res, 200, { claim_token: crypto.randomBytes(24).toString('base64url'), claim_expires_at: new Date(Date.now() + 1800e3).toISOString() });
  if ((x = m(/^\/api\/devices\/(\w+)$/))) {
    const d = devices.get(x[1]);
    if (!d) return json(res, 404, { error: 'device_not_found' });
    if (req.method === 'PUT') { d.name = body.name; return json(res, 200, d); }
    if (req.method === 'DELETE') { devices.delete(d.id); return json(res, 204); }
    return json(res, 200, d);
  }
  if (p === '/api/scenarios' && req.method === 'GET') return json(res, 200, { scenarios: [...scenarios.values()] });
  if (p === '/api/scenarios' && req.method === 'POST') { const s = { ...body, id: crypto.randomUUID(), last_run_at: null, last_error: null }; scenarios.set(s.id, s); return json(res, 201, s); }
  if ((x = m(/^\/api\/scenarios\/([\w-]+)\/run$/))) return json(res, 202, { queued: true });
  if ((x = m(/^\/api\/scenarios\/([\w-]+)$/))) {
    const s = scenarios.get(x[1]);
    if (!s) return json(res, 404, { error: 'scenario_not_found' });
    if (req.method === 'PUT') { Object.assign(s, body, { id: s.id }); return json(res, 200, s); }
    if (req.method === 'DELETE') { scenarios.delete(s.id); return json(res, 204); }
    return json(res, 200, s);
  }
  if (p === '/api/notifications') {
    const unread = notifications.filter((n) => !n.read_at).length;
    const list = url.searchParams.get('unread') === 'true' ? notifications.filter((n) => !n.read_at) : notifications;
    return json(res, 200, { notifications: list, unread });
  }
  if (p === '/api/notifications/read') { notifications = notifications.map((n) => ({ ...n, read_at: n.read_at || now() })); return json(res, 200, { updated: 1 }); }
  if (p === '/api/bridges' && req.method === 'GET') return json(res, 200, { bridges: [...bridges.values()] });
  if (p === '/api/bridges' && req.method === 'POST') {
    const b = { id: rid('b', 8), name: body.name, type: body.type, config: body.config, state: 'new', last_seen: null, created_at: now(), device_count: 0 };
    bridges.set(b.id, b);
    return json(res, 201, { bridge: b, token: crypto.randomBytes(24).toString('base64url') });
  }
  if ((x = m(/^\/api\/bridges\/(\w+)\/token$/))) return json(res, 200, { token: crypto.randomBytes(24).toString('base64url') });
  if ((x = m(/^\/api\/bridges\/(\w+)$/))) {
    const b = bridges.get(x[1]);
    if (req.method === 'PUT') { Object.assign(b, { name: body.name, config: body.config }); return json(res, 200, b); }
    if (req.method === 'DELETE') { bridges.delete(b.id); return json(res, 204); }
    return json(res, 200, b);
  }
  if (p === '/api/firmwares' && req.method === 'GET') return json(res, 200, { firmwares: [...firmwares.values()], max_bytes: 4 * 1024 * 1024 });
  if (p === '/api/firmwares' && req.method === 'POST') {
    const f = { id: crypto.randomUUID(), name: url.searchParams.get('name'), version: url.searchParams.get('version'), size: Number(req.headers['content-length'] || 0), md5: 'x'.repeat(32), sha256: crypto.randomBytes(32).toString('hex'), created_at: now() };
    firmwares.set(f.id, f);
    return json(res, 201, f);
  }
  if ((x = m(/^\/api\/firmwares\/([\w-]+)$/))) { firmwares.delete(x[1]); return json(res, 204); }
  if ((x = m(/^\/api\/devices\/(\w+)\/ota$/))) {
    if (req.method === 'GET') return json(res, 200, { job: otaJobs.get(x[1]) || null, current_version: devices.get(x[1])?.meta?.fw ?? null });
    if (req.method === 'DELETE') { const j = otaJobs.get(x[1]); if (j) j.status = 'cancelled'; return json(res, 200, { cancelled: j ? 1 : 0 }); }
    const fw = firmwares.get(body.firmware_id);
    const job = { id: crypto.randomUUID(), device_id: x[1], firmware_id: fw.id, version: fw.version, status: 'pending', progress: null, error: null, created_at: now(), updated_at: now() };
    otaJobs.set(x[1], job);
    const topic = `dev/${x[1]}/$ota`;
    let pct = 0;
    const t = setInterval(() => {
      if (job.status === 'cancelled') return clearInterval(t);
      pct += 20;
      if (pct <= 100) { job.status = 'downloading'; job.progress = pct; broadcast(topic, JSON.stringify({ job: job.id, status: 'downloading', progress: pct })); return; }
      clearInterval(t);
      job.status = 'done';
      const d = devices.get(x[1]);
      if (d.meta) d.meta.fw = fw.version;
      broadcast(topic, JSON.stringify({ job: job.id, status: 'rebooting', progress: 100 }));
      setTimeout(() => { broadcast(`dev/${x[1]}/$meta`, JSON.stringify(d.meta)); broadcast(topic, JSON.stringify({ job: job.id, status: 'done' })); }, 1500);
    }, 700);
    return json(res, 202, { job });
  }
  if (p === '/api/channels' && req.method === 'GET') return json(res, 200, { channels: [...channels.values()], telegram_bot: 'iot_demo_bot', webpush_public_key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' });
  if (p === '/api/channels' && req.method === 'POST') {
    const c = { id: crypto.randomUUID(), type: body.type, name: body.name || (body.type === 'webhook' ? new URL(body.url).host : `Telegram ${body.chat_id}`),
      min_level: body.min_level || 'info', enabled: true, last_sent_at: null, last_error: null, created_at: now(),
      ...(body.type === 'webhook' ? { url: body.url } : { chat_id: body.chat_id, own_bot: true }) };
    channels.set(c.id, c);
    return json(res, 201, { channel: c, secret: body.type === 'webhook' ? crypto.randomBytes(24).toString('base64url') : undefined });
  }
  if (p === '/api/channels/telegram-link') return json(res, 200, { url: 'https://t.me/iot_demo_bot?start=demo', expires_at: new Date(Date.now() + 900e3).toISOString() });
  if ((x = m(/^\/api\/channels\/([\w-]+)\/test$/))) { const c = channels.get(x[1]); c.last_sent_at = now(); c.last_error = null; return json(res, 200, { ok: true }); }
  if ((x = m(/^\/api\/channels\/([\w-]+)$/))) {
    const c = channels.get(x[1]);
    if (!c) return json(res, 404, { error: 'channel_not_found' });
    if (req.method === 'PUT') { Object.assign(c, body); return json(res, 200, c); }
    if (req.method === 'DELETE') { channels.delete(c.id); return json(res, 204); }
  }
  return json(res, 404, { error: 'not_found' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC)) return json(res, 403, {});
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      // та же политика, что отдаёт nginx в продакшене
      'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://${req.headers.host}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
});
server.on('upgrade', (req, sock) => (req.url === '/mqtt' ? upgrade(req, sock) : sock.destroy()));
server.listen(PORT, () => console.log(`mock panel on http://localhost:${PORT}`));
