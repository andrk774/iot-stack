// Применяет backend/migrations/*.sql по порядку, один раз каждую.
// 001 — это db/init/01-schema.sql (выполняется при создании тома PostgreSQL).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const LOCK_ID = 727_001; // pg_advisory_lock: одна реплика мигрирует, остальные ждут

export async function listMigrations(dir = DIR) {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  return files.map((f) => ({ version: f.slice(0, 3), file: path.join(dir, f), name: f }));
}

export async function migrate(pool, { dir = DIR, log = console } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));

    for (const m of await listMigrations(dir)) {
      if (done.has(m.version)) continue;
      const sql = await readFile(m.file, 'utf8');
      log.log?.(`migration ${m.name}: applying`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.name} failed: ${e.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}
