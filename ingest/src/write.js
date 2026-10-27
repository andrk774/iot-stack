// Запись пачки в БД так, чтобы одно «плохое» сообщение не останавливало запись для всех.
//
// Каждый запрос выполняется под SAVEPOINT. Если PostgreSQL отклонил данные (SQLSTATE класса 22/23 —
// неверное значение, нарушение ограничения), запрос откатывается до savepoint, а вставка телеметрии
// делится пополам до тех пор, пока не останется одна виновная строка — её и выбрасываем.
// Ошибки связи и прочие пробрасываются наружу: тогда пачка целиком возвращается в буфер.
import { batchToQueries } from './buffer.js';

export const isDataError = (e) => typeof e?.code === 'string' && (e.code.startsWith('22') || e.code.startsWith('23'));

const telemetryQuery = (rows) => batchToQueries({
  rows, latest: new Map(), states: new Map(), metas: new Map(), bridges: new Map(),
})[0];

/**
 * @returns {Promise<{ written: number, dropped: Array<{ what: string, error: string }> }>}
 */
export async function writeBatch(client, batch, log = console) {
  const dropped = [];
  let sp = 0;

  // выполнить запрос под savepoint; false — данные отклонены (и откачены)
  const attempt = async (text, values) => {
    const name = `sp${++sp}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      await client.query(text, values);
      await client.query(`RELEASE SAVEPOINT ${name}`);
      return null;
    } catch (e) {
      if (!isDataError(e)) throw e;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return e;
    }
  };

  const insertRows = async (rows) => {
    if (rows.length === 0) return 0;
    const [text, values] = telemetryQuery(rows);
    const err = await attempt(text, values);
    if (!err) return rows.length;
    if (rows.length === 1) {
      const r = rows[0];
      dropped.push({ what: `telemetry ${r.deviceId}/${r.property}`, error: `${err.code} ${err.message}` });
      return 0;
    }
    const mid = rows.length >> 1;
    return (await insertRows(rows.slice(0, mid))) + (await insertRows(rows.slice(mid)));
  };

  await client.query('BEGIN');
  try {
    const written = await insertRows(batch.rows);
    // остальное — по одному запросу на устройство/мост
    const rest = batchToQueries({ ...batch, rows: [] });
    for (const [text, values] of rest) {
      const err = await attempt(text, values);
      if (err) dropped.push({ what: `${text.split(' ').slice(0, 4).join(' ')} ${values[0]}`, error: `${err.code} ${err.message}` });
    }
    await client.query('COMMIT');
    for (const d of dropped) log.warn?.(`ingest: dropped ${d.what}: ${d.error}`);
    return { written, dropped };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
