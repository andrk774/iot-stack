// API-токены, канал email (SMTP-клиент, отправитель), /metrics — без PostgreSQL (SQL проверяет pg.integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { sendMail, buildMessage, parseMailbox, SmtpError } from '../src/notify/smtp.js';
import { makeSenders, emailContent, PermanentError } from '../src/notify/dispatcher.js';
import { makeAuth, isApiToken } from '../src/routes/common.js';
import { createEmqxAdmin } from '../src/emqx.js';
import { createServer } from '../src/http.js';
import { metricsRoutes } from '../src/routes/metrics.js';
import { Metrics } from '../../shared/metrics.js';
import { sha256 } from '../src/security.js';

// ---------- SMTP ----------

/** Фейковый SMTP-сервер: записывает команды и тело письма */
async function fakeSmtp({ ehlo = ['250-fake', '250 AUTH PLAIN LOGIN'] } = {}) {
  const log = { commands: [], data: '' };
  const server = net.createServer((sock) => {
    let inData = false;
    let buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else log.data += `${line}\n`;
          continue;
        }
        log.commands.push(line);
        if (line.startsWith('EHLO')) sock.write(`${ehlo.join('\r\n')}\r\n`);
        else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); } else if (line === 'QUIT') sock.end('221 bye\r\n');
        else if (line.startsWith('RCPT') && line.includes('nobody')) sock.write('550 no such user\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { log, url: `smtp://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('smtp: письмо без авторизации, тема и тело в UTF-8', async () => {
  const srv = await fakeSmtp();
  try {
    await sendMail(srv.url, { from: 'IoT <iot@example.com>', to: 'me@example.com', subject: 'Тревога: протечка', text: 'Вода на полу\n.\nвторая строка' });
    assert.deepEqual(srv.log.commands.slice(0, 4), ['EHLO localhost', 'MAIL FROM:<iot@example.com>', 'RCPT TO:<me@example.com>', 'DATA']);
    assert.match(srv.log.data, /^Subject: =\?UTF-8\?B\?/m);
    const body = srv.log.data.split('\n\n')[1].replace(/\n/g, '');
    assert.equal(Buffer.from(body, 'base64').toString(), 'Вода на полу\r\n.\r\nвторая строка');
  } finally { srv.close(); }
});

test('smtp: пароль не уходит без TLS; отказ RCPT — ошибка со стадией и кодом', async () => {
  const srv = await fakeSmtp({ ehlo: ['250-fake', '250 AUTH PLAIN'] });
  try {
    await assert.rejects(sendMail(srv.url.replace('smtp://', 'smtp://user:secret@'), { from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' }), /TLS/);
    assert.ok(!srv.log.commands.some((c) => c.startsWith('AUTH')));
    await assert.rejects(sendMail(srv.url, { from: 'a@b.c', to: 'nobody@e.f', subject: 's', text: 't' }),
      (e) => e instanceof SmtpError && e.stage === 'RCPT' && e.code === 550);
  } finally { srv.close(); }
});

test('smtp: заголовки не инжектируются', () => {
  assert.throws(() => parseMailbox('a@b.c\r\nBcc: x@y.z'), SmtpError);
  assert.throws(() => buildMessage({ from: 'a@b.c', to: 'x@y.z>\r\nBcc: q@q.q', subject: 's', text: 't' }), SmtpError);
  assert.ok(!/^Bcc:/m.test(buildMessage({ from: 'a@b.c', to: 'x@y.z', subject: 'line1\r\nBcc: q@q.q', text: 't' })));
});

test('канал email: текст письма, адрес не существует — канал выключается', async () => {
  const n = { id: 1, level: 'alert', message: 'Протечка', scenario_name: 'Ванная', created_at: '2026-11-11T10:00:00Z' };
  const { subject, text } = emailContent(n, 'iot.test');
  assert.equal(subject, '[IoT] Тревога: Ванная');
  assert.match(text, /^Протечка\n/);
  assert.match(text, /https:\/\/iot\.test\/#\/notifications/);

  const sent = [];
  const ok = makeSenders({ mail: { send: async (to, s) => { sent.push([to, s]); } }, publicHost: 'iot.test' });
  await ok.email({ config: { email: 'me@x.y' } }, n);
  assert.deepEqual(sent, [['me@x.y', '[IoT] Тревога: Ванная']]);

  const rejected = makeSenders({ mail: { send: async () => { throw Object.assign(new SmtpError('RCPT: 550'), { stage: 'RCPT', code: 550 }); } } });
  await assert.rejects(rejected.email({ config: { email: 'x@y.z' } }, n), PermanentError);
  const busy = makeSenders({ mail: { send: async () => { throw Object.assign(new SmtpError('RCPT: 451'), { stage: 'RCPT', code: 451 }); } } });
  await assert.rejects(busy.email({ config: { email: 'x@y.z' } }, n), (e) => !(e instanceof PermanentError), '4xx — временная, повторим');
  await assert.rejects(makeSenders({}).email({ config: { email: 'x@y.z' } }, n), /SMTP_URL/);
});

// ---------- API-токены ----------

const TOKEN_RW = `iot_${'a'.repeat(40)}`;
const TOKEN_RO = `iot_${'b'.repeat(40)}`;
function tokenDb() {
  const rows = new Map([[sha256(TOKEN_RW), { id: 't1', owner_id: 'u1', scope: 'write', last_used_at: null }],
    [sha256(TOKEN_RO), { id: 't2', owner_id: 'u1', scope: 'read', last_used_at: new Date() }]]);
  const touched = [];
  return {
    touched,
    async query(sql, p) {
      if (sql.includes('FROM api_tokens')) return { rows: rows.has(p[0]) ? [rows.get(p[0])] : [] };
      if (sql.startsWith('UPDATE api_tokens SET last_used_at')) { touched.push(p[0]); return { rowCount: 1 }; }
      if (sql.includes('FROM sessions')) return { rows: [] };
      throw new Error(`unexpected ${sql}`);
    },
  };
}
const req = (method, token) => ({ method, headers: { authorization: `Bearer ${token}` } });
const code = async (p) => { try { return await p; } catch (e) { return `${e.status} ${e.code}`; } };

test('API-токен: права read/write, только-сеансовые маршруты, неизвестный токен', async () => {
  const db = tokenDb();
  const cfg = { jwtSecret: 'j'.repeat(40) };
  const auth = makeAuth(cfg, db);
  const panelOnly = makeAuth(cfg, db, { session: true });
  assert.equal(isApiToken(TOKEN_RW), true);
  assert.equal(isApiToken('eyJhbGciOi.x.y'), false);

  assert.equal(await auth(req('POST', TOKEN_RW)), 'u1');
  assert.equal(await auth(req('GET', TOKEN_RO)), 'u1');
  assert.equal(await code(auth(req('POST', TOKEN_RO))), '403 token_read_only');
  assert.equal(await code(auth(req('GET', `iot_${'c'.repeat(40)}`))), '401 unauthorized');
  assert.equal(await code(panelOnly(req('GET', TOKEN_RW))), '403 session_required');
  assert.equal(await code(auth.session(req('GET', TOKEN_RW))), '403 session_required', 'у токена нет сеанса');
  assert.deepEqual(db.touched, ['t1'], 'last_used_at обновляется не чаще раза в минуту');
});

// ---------- /metrics ----------

test('emqx.stats объединяет /stats и /metrics', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => (url.includes('/stats') ? { 'connections.count': 12 } : [{ 'messages.received': 1000 }]),
  });
  const e = createEmqxAdmin({ url: 'http://emqx:18083', key: 'k', secret: 's', fetchImpl, log: {} });
  assert.deepEqual(await e.stats(), { 'connections.count': 12, 'messages.received': 1000 });
  const off = createEmqxAdmin({ url: 'http://emqx:18083', key: '', secret: '', log: {} });
  assert.equal(await off.stats(), null);
});

test('/metrics: токен, сводка из БД, EMQX, метрики сервисов; недоступный сервис — iot_up 0', async () => {
  const ingest = http.createServer((q, s) => s.end('# HELP iot_ingest_written_rows_total x\n# TYPE iot_ingest_written_rows_total counter\niot_ingest_written_rows_total 5\n'));
  await new Promise((r) => ingest.listen(0, '127.0.0.1', r));
  const db = { query: async () => ({ rows: [{ users: 2, devices: 3, devices_ready: 1, devices_lost: 1, bridges: 0, scenarios_enabled: 4, scenarios_failing: 1, notifications_hour: 0, notifications_queued: 2, channels_failing: 0 }] }) };
  const httpMetrics = new Metrics();
  httpMetrics.counter('iot_backend_http_requests_total', 'r').inc({ code: '2xx' });
  const config = {
    metricsToken: 'm'.repeat(24),
    metricsSources: { ingest: `http://127.0.0.1:${ingest.address().port}/metrics`, scenarios: 'http://127.0.0.1:1/metrics' },
  };
  const srv = createServer(metricsRoutes({ db, config, emqx: { stats: async () => ({ 'connections.count': 7 }) }, httpMetrics, log: {} }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/metrics`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const res = await fetch(url, { headers: { authorization: `Bearer ${config.metricsToken}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
    const text = await res.text();
    for (const re of [/^iot_up\{service="backend"\} 1$/m, /^iot_up\{service="emqx"\} 1$/m, /^iot_up\{service="ingest"\} 1$/m,
      /^iot_up\{service="scenarios"\} 0$/m, /^iot_emqx_connections 7$/m, /^iot_devices\{state="ready"\} 1$/m,
      /^iot_notifications_queued 2$/m, /^iot_ingest_written_rows_total 5$/m, /^iot_backend_http_requests_total\{code="2xx"\} 1$/m]) {
      assert.match(text, re);
    }
    const off = createServer(metricsRoutes({ db, config: { metricsSources: {} }, httpMetrics, log: {} }));
    await new Promise((r) => off.listen(0, '127.0.0.1', r));
    assert.equal((await fetch(`http://127.0.0.1:${off.address().port}/metrics`)).status, 404, 'без METRICS_TOKEN выключен');
    off.close();
  } finally { srv.close(); ingest.close(); }
});
