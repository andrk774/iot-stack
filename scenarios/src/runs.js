// Журнал запусков сценария: запись и обрезка до последних keep на сценарий.
export const RUNS_KEEP = 200;

export async function saveScenarioRun(db, scenarioId, run, keep = RUNS_KEEP) {
  await db.query(
    `INSERT INTO scenario_runs (scenario_id, started_at, finished_at, status, cause, steps, error)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [scenarioId, run.started_at, run.finished_at, run.status, JSON.stringify(run.cause), JSON.stringify(run.steps), run.error],
  );
  await db.query(
    `DELETE FROM scenario_runs WHERE scenario_id = $1 AND id <= (
       SELECT id FROM scenario_runs WHERE scenario_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)`, [scenarioId, keep],
  );
}
