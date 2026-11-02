import { Router, HttpError, reply } from '../http.js';
import { makeAuth, assertOwnDevices, withTx, lockScope, roleSql, accessSql, requireRole, resolveHome } from './common.js';
import { validateScenario, referencedDevices, ScenarioError, isSettable } from '../../../shared/scenario.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLUMNS = 'id, owner_id, name, enabled, trigger, conditions, actions, cooldown_sec, last_run_at, last_error, created_at, updated_at';
const MAX_SCENARIOS = 200;

export function scenarioRoutes({ db, config }) {
  const r = new Router();
  const auth = makeAuth(config, db);

  /** home — дом сценария: устройства в нём должны принадлежать этому же дому */
  const parse = async (home, body) => {
    let s;
    try {
      s = validateScenario(body);
    } catch (e) {
      if (e instanceof ScenarioError) throw new HttpError(400, 'validation', { field: e.field, reason: e.reason });
      throw e;
    }
    const devices = await assertOwnDevices(db, home, referencedDevices(s));
    // то же правило, что у POST /api/devices/:id/commands
    s.actions.forEach((a, i) => {
      if (a.type === 'set' && !isSettable(devices.get(a.device_id)?.meta, a.property)) {
        throw new HttpError(400, 'validation', { field: `actions[${i}].property`, reason: 'свойство не управляемое (нет settable в $meta)' });
      }
    });
    return s;
  };

  const own = async (userId, id, min) => {
    if (!UUID_RE.test(id)) throw new HttpError(404, 'scenario_not_found');
    const { rows } = await db.query(
      `SELECT ${COLUMNS}, ${roleSql('s.owner_id', '$2')} AS my_role FROM scenarios s WHERE s.id = $1`, [id, userId]);
    requireRole(rows[0]?.my_role, min, 'scenario_not_found');
    return rows[0];
  };

  const params = (s) => [s.name, s.enabled, JSON.stringify(s.trigger), JSON.stringify(s.conditions),
    JSON.stringify(s.actions), s.cooldown_sec];

  r.get('/api/scenarios', async ({ req }) => {
    const userId = await auth(req);
    const { rows } = await db.query(
      `SELECT ${COLUMNS}, ${roleSql('s.owner_id', '$1')} AS my_role FROM scenarios s
       WHERE ${accessSql('s.owner_id', '$1')} ORDER BY name`, [userId]);
    return { scenarios: rows };
  });

  r.post('/api/scenarios', async ({ req, body }) => {
    const userId = await auth(req);
    const home = await resolveHome(db, userId, body.home, 'admin');
    const s = await parse(home, body);
    const created = await withTx(db, async (tx) => {
      await lockScope(tx, 'scenarios', home);
      const { rows: cnt } = await tx.query('SELECT count(*)::int AS n FROM scenarios WHERE owner_id = $1', [home]);
      if (cnt[0].n >= MAX_SCENARIOS) throw new HttpError(409, 'scenario_limit_reached');
      const { rows } = await tx.query(
        `INSERT INTO scenarios (owner_id, name, enabled, trigger, conditions, actions, cooldown_sec)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7) RETURNING ${COLUMNS}`,
        [home, ...params(s)],
      );
      return { ...rows[0], my_role: home === userId ? 'owner' : 'admin' };
    });
    return reply(201, created);
  });

  r.get('/api/scenarios/:id', async ({ req, params: p }) => own(await auth(req), p.id, 'view'));

  r.put('/api/scenarios/:id', async ({ req, params: p, body }) => {
    const userId = await auth(req);
    const cur = await own(userId, p.id, 'admin');
    const s = await parse(cur.owner_id, body);
    const { rows } = await db.query(
      `UPDATE scenarios SET name = $2, enabled = $3, trigger = $4::jsonb, conditions = $5::jsonb, actions = $6::jsonb,
              cooldown_sec = $7, last_error = NULL, updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [p.id, ...params(s)],
    );
    return { ...rows[0], my_role: cur.my_role };
  });

  r.delete('/api/scenarios/:id', async ({ req, params: p }) => {
    const userId = await auth(req);
    await own(userId, p.id, 'admin');
    await db.query('DELETE FROM scenarios WHERE id = $1', [p.id]);
    return reply(204);
  });

  // Ручной запуск: scenario-runner слушает канал scenario_run
  r.post('/api/scenarios/:id/run', async ({ req, params: p }) => {
    const userId = await auth(req);
    const s = await own(userId, p.id, 'control');
    if (!s.enabled) throw new HttpError(409, 'scenario_disabled');
    await db.query("SELECT pg_notify('scenario_run', $1)", [s.id]);
    return reply(202, { queued: true });
  });

  // ---------- уведомления ----------
  r.get('/api/notifications', async ({ req, query }) => {
    const userId = await auth(req);
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const unreadOnly = query.unread === 'true';
    const { rows } = await db.query(
      `SELECT n.id, n.owner_id, n.level, n.message, n.created_at, n.read_at, n.scenario_id, s.name AS scenario_name
       FROM notifications n LEFT JOIN scenarios s ON s.id = n.scenario_id
       WHERE ${accessSql('n.owner_id', '$1')} ${unreadOnly ? 'AND n.read_at IS NULL' : ''}
       ORDER BY n.created_at DESC LIMIT $2`,
      [userId, limit],
    );
    const { rows: cnt } = await db.query(
      `SELECT count(*)::int AS n FROM notifications n WHERE ${accessSql('n.owner_id', '$1')} AND read_at IS NULL`, [userId],
    );
    return { notifications: rows, unread: cnt[0].n };
  });

  r.post('/api/notifications/read', async ({ req, body }) => {
    const userId = await auth(req);
    const ids = body.ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 || !ids.every((x) => Number.isInteger(x)))) {
      throw new HttpError(400, 'validation', { field: 'ids', reason: 'массив id' });
    }
    const { rowCount } = ids
      ? await db.query(`UPDATE notifications n SET read_at = now() WHERE ${accessSql('n.owner_id', '$1')} AND read_at IS NULL AND id = ANY($2::bigint[])`, [userId, ids])
      : await db.query(`UPDATE notifications n SET read_at = now() WHERE ${accessSql('n.owner_id', '$1')} AND read_at IS NULL`, [userId]);
    return { updated: rowCount };
  });

  return r;
}
