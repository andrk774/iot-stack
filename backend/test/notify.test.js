// Уведомления: защита исходящих запросов, вебхук с подписью, Telegram-бот, рассылка по каналам.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { isPublicAddress, checkUrl, postOut } from '../src/notify/net.js';
import { Dispatcher, PermanentError, makeSenders, signWebhook } from '../src/notify/dispatcher.js';
import { TelegramApi, TelegramBot, formatText } from '../src/notify/telegram.js';

test('internal addresses are not public', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '224.0.0.1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '149.154.167.220', '2a00:1450:4010::1', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  assert.equal(isPublicAddress('not-an-ip'), false);
});

test('checkUrl: https only, no credentials, no internal IP literals', () => {
  assert.ok(checkUrl('https://example.com/hook'));
  for (const bad of ['http://example.com/', 'ftp://x/', 'https://u:p@example.com/', 'https://127.0.0.1/', 'https://[::1]/',
    'https://2130706433/', 'https://10.0.0.1:8443/x', 'nonsense']) {
    assert.throws(() => checkUrl(bad), bad);
  }
  assert.ok(checkUrl('http://127.0.0.1:9/', { allowPrivate: true }));
});

test('postOut refuses hostnames that resolve to internal addresses', async () => {
  await assert.rejects(postOut('https://localhost:9/x', { body: '{}' }), (e) => e.code === 'private_address');
});

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('webhook: signed JSON body, non-2xx is an error, redirects are not followed', async () => {
  const got = [];
  const { srv, url } = await listen((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      got.push({ headers: req.headers, body: b, path: req.url });
      if (req.url === '/fail') { res.writeHead(500); res.end(); return; }
      if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
      res.writeHead(204); res.end();
    });
  });
  try {
    const senders = makeSenders({ allowPrivate: true, now: () => 1_700_000_000_000 });
    const n = { id: '7', level: 'alert', message: 'Протечка', scenario_id: null, scenario_name: 'Ванная', created_at: new Date(0) };
    const ch = { config: { url: `${url}/ok`, secret: 'sekret' } };
    await senders.webhook(ch, n);
    const h = got[0].headers;
    assert.equal(h['x-iot-timestamp'], '1700000000');
    assert.equal(h['x-iot-signature'], signWebhook('sekret', '1700000000', got[0].body));
    const expected = 'sha256=' + crypto.createHmac('sha256', 'sekret').update(`1700000000.${got[0].body}`).digest('hex');
    assert.equal(h['x-iot-signature'], expected);
    assert.deepEqual(JSON.parse(got[0].body), { id: 7, level: 'alert', message: 'Протечка', scenario_id: null, scenario_name: 'Ванная', created_at: '1970-01-01T00:00:00.000Z' });
    await assert.rejects(senders.webhook({ config: { url: `${url}/fail`, secret: 's' } }, n), /HTTP 500/);
    await assert.rejects(senders.webhook({ config: { url: `${url}/redirect`, secret: 's' } }, n), /HTTP 302/);
    assert.equal(got.filter((g) => g.path === '/ok').length, 1); // по редиректу не ходили
  } finally {
    srv.close();
  }
});

test('telegram api errors never contain the bot token', async () => {
  const token = '123456:' + 'A'.repeat(35);
  const api = new TelegramApi({ fetchImpl: async (u) => { throw new TypeError(`fetch failed for ${u}`); } });
  await assert.rejects(api.sendMessage(token, '1', 'x'), (e) => !e.message.includes(token));
  const api2 = new TelegramApi({ fetchImpl: async () => new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 }) });
  await assert.rejects(api2.sendMessage(token, '1', 'x'), (e) => e.status === 403 && !e.message.includes(token));
});

test('telegram sender: blocked bot is a permanent error', async () => {
  const telegram = { sendMessage: async () => { throw Object.assign(new Error('Forbidden: bot was blocked'), { status: 403 }); } };
  const s = makeSenders({ telegram, platformBotToken: 't' });
  await assert.rejects(s.telegram({ config: { bot: 'platform', chat_id: '1' } }, { level: 'info', message: 'x' }), PermanentError);
  const s2 = makeSenders({ telegram, platformBotToken: '' });
  await assert.rejects(s2.telegram({ config: { bot: 'platform', chat_id: '1' } }, { level: 'info', message: 'x' }), /TELEGRAM_BOT_TOKEN/);
});

test('formatText: level icon and scenario name', () => {
  assert.equal(formatText({ level: 'alert', message: 'Дым', scenario_name: 'Кухня' }), '🚨 Дым\n— Кухня');
  assert.equal(formatText({ level: 'info', message: 'Привет' }), 'ℹ️ Привет');
});

test('telegram bot: /start <code> links, /stop unlinks, other text ignored', async () => {
  const sent = [];
  const linked = [];
  const bot = new TelegramBot({
    api: { sendMessage: async (t, chat, text) => sent.push([chat, text]) },
    token: 't',
    linkChat: async (code, chat) => { linked.push([code, chat]); return code === 'good-code-1234567890' ? 'linked' : 'invalid'; },
    unlinkChat: async (id) => (id === '42' ? 1 : 0),
    log: {},
  });
  const msg = (text, chat = { id: 42, type: 'private', first_name: 'Андрей' }) => ({ update_id: 1, message: { text, chat } });
  await bot.handle(msg('/start good-code-1234567890'));
  assert.deepEqual(linked[0], ['good-code-1234567890', { id: '42', title: 'Андрей' }]);
  assert.match(sent.at(-1)[1], /Готово/);
  await bot.handle(msg('/start bad'));
  assert.match(sent.at(-1)[1], /не подошёл/);
  await bot.handle(msg('/stop@my_iot_bot'));
  assert.match(sent.at(-1)[1], /отключены/);
  const before = sent.length;
  await bot.handle(msg('привет'));
  await bot.handle({ update_id: 2, edited_message: {} });
  assert.equal(sent.length, before);
});

// ---------- рассылка ----------
function fakeDb(notifications, channels) {
  const updates = [];
  return {
    updates,
    async query(sql, p = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('UPDATE notifications n SET dispatched_at')) {
        const batch = notifications.filter((n) => !n.dispatched).slice(0, 50);
        batch.forEach((n) => { n.dispatched = true; });
        return { rows: batch };
      }
      if (s.startsWith('SELECT id, owner_id, type, config, min_level FROM notification_channels')) {
        return { rows: channels.filter((c) => c.enabled !== false && p[0].includes(c.owner_id)) };
      }
      if (s.startsWith('UPDATE notification_channels')) {
        updates.push([s, p]);
        if (s.includes('enabled = false')) channels.find((c) => c.id === p[0]).enabled = false;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected ${s}`);
    },
  };
}

test('dispatcher: level filter, per-owner routing, order, retry, permanent disable', async () => {
  const now = Date.now();
  const N = (id, owner, level, ago = 0) => ({ id: String(id), owner_id: owner, level, message: `m${id}`, created_at: new Date(now - ago) });
  const notifications = [N(1, 'a', 'info'), N(2, 'a', 'alert'), N(3, 'b', 'warning'), N(4, 'a', 'alert', 2 * 3600_000)];
  const channels = [
    { id: 'c1', owner_id: 'a', type: 'x', config: {}, min_level: 'info' },
    { id: 'c2', owner_id: 'a', type: 'x', config: {}, min_level: 'alert' },
    { id: 'c3', owner_id: 'b', type: 'flaky', config: {}, min_level: 'info' },
    { id: 'c4', owner_id: 'a', type: 'dead', config: {}, min_level: 'info' },
  ];
  const got = [];
  let flaky = 0;
  let dead = 0;
  const db = fakeDb(notifications, channels);
  const d = new Dispatcher({
    db,
    log: {},
    sleep: async () => {},
    senders: {
      x: async (ch, n) => got.push(`${ch.id}:${n.id}`),
      flaky: async (ch, n) => { if (flaky++ === 0) throw new Error('timeout'); got.push(`${ch.id}:${n.id}`); },
      dead: async () => { dead++; throw new PermanentError('blocked'); },
    },
  });
  await d.kick();
  assert.deepEqual(got.sort(), ['c1:1', 'c1:2', 'c2:2', 'c3:3']); // n4 устарело, c2 только alert
  assert.equal(flaky, 2); // одна повторная попытка
  assert.equal(dead, 1); // после постоянной ошибки канал выключен, второе сообщение не отправлялось
  assert.equal(channels.find((c) => c.id === 'c4').enabled, false);
  assert.ok(notifications.every((n) => n.dispatched));
  await d.kick(); // повторно ничего не шлётся
  assert.equal(got.length, 4);
});

test('dispatcher: concurrent kicks collapse, failures keep going', async () => {
  const notifications = [{ id: '1', owner_id: 'a', level: 'info', message: 'x', created_at: new Date() }];
  const channels = [{ id: 'c1', owner_id: 'a', type: 'x', config: {}, min_level: 'info' }];
  let calls = 0;
  const d = new Dispatcher({ db: fakeDb(notifications, channels), log: {}, sleep: async () => {}, senders: { x: async () => { calls++; } } });
  await Promise.all([d.kick(), d.kick(), d.kick()]);
  assert.equal(calls, 1);
});
