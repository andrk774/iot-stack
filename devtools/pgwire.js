// Минимальный клиент протокола PostgreSQL для интеграционных тестов (без npm-зависимостей).
// Повторяет интерфейс node-postgres в той части, что использует код: query(sql, params) -> { rows, rowCount },
// pool.connect() -> client { query, release }. Только trust-аутентификация. В продакшене используется pg.
import net from 'node:net';

const PARSERS = {
  16: (s) => s === 't',
  21: Number, 23: Number, 26: Number, 700: Number, 701: Number,
  20: String, 1700: String,                       // как node-pg: int8 и numeric строкой
  114: JSON.parse, 3802: JSON.parse,
  17: (s) => Buffer.from(s.slice(2), 'hex'),          // bytea (формат hex) -> Buffer, как node-pg
  1114: (s) => new Date(`${s}Z`), 1184: (s) => new Date(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')),
};

function serialize(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex')}`;
  if (Array.isArray(v)) {
    return `{${v.map((x) => (x === null || x === undefined ? 'NULL' : `"${String(serialize(x)).replace(/["\\]/g, '\\$&')}"`)).join(',')}}`;
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

class Conn {
  constructor({ host, port, user, database }) {
    this.opts = { host, port, user, database };
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.queue = Promise.resolve();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.opts.port, this.opts.host);
      this.sock.on('error', reject);
      this.sock.on('data', (d) => this.onData(d));
      this.sock.on('connect', async () => {
        const params = Buffer.from(`user\0${this.opts.user}\0database\0${this.opts.database}\0\0`);
        const head = Buffer.alloc(8);
        head.writeInt32BE(8 + params.length, 0);
        head.writeInt32BE(196608, 4);
        this.sock.write(Buffer.concat([head, params]));
        try { await this.readUntilReady(); resolve(this); } catch (e) { reject(e); }
      });
    });
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    const w = this.waiters.shift();
    if (w) w();
  }

  async readMsg() {
    while (this.buf.length < 5 || this.buf.length < 1 + this.buf.readInt32BE(1)) {
      await new Promise((r) => this.waiters.push(r));
    }
    const type = String.fromCharCode(this.buf[0]);
    const len = this.buf.readInt32BE(1);
    const body = this.buf.subarray(5, 1 + len);
    this.buf = this.buf.subarray(1 + len);
    return { type, body };
  }

  async readUntilReady() {
    let error = null;
    let fields = null;
    let rows = [];
    let rowCount = 0;
    for (;;) {
      const { type, body } = await this.readMsg();
      if (type === 'R' && body.readInt32BE(0) !== 0) throw new Error('only trust auth is supported');
      if (type === 'E') {
        const f = {};
        let i = 0;
        while (body[i]) { const code = String.fromCharCode(body[i]); const end = body.indexOf(0, i + 1); f[code] = body.subarray(i + 1, end).toString(); i = end + 1; }
        error = Object.assign(new Error(f.M), { code: f.C, detail: f.D });
      }
      if (type === 'T') {
        const n = body.readInt16BE(0);
        fields = [];
        let i = 2;
        for (let k = 0; k < n; k++) {
          const end = body.indexOf(0, i);
          const name = body.subarray(i, end).toString();
          i = end + 1;
          fields.push({ name, oid: body.readInt32BE(i + 6) });
          i += 18;
        }
        rows = [];
      }
      if (type === 'D') {
        const n = body.readInt16BE(0);
        const row = {};
        let i = 2;
        for (let k = 0; k < n; k++) {
          const len = body.readInt32BE(i);
          i += 4;
          if (len === -1) { row[fields[k].name] = null; continue; }
          const s = body.subarray(i, i + len).toString();
          i += len;
          const p = PARSERS[fields[k].oid];
          row[fields[k].name] = p ? p(s) : s;
        }
        rows.push(row);
      }
      if (type === 'C') {
        const tag = body.subarray(0, body.length - 1).toString();
        const m = /(\d+)$/.exec(tag);
        rowCount = m ? Number(m[1]) : 0;
      }
      if (type === 'A') this.onNotify?.(body);
      if (type === 'Z') {
        if (error) throw error;
        return { rows, rowCount };
      }
    }
  }

  msg(type, ...parts) {
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(5);
    head.write(type, 0);
    head.writeInt32BE(4 + body.length, 1);
    return Buffer.concat([head, body]);
  }

  query(sql, params = []) {
    const run = async () => {
      if (params.length === 0) {
        this.sock.write(this.msg('Q', Buffer.from(`${sql}\0`)));
        return this.readUntilReady();
      }
      const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
      const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
      const values = params.map(serialize).map((v) => (v === null ? i32(-1) : Buffer.concat([i32(Buffer.byteLength(v)), Buffer.from(v)])));
      this.sock.write(Buffer.concat([
        this.msg('P', Buffer.from(`\0${sql}\0`), i16(0)),
        this.msg('B', Buffer.from('\0\0'), i16(0), i16(params.length), ...values, i16(0)),
        this.msg('D', Buffer.from('P\0')),
        this.msg('E', Buffer.from('\0'), i32(0)),
        this.msg('S'),
      ]));
      return this.readUntilReady();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  end() { this.sock.end(); }
}

export class Pool {
  constructor(url) {
    const u = new URL(url);
    this.opts = { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), database: u.pathname.slice(1) };
    this.conns = [];
  }
  async connect() {
    const c = await new Conn(this.opts).connect();
    this.conns.push(c);
    c.release = () => { this.conns = this.conns.filter((x) => x !== c); c.end(); };
    return c;
  }
  async query(sql, params) {
    if (!this.shared) this.shared = this.connect();
    return (await this.shared).query(sql, params);
  }
  async end() { for (const c of this.conns) c.end(); }
}
