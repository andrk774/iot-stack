// Комнаты дома и главный экран пользователя.
import { Router, HttpError, reply, str } from '../http.js';
import { makeAuth, withTx, lockScope, roleSql, accessSql, requireRole, resolveHome } from './common.js';
import { DEVICE_ID_RE, PROP_RE } from '../acl.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ROOMS = 50;
const MAX_ITEMS = 48;

export function roomRoutes({ db, config }) {
  const r = new Router();
  const auth = makeAuth(config, db);

  const ownRoom = async (userId, id) => {
    if (!UUID_RE.test(id)) throw new HttpError(404, 'room_not_found');
    const { rows } = await db.query(
      `SELECT r.id, r.owner_id, r.name, r.sort, ${roleSql('r.owner_id', '$2')} AS my_role FROM rooms r WHERE r.id = $1`, [id, userId]);
    requireRole(rows[0]?.my_role, 'admin', 'room_not_found');
    return rows[0];
  };
  const uniq = (e) => {
    if (e.code === '23505') throw new HttpError(409, 'room_exists');
    throw e;
  };

  r.get('/api/rooms', async ({ req }) => {
    const userId = await auth(req);
    const { rows } = await db.query(
      `SELECT r.id, r.owner_id, r.name, r.sort FROM rooms r WHERE ${accessSql('r.owner_id', '$1')} ORDER BY r.sort, r.name`, [userId]);
    return { rooms: rows };
  });

  r.post('/api/rooms', async ({ req, body }) => {
    const userId = await auth(req);
    const home = await resolveHome(db, userId, body.home, 'admin');
    const name = str(body.name, 'name', { max: 40 });
    const room = await withTx(db, async (tx) => {
      await lockScope(tx, 'rooms', home);
      const { rows: cnt } = await tx.query('SELECT count(*)::int AS n, coalesce(max(sort), -1) + 1 AS next FROM rooms WHERE owner_id = $1', [home]);
      if (cnt[0].n >= MAX_ROOMS) throw new HttpError(409, 'room_limit_reached');
      const { rows } = await tx.query(
        'INSERT INTO rooms (owner_id, name, sort) VALUES ($1, $2, $3) RETURNING id, owner_id, name, sort', [home, name, cnt[0].next]).catch(uniq);
      return rows[0];
    });
    return reply(201, room);
  });

  r.put('/api/rooms/:id', async ({ req, params, body }) => {
    const userId = await auth(req);
    const room = await ownRoom(userId, params.id);
    const name = body.name === undefined ? room.name : str(body.name, 'name', { max: 40 });
    const sort = body.sort === undefined ? room.sort : body.sort;
    if (!Number.isInteger(sort) || sort < 0 || sort > 10000) throw new HttpError(400, 'validation', { field: 'sort', reason: '0..10000' });
    const { rows } = await db.query(
      'UPDATE rooms SET name = $2, sort = $3 WHERE id = $1 RETURNING id, owner_id, name, sort', [room.id, name, sort]).catch(uniq);
    return rows[0];
  });

  r.delete('/api/rooms/:id', async ({ req, params }) => {
    const userId = await auth(req);
    const room = await ownRoom(userId, params.id);
    await db.query('DELETE FROM rooms WHERE id = $1', [room.id]); // устройства останутся «без комнаты»
    return reply(204);
  });

  // ---------- главный экран ----------
  r.get('/api/dashboard', async ({ req }) => {
    const userId = await auth(req);
    // только устройства, к которым доступ есть сейчас (могли убрать из дома)
    const { rows } = await db.query(
      `SELECT i.device_id, i.property FROM dashboard_items i JOIN devices d ON d.id = i.device_id
       WHERE i.user_id = $1 AND ${accessSql('d.owner_id', '$1')} ORDER BY i.sort`, [userId]);
    return { items: rows };
  });

  r.put('/api/dashboard', async ({ req, body }) => {
    const userId = await auth(req);
    const items = body.items;
    if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new HttpError(400, 'validation', { field: 'items', reason: `массив до ${MAX_ITEMS}` });
    const seen = new Set();
    for (const [i, it] of items.entries()) {
      if (!it || !DEVICE_ID_RE.test(it.device_id) || !PROP_RE.test(it.property)) {
        throw new HttpError(400, 'validation', { field: `items[${i}]`, reason: '{device_id, property}' });
      }
      const key = `${it.device_id}/${it.property}`;
      if (seen.has(key)) throw new HttpError(400, 'validation', { field: `items[${i}]`, reason: 'повтор' });
      seen.add(key);
    }
    const ids = [...new Set(items.map((x) => x.device_id))];
    if (ids.length) {
      const { rows } = await db.query(
        `SELECT d.id FROM devices d WHERE d.id = ANY($2::text[]) AND ${accessSql('d.owner_id', '$1')}`, [userId, ids]);
      if (rows.length !== ids.length) throw new HttpError(400, 'device_not_found');
    }
    await withTx(db, async (tx) => {
      await tx.query('DELETE FROM dashboard_items WHERE user_id = $1', [userId]);
      for (const [i, it] of items.entries()) {
        await tx.query('INSERT INTO dashboard_items (user_id, device_id, property, sort) VALUES ($1, $2, $3, $4)',
          [userId, it.device_id, it.property, i]);
      }
    });
    return { items: items.map(({ device_id, property }) => ({ device_id, property })) };
  });

  return r;
}
