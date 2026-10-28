// PWA: service worker заранее кеширует все файлы панели, манифест корректен.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

test('service worker precaches every panel file', () => {
  const sw = readFileSync(path.join(PUB, 'sw.js'), 'utf8');
  const list = [...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(`/${path.relative(PUB, p).split(path.sep).join('/')}`); } };
  walk(path.join(PUB, 'assets'));
  for (const f of files) assert.ok(list.includes(f), `${f} нет в SHELL (sw.js)`);
  for (const f of list) if (f !== '/') assert.ok(existsSync(path.join(PUB, f)), `${f} в SHELL, но файла нет`);
});

test('manifest icons exist', () => {
  const m = JSON.parse(readFileSync(path.join(PUB, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(existsSync(path.join(PUB, i.src)), i.src);
  assert.ok(m.icons.some((i) => i.sizes === '512x512') && m.icons.some((i) => i.sizes === '192x192'));
});
