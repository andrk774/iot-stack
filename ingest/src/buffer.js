// Буфер между MQTT и БД: копит значения и пишет пачками.

export class IngestBuffer {
  constructor({ maxRows = 50_000 } = {}) {
    this.maxRows = maxRows;
    this.dropped = 0;
    this.reset();
  }

  reset() {
    this.rows = [];               // { time, deviceId, property, num, text }
    this.latest = new Map();      // deviceId -> { prop: value }
    this.states = new Map();      // deviceId -> state
    this.metas = new Map();       // deviceId -> meta
    this.bridges = new Map();     // bridgeId -> state
  }

  add(ev, now = new Date()) {
    if (ev.kind === 'value') {
      if (this.rows.length >= this.maxRows) {
        this.rows.shift();
        this.dropped++;
      }
      this.rows.push({ time: now, deviceId: ev.deviceId, property: ev.property, num: ev.num, text: ev.text });
      const last = this.latest.get(ev.deviceId) ?? {};
      last[ev.property] = ev.num ?? ev.text;
      this.latest.set(ev.deviceId, last);
    } else if (ev.kind === 'state') {
      this.states.set(ev.deviceId, ev.state);
    } else if (ev.kind === 'meta') {
      this.metas.set(ev.deviceId, ev.meta);
    } else if (ev.kind === 'bridge_state') {
      this.bridges.set(ev.bridgeId, ev.state);
    }
  }

  get size() {
    return this.rows.length + this.states.size + this.metas.size + this.bridges.size;
  }

  /** Забрать накопленное и начать новый буфер */
  take() {
    const batch = { rows: this.rows, latest: this.latest, states: this.states, metas: this.metas, bridges: this.bridges };
    this.reset();
    return batch;
  }

  /** Вернуть пачку обратно после ошибки записи (новые данные приоритетнее) */
  restore(batch) {
    const keep = Math.max(0, this.maxRows - this.rows.length);
    const rows = batch.rows.slice(-keep);
    this.dropped += batch.rows.length - rows.length;
    this.rows = rows.concat(this.rows);
    for (const [id, vals] of batch.latest) this.latest.set(id, { ...vals, ...(this.latest.get(id) ?? {}) });
    for (const [id, s] of batch.states) if (!this.states.has(id)) this.states.set(id, s);
    for (const [id, m] of batch.metas) if (!this.metas.has(id)) this.metas.set(id, m);
    for (const [id, st] of batch.bridges || []) if (!this.bridges.has(id)) this.bridges.set(id, st);
  }
}

/** SQL-запросы для пачки: [text, values][] */
export function batchToQueries(batch) {
  const q = [];
  if (batch.rows.length) {
    // JOIN с devices отбрасывает данные удалённых устройств
    q.push([
      `INSERT INTO telemetry (time, device_id, property, value_num, value_text)
       SELECT u.time, u.device_id, u.property, u.value_num, u.value_text
       FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::float8[], $5::text[])
            AS u(time, device_id, property, value_num, value_text)
       JOIN devices d ON d.id = u.device_id`,
      [
        batch.rows.map((r) => r.time),
        batch.rows.map((r) => r.deviceId),
        batch.rows.map((r) => r.property),
        batch.rows.map((r) => r.num),
        batch.rows.map((r) => r.text),
      ],
    ]);
  }
  for (const [id, vals] of batch.latest) {
    q.push([
      'UPDATE devices SET last_values = last_values || $2::jsonb, last_seen = now() WHERE id = $1',
      [id, JSON.stringify(vals)],
    ]);
  }
  for (const [id, state] of batch.states) {
    q.push(['UPDATE devices SET state = $2, last_seen = now() WHERE id = $1', [id, state]]);
  }
  for (const [id, meta] of batch.metas) {
    q.push(['UPDATE devices SET meta = $2::jsonb WHERE id = $1', [id, JSON.stringify(meta)]]);
  }
  for (const [id, state] of batch.bridges || []) {
    q.push(['UPDATE bridges SET state = $2, last_seen = now() WHERE id = $1', [id, state]]);
    if (state === 'lost' || state === 'disconnected') {
      q.push(['UPDATE devices SET state = $2 WHERE bridge_id = $1', [id, state]]);
    }
  }
  return q;
}
