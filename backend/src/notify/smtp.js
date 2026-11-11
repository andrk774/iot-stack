// Минимальный SMTP-клиент без зависимостей: одно письмо text/plain за соединение.
//
//   smtps://user:pass@smtp.example.com:465   — TLS сразу (порт 465)
//   smtp://user:pass@smtp.example.com:587    — STARTTLS; без него пароль не отправляется
//   smtp://relay:25                          — без авторизации (STARTTLS, если сервер умеет)
//
// Сертификат сервера проверяется всегда. AUTH PLAIN или LOGIN — что предложит сервер.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const ADDR_RE = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/;

export class SmtpError extends Error {}

/** "Имя <a@b>" | "a@b" -> { name, address } */
export function parseMailbox(s) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(String(s));
  const name = m ? m[1].replace(/^"|"$/g, '') : '';
  const address = (m ? m[2] : String(s)).trim();
  if (!ADDR_RE.test(address)) throw new SmtpError(`неверный адрес: ${address}`);
  if (/[\r\n]/.test(name)) throw new SmtpError('перевод строки в имени отправителя');
  return { name, address };
}

const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
const encodeWord = (s) => (isAscii(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');

/** Готовое письмо (заголовки + base64-тело) */
export function buildMessage({ from, to, subject, text, date = new Date() }) {
  const f = parseMailbox(from);
  const t = parseMailbox(to);
  const domain = f.address.split('@')[1];
  const headers = [
    `From: ${f.name ? `${encodeWord(f.name)} <${f.address}>` : f.address}`,
    `To: ${t.address}`,
    `Subject: ${encodeWord(String(subject).replace(/[\r\n]+/g, ' '))}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  // base64 не содержит точек, так что dot-stuffing не нужен
  return `${headers.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(String(text).replace(/\r?\n/g, '\r\n')).toString('base64'))}`;
}

/** Ответы сервера построчно: { code, text } */
class Reader {
  constructor() {
    this.buf = '';
    this.lines = [];
    this.replies = [];
    this.waiters = [];
    this.error = null;
  }

  attach(socket) {
    this.detach();
    this.socket = socket;
    this.onData = (d) => this.push(d.toString('utf8'));
    this.onError = (e) => this.fail(e);
    this.onClose = () => this.fail(new SmtpError('сервер закрыл соединение'));
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  detach() {
    if (!this.socket) return;
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  push(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (line.length < 4 || line[3] === ' ') {
        const reply = { code: Number(line.slice(0, 3)), text: this.lines.map((l) => l.slice(4)).join('\n') };
        this.lines = [];
        const w = this.waiters.shift();
        if (w) w.resolve(reply); else this.replies.push(reply);
      }
    }
  }

  fail(e) {
    this.error ??= e;
    for (const w of this.waiters.splice(0)) w.reject(this.error);
  }

  read() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function connect(url, timeoutMs) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const secure = url.protocol === 'smtps:';
  const port = Number(url.port) || (secure ? 465 : 587);
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
      : net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new SmtpError('таймаут SMTP')));
    socket.once(secure ? 'secureConnect' : 'connect', () => resolve({ socket, secure, host }));
    socket.once('error', reject);
  });
}

/**
 * Отправить письмо.
 * @param {string} smtpUrl  smtp(s)://[user:pass@]host[:port]
 * @param {{ from: string, to: string, subject: string, text: string }} mail
 * @param {{ timeoutMs?: number, name?: string }} [opts]  name — имя для EHLO
 */
export async function sendMail(smtpUrl, mail, { timeoutMs = 15_000, name = 'localhost' } = {}) {
  const url = new URL(smtpUrl);
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') throw new SmtpError('SMTP_URL: нужна схема smtp:// или smtps://');
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const message = buildMessage(mail);
  const from = parseMailbox(mail.from).address;
  const to = parseMailbox(mail.to).address;

  let { socket, secure, host } = await connect(url, timeoutMs);
  const r = new Reader();
  r.attach(socket);
  const expect = async (codes, what) => {
    const reply = await r.read();
    if (!codes.includes(reply.code)) {
      throw Object.assign(new SmtpError(`${what}: ${reply.code} ${reply.text}`.slice(0, 300)), { code: reply.code, stage: what });
    }
    return reply;
  };
  const cmd = (line, codes, what = line.split(' ')[0]) => {
    socket.write(`${line}\r\n`);
    return expect(codes, what);
  };

  try {
    await expect([220], 'приветствие');
    let ehlo = await cmd(`EHLO ${name}`, [250]);
    if (!secure && /^STARTTLS\b/im.test(ehlo.text)) {
      await cmd('STARTTLS', [220]);
      r.detach();
      socket = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket, servername: net.isIP(host) ? undefined : host }, () => resolve(s));
        s.once('error', reject);
      });
      secure = true;
      r.attach(socket);
      ehlo = await cmd(`EHLO ${name}`, [250]);
    }
    if (user) {
      if (!secure) throw new SmtpError('сервер не поддерживает TLS — пароль не отправлен');
      const auth = /^AUTH\b(.*)$/im.exec(ehlo.text)?.[1].toUpperCase() ?? '';
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
        await cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235], 'AUTH');
      } else {
        await cmd('AUTH LOGIN', [334], 'AUTH');
        await cmd(Buffer.from(user).toString('base64'), [334], 'AUTH');
        await cmd(Buffer.from(pass).toString('base64'), [235], 'AUTH');
      }
    }
    await cmd(`MAIL FROM:<${from}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);
    socket.write(`${message}\r\n`);
    await cmd('.', [250], 'DATA');
    await cmd('QUIT', [221]).catch(() => {});
  } finally {
    r.detach();
    socket.destroy();
  }
}
