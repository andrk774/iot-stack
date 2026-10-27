// Статическая проверка: каждый импортируемый модулем панели символ действительно экспортируется.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/assets');
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
walk(ROOT);

function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) for (const n of m[1].split(',')) names.add(n.trim().split(/\s+as\s+/).pop());
  return names;
}

test('all named imports resolve', () => {
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
      const target = path.resolve(path.dirname(file), m[2]);
      const exp = exportsOf(readFileSync(target, 'utf8'));
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (name) assert.ok(exp.has(name), `${path.relative(ROOT, file)} imports '${name}' from ${m[2]}`);
      }
    }
  }
});
