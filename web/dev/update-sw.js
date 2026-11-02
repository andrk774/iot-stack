// Обновить список файлов панели в public/sw.js (SHELL) и версию кеша. Запуск: node web/dev/update-sw.js
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const files = [];
const walk = (d) => { for (const f of readdirSync(d).sort()) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(path.join(PUB, 'assets'));
const urls = files.map((p) => `/${path.relative(PUB, p).split(path.sep).join('/')}`).sort();
// версия кеша — хэш содержимого: новая версия панели вытесняет старый кеш
const hash = crypto.createHash('sha256');
for (const p of files) hash.update(readFileSync(p));
const ver = hash.digest('hex').slice(0, 10);
const swPath = path.join(PUB, 'sw.js');
let sw = readFileSync(swPath, 'utf8');
sw = sw.replace(/const SHELL = \[[\s\S]*?\];/, `const SHELL = [\n  '/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png',\n${urls.map((u) => `  '${u}',`).join('\n')}\n];`);
sw = sw.replace(/const CACHE = '[^']*';/, `const CACHE = 'iot-panel-${ver}';`);
writeFileSync(swPath, sw);
console.log(`sw.js: ${urls.length} файлов, кеш iot-panel-${ver}`);
