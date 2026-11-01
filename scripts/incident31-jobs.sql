-- Read-only incident metadata for the target agent. No prompts or tool tokens.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';
WITH bounds AS (
  SELECT '7f038470-9455-432f-a113-0d7f72bd87cd'::uuid AS agent_id,
         '2026-11-01T00:17:00Z'::timestamptz AS lo,
         '2026-11-01T00:30:03Z'::timestamptz AS hi
), predecessor AS (
  SELECT j.id FROM public.jobs j CROSS JOIN bounds b
  WHERE j.agent_id = b.agent_id AND j.kind = 'conversation'
    AND j.finished_at < b.lo
    AND (j.status = 'done' OR (j.status = 'failed'
         AND j.error IN ('timeout', 'cancelled') AND j.session_id IS NOT NULL))
  ORDER BY j.finished_at DESC LIMIT 1
), rows AS (
  SELECT j.id, j.kind, j.status, j.error, j.subscription_id, j.session_id,
         j.instructions_hash, j.created_by, j.task_id,
         j.created_at, j.started_at, j.finished_at,
         char_length(j.prompt) AS prompt_characters,
         md5(j.prompt) AS prompt_md5,
         (j.prompt = '') AS empty_start,
         (j.prompt LIKE 'Earlier in this conversation, in another session you cannot see:%') AS recovery_prefix,
         (j.id IN (SELECT id FROM predecessor)) AS predecessor_before_window
  FROM public.jobs j CROSS JOIN bounds b
  WHERE j.agent_id = b.agent_id
    AND (j.created_at BETWEEN b.lo AND b.hi
      OR j.started_at BETWEEN b.lo AND b.hi
      OR j.finished_at BETWEEN b.lo AND b.hi
      OR j.id IN (SELECT id FROM predecessor))
  ORDER BY j.created_at, j.id
)
SELECT coalesce(json_agg(row_to_json(rows)), '[]'::json) AS jobs_metadata FROM rows;
ROLLBACK;
