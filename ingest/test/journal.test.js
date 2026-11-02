// Журнал ingest: сообщения, подтверждённые брокеру, не теряются при падении до записи в БД.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Journal } from '../src/journal.js';
import { IngestBuffer } from '../src/buffer.js';
import { parseMessage } from '../src/parse.js';

const D = 'd0123456789abcdef';
const ev = (p, v) => parseMessage(`dev/${D}/${p}`, Buffer.from(String(v)));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
const files = (dir) => fs.readdirSync(dir).sort();

test('replay after crash returns everything in order, commit removes it', () => {
  const dir = tmp();
  const j = new Journal(dir, { log: {} });
  assert.deepEqual(j.replay(), []);
  j.append(ev('t', 1), new Date(1000));
  j.append(ev('t', 2), new Date(2000));
  j.append(parseMessage(`dev/${D}/$state`, Buffer.from('ready')), new Date(3000));
  // «падение»: новый экземпляр, файл не закрыт
  const j2 = new Journal(dir, { log: {} });
  const got = j2.replay();
  assert.deepEqual(got.map((x) => [x.ev.kind, x.ev.num ?? x.ev.state, x.time.getTime()]), [['value', 1, 1000], ['value', 2, 2000], ['state', 'ready', 3000]]);
  assert.deepEqual(files(dir), ['pending-1.jsonl']);
  // восстановленное уходит в следующую пачку
  const seq = j2.rotate();
  j2.commit(seq);
  assert.deepEqual(files(dir), []);
});

test('failed flush keeps files; next successful flush commits both', () => {
  const dir = tmp();
  const j = new Journal(dir, { log: {} });
  j.append(ev('t', 1), new Date());
  const s1 = j.rotate();      // пачка 1 забрана… и запись в БД упала — commit не вызываем
  j.append(ev('t', 2), new Date());
  const s2 = j.rotate();      // пачка 2 = возвращённая 1 + новое
  assert.deepEqual(files(dir), ['pending-1.jsonl', 'pending-2.jsonl']);
  assert.ok(s2 > s1);
  // падение между ними — всё будет проиграно
  assert.equal(new Journal(dir, { log: {} }).replay().length, 2);
  j.commit(s2);
  assert.deepEqual(files(dir), []);
});

test('torn last line is skipped, sequence continues after restart', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'pending-7.jsonl'), `${JSON.stringify({ t: 5, ev: ev('t', 5) })}\n`);
  fs.writeFileSync(path.join(dir, 'current.jsonl'), `${JSON.stringify({ t: 6, ev: ev('t', 6) })}\n{"t":7,"ev":{"kind":"va`);
  const j = new Journal(dir, { log: {} });
  assert.deepEqual(j.replay().map((x) => x.ev.num), [5, 6]);
  assert.deepEqual(files(dir), ['pending-7.jsonl', 'pending-8.jsonl']);
});

test('size cap: beyond maxBytes events stay only in memory', () => {
  const dir = tmp();
  const j = new Journal(dir, { log: {}, maxBytes: 200 });
  for (let i = 0; i < 20; i++) j.append(ev('t', i), new Date());
  const size = fs.statSync(path.join(dir, 'current.jsonl')).size;
  assert.ok(size < 400, `журнал ограничен: ${size}`);
  j.commit(j.rotate());
  j.append(ev('t', 1), new Date()); // после записи в БД место снова есть
  assert.ok(fs.existsSync(path.join(dir, 'current.jsonl')));
});

test('real crash: process killed before flush loses nothing', () => {
  const dir = tmp();
  const journalUrl = new URL('../src/journal.js', import.meta.url).href;
  const parseUrl = new URL('../src/parse.js', import.meta.url).href;
  // дочерний процесс принимает 100 сообщений и падает с SIGKILL до сброса пачки
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Journal } from '${journalUrl}';
    import { parseMessage } from '${parseUrl}';
    const j = new Journal(${JSON.stringify(dir)}, { log: {} });
    for (let i = 0; i < 100; i++) j.append(parseMessage('dev/${D}/t', Buffer.from(String(i))), new Date(1000 + i));
    process.kill(process.pid, 'SIGKILL');
  `], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL');
  const buf = new IngestBuffer();
  for (const { ev: e, time } of new Journal(dir, { log: {} }).replay()) buf.add(e, time);
  assert.equal(buf.rows.length, 100);
  assert.deepEqual(buf.rows.slice(0, 3).map((r) => r.num), [0, 1, 2]);
  assert.equal(buf.latest.get(D).t, 99);
});

test('disabled journal is a no-op', () => {
  const j = new Journal(null);
  j.append(ev('t', 1), new Date());
  assert.equal(j.rotate(), 0);
  assert.deepEqual(j.replay(), []);
  j.commit(5);
});
