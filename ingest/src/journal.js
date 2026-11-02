// Журнал на диске между приёмом сообщения и записью в БД.
//
// MQTT-клиент подтверждает (PUBACK) сообщение сразу после обработчика — до того, как пачка попадёт в БД.
// Чтобы падение процесса или перезапуск контейнера не теряли последнюю секунду данных, каждое принятое
// событие сначала дописывается в файл current.jsonl (синхронно, до подтверждения брокеру).
// При сбросе пачки текущий файл переименовывается в pending-<n>.jsonl — его содержимое ровно совпадает
// с забранной пачкой. После успешной записи в БД pending-файлы удаляются; при ошибке пачка возвращается
// в буфер, а файлы остаются. При запуске всё найденное проигрывается в буфер заново.
//
// Если процесс упадёт после COMMIT, но до удаления файла, пачка запишется повторно (at-least-once):
// в телеметрии появятся дубли с тем же временем. Это редкий случай и безопаснее потери.
import fs from 'node:fs';
import path from 'node:path';

const PENDING_RE = /^pending-(\d+)\.jsonl$/;

export class Journal {
  /** dir — каталог на томе; null — журнал выключен */
  constructor(dir, { log = console, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.dir = dir;
    this.log = log;
    this.maxBytes = maxBytes;
    this.fd = null;
    this.bytes = 0;
    this.seq = 0;
    this.enabled = Boolean(dir);
    if (!this.enabled) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const m = PENDING_RE.exec(f);
      if (m) this.seq = Math.max(this.seq, Number(m[1]));
    }
  }

  get current() { return path.join(this.dir, 'current.jsonl'); }

  /** Прочитать всё, что осталось с прошлого запуска: [{ ev, time }] в порядке записи */
  replay() {
    if (!this.enabled) return [];
    const files = fs.readdirSync(this.dir)
      .map((f) => [f, PENDING_RE.exec(f)])
      .filter(([, m]) => m)
      .sort(([, a], [, b]) => Number(a[1]) - Number(b[1]))
      .map(([f]) => f);
    if (fs.existsSync(this.current)) files.push('current.jsonl');
    const out = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(this.dir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const { t, ev } = JSON.parse(line);
          out.push({ ev, time: new Date(t) });
        } catch {
          // оборванная последняя строка (питание пропало посреди записи) — пропускаем
        }
      }
    }
    // всё прочитанное станет частью следующей пачки: оформим его как pending
    if (fs.existsSync(this.current)) this.rotate();
    return out;
  }

  /** Дописать событие до подтверждения брокеру */
  append(ev, time) {
    if (!this.enabled) return;
    if (this.bytes > this.maxBytes) return; // БД долго недоступна: дальше копим только в памяти
    if (this.fd === null) this.fd = fs.openSync(this.current, 'a');
    const line = `${JSON.stringify({ t: time.getTime(), ev })}\n`;
    fs.writeSync(this.fd, line);
    this.bytes += Buffer.byteLength(line);
  }

  /** Пачка забрана из буфера: текущий файл -> pending-<n>. Возвращает номер (для commit) */
  rotate() {
    if (!this.enabled) return 0;
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    if (fs.existsSync(this.current)) {
      this.seq += 1;
      fs.renameSync(this.current, path.join(this.dir, `pending-${this.seq}.jsonl`));
    }
    return this.seq;
  }

  /** Всё до номера upto включительно записано в БД */
  commit(upto) {
    if (!this.enabled) return;
    for (const f of fs.readdirSync(this.dir)) {
      const m = PENDING_RE.exec(f);
      if (m && Number(m[1]) <= upto) fs.rmSync(path.join(this.dir, f), { force: true });
    }
    // размер считаем по тому, что ещё не подтверждено БД
    this.bytes = fs.readdirSync(this.dir).reduce((s, f) => s + fs.statSync(path.join(this.dir, f)).size, 0);
  }
}
