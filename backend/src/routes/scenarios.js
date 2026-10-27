import { Router, HttpError, reply } from '../http.js';
import { makeAuth, assertOwnDevices, withTx, lockScope } from './common.js';
import { validateScenario, referencedDevices, ScenarioError, isSettable } from '../../../shared/scenario.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLUMNS = 'id, name, enabled, trigger, conditions, actions, cooldown_sec, last_run_at, last_error, created_at, updated_at';
const MAX_SCENARIOS = 200;

export function scenarioRoutes({ db, config }) {
  const r = new Router();
  const auth = makeAuth(config);

  const parse = async (userId, body) => {
    let s;
    try {
      s = validateScenario(body);
    } catch (e) {
      if (e instanceof ScenarioError) throw new HttpError(400, 'validation', { field: e.field, reason: e.reason });
      throw e;
    }
    const devices = await assertOwnDevices(db, userId, referencedDevices(s));
    // то же правило, что у POST /api/devices/:id/commands
    s.actions.forEach((a, i) => {
      if (a.type === 'set' && !isSettable(devices.get(a.device_id)?.meta, a.property)) {
        throw new HttpError(400, 'validation', { field: `actions[${i}].property`, reason: 'свойство не управляемое (нет settable в $meta)' });
      }
    });
    return s;
  };

  const own = async (userId, id) => {
    if (!UUID_RE.test(id)) throw new HttpError(404, 'scenario_not_found');
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM scenarios WHERE id = $1 AND owner_id = $2`, [id, userId]);
    if (!rows[0]) throw new HttpError(404, 'scenario_not_found');
    return rows[0];
  };

  const params = (s) => [s.name, s.enabled, JSON.stringify(s.trigger), JSON.stringify(s.conditions),
    JSON.stringify(s.actions), s.cooldown_sec];

  r.get('/api/scenarios', async ({ req }) => {
    const userId = auth(req);
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM scenarios WHERE owner_id = $1 ORDER BY name`, [userId]);
    return { scenarios: rows };
  });

  r.post('/api/scenarios', async ({ req, body }) => {
    const userId = auth(req);
    const s = await parse(userId, body);
    const created = await withTx(db, async (tx) => {
      await lockScope(tx, 'scenarios', userId);
      const { rows: cnt } = await tx.query('SELECT count(*)::int AS n FROM scenarios WHERE owner_id = $1', [userId]);
      if (cnt[0].n >= MAX_SCENARIOS) throw new HttpError(409, 'scenario_limit_reached');
      const { rows } = await tx.query(
        `INSERT INTO scenarios (owner_id, name, enabled, trigger, conditions, actions, cooldown_sec)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7) RETURNING ${COLUMNS}`,
        [userId, ...params(s)],
      );
      return rows[0];
    });
    return reply(201, created);
  });

  r.get('/api/scenarios/:id', async ({ req, params: p }) => own(auth(req), p.id));

  r.put('/api/scenarios/:id', async ({ req, params: p, body }) => {
    const userId = auth(req);
    await own(userId, p.id);
    const s = await parse(userId, body);
    const { rows } = await db.query(
      `UPDATE scenarios SET name = $2, enabled = $3, trigger = $4::jsonb, conditions = $5::jsonb, actions = $6::jsonb,
              cooldown_sec = $7, last_error = NULL, updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [p.id, ...params(s)],
    );
    return rows[0];
  });

  r.delete('/api/scenarios/:id', async ({ req, params: p }) => {
    const userId = auth(req);
    await own(userId, p.id);
    await db.query('DELETE FROM scenarios WHERE id = $1', [p.id]);
    return reply(204);
  });

  // Ручной запуск: scenario-runner слушает канал scenario_run
  r.post('/api/scenarios/:id/run', async ({ req, params: p }) => {
    const userId = auth(req);
    const s = await own(userId, p.id);
    if (!s.enabled) throw new HttpError(409, 'scenario_disabled');
    await db.query("SELECT pg_notify('scenario_run', $1)", [s.id]);
    return reply(202, { queued: true });
  });

  // ---------- уведомления ----------
  r.get('/api/notifications', async ({ req, query }) => {
    const userId = auth(req);
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const unreadOnly = query.unread === 'true';
    const { rows } = await db.query(
      `SELECT n.id, n.level, n.message, n.created_at, n.read_at, n.scenario_id, s.name AS scenario_name
       FROM notifications n LEFT JOIN scenarios s ON s.id = n.scenario_id
       WHERE n.owner_id = $1 ${unreadOnly ? 'AND n.read_at IS NULL' : ''}
       ORDER BY n.created_at DESC LIMIT $2`,
      [userId, limit],
    );
    const { rows: cnt } = await db.query(
      'SELECT count(*)::int AS n FROM notifications WHERE owner_id = $1 AND read_at IS NULL', [userId],
    );
    return { notifications: rows, unread: cnt[0].n };
  });

  r.post('/api/notifications/read', async ({ req, body }) => {
    const userId = auth(req);
    const ids = body.ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 || !ids.every((x) => Number.isInteger(x)))) {
      throw new HttpError(400, 'validation', { field: 'ids', reason: 'массив id' });
    }
    const { rowCount } = ids
      ? await db.query('UPDATE notifications SET read_at = now() WHERE owner_id = $1 AND read_at IS NULL AND id = ANY($2::bigint[])', [userId, ids])
      : await db.query('UPDATE notifications SET read_at = now() WHERE owner_id = $1 AND read_at IS NULL', [userId]);
    return { updated: rowCount };
  });

  return r;
}
