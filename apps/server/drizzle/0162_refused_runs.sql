-- A part Hornhoof refused before it started was kept as a failed check: the node's command guard sent "failed" with no exit
-- code and its refusal in the log, and a product with no test environment failed its description. Both are hints, no results.
-- The part holds the time the node took it, so its start time says nothing: the tail must be the guard's refusal and
-- nothing else, from its first character, as the server reads a node's end of a part (oldRefusal in runs.ts): a command
-- never writes the first line of a log.
UPDATE "test_parts" SET "status" = 'refused', "error" = 'refused' WHERE "status" = 'failed' AND "error" = 'failed' AND "exit_code" IS NULL
  AND ((starts_with(rtrim("tail", E' \t\n\r'), 'Hornhoof stopped this command before it started.') AND position(E'\n' in rtrim("tail", E' \t\n\r')) = 0)
    OR (starts_with(rtrim("tail", E' \t\n\r'), 'запусти через run_tests' || E'\n' || 'Hornhoof stopped this command before it started.')
      AND array_length(string_to_array(rtrim("tail", E' \t\n\r'), E'\n'), 1) = 2));--> statement-breakpoint
UPDATE "test_parts" SET "status" = 'refused' WHERE "status" = 'failed' AND "error" = 'environment_missing';--> statement-breakpoint
-- A run none of whose parts started and failed is refused with them, so no wait or screen counts it as a failure.
UPDATE "test_runs" SET "status" = 'refused' WHERE "status" = 'failed'
  AND EXISTS (SELECT 1 FROM "test_parts" p WHERE p."run_id" = "test_runs"."id" AND p."status" = 'refused')
  AND NOT EXISTS (SELECT 1 FROM "test_parts" p WHERE p."run_id" = "test_runs"."id" AND p."status" = 'failed');
