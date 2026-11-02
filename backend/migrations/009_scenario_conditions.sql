-- Сценарии: режим условий (все / любое). Новые виды условий и запусков живут в jsonb trigger/conditions.
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS condition_mode text NOT NULL DEFAULT 'all'
  CHECK (condition_mode IN ('all', 'any'));

DROP TRIGGER IF EXISTS scenarios_changed ON scenarios;
CREATE TRIGGER scenarios_changed
  AFTER INSERT OR DELETE OR UPDATE OF name, enabled, trigger, conditions, condition_mode, actions, cooldown_sec
  ON scenarios FOR EACH STATEMENT EXECUTE FUNCTION notify_scenarios_changed();
