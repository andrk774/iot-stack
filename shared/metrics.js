// Метрики в текстовом формате Prometheus без зависимостей: счётчики, gauge и gauge, вычисляемые при сборе.
import http from 'node:http';

const escapeLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labelKey = (labels) => Object.keys(labels).sort().map((k) => `${k}="${escapeLabel(labels[k])}"`).join(',');
const fmt = (v) => (Number.isFinite(v) ? String(v) : v > 0 ? '+Inf' : v < 0 ? '-Inf' : 'NaN');

export class Metrics {
  constructor() {
    this.items = new Map(); // name -> { type, help, values: Map(key -> value), collect? }
  }

  define(name, type, help, collect) {
    if (!this.items.has(name)) this.items.set(name, { type, help, values: new Map(), collect });
    const item = this.items.get(name);
    return {
      inc: (labels = {}, n = 1) => {
        const k = labelKey(labels);
        item.values.set(k, (item.values.get(k) ?? 0) + n);
      },
      set: (labels, v) => { item.values.set(labelKey(labels ?? {}), v); },
    };
  }

  counter(name, help) { return this.define(name, 'counter', help); }
  gauge(name, help) { return this.define(name, 'gauge', help); }

  /** gauge, значение которого берётся в момент сбора: fn() -> число или [{labels, value}] */
  gaugeFn(name, help, fn) { return this.define(name, 'gauge', help, fn); }

  /** счётчик, который ведёт сам код (растущее число), читается в момент сбора */
  counterFn(name, help, fn) { return this.define(name, 'counter', help, fn); }

  render() {
    const out = [];
    for (const [name, item] of this.items) {
      out.push(`# HELP ${name} ${item.help}`, `# TYPE ${name} ${item.type}`);
      let values = [...item.values].map(([k, v]) => [k, v]);
      if (item.collect) {
        const r = item.collect();
        values = (Array.isArray(r) ? r : [{ labels: {}, value: r }]).map((x) => [labelKey(x.labels ?? {}), x.value]);
      }
      for (const [k, v] of values) out.push(`${name}${k ? `{${k}}` : ''} ${fmt(Number(v))}`);
    }
    return `${out.join('\n')}\n`;
  }
}

/** HTTP-сервер /metrics для внутренней сети (сервисы ingest и scenarios; наружу не публикуется) */
export function serveMetrics(metrics, port, log = console) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/metrics') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(metrics.render());
  });
  server.on('error', (e) => log.error?.(`metrics server: ${e.message}`));
  server.listen(port, '0.0.0.0');
  return server;
}
