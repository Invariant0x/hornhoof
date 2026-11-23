-- A part Hornhoof refused before it started was kept as a failed check: the node's command guard sent "failed" with no exit
-- code and its refusal in the log, and a product with no test environment failed its description. Both are hints, no results.
UPDATE "test_parts" SET "status" = 'refused', "error" = 'refused' WHERE "status" = 'failed' AND "error" = 'failed' AND "exit_code" IS NULL AND "started_at" IS NULL AND position('Hornhoof stopped this command before it started.' in "tail") > 0;--> statement-breakpoint
UPDATE "test_parts" SET "status" = 'refused' WHERE "status" = 'failed' AND "error" = 'environment_missing';--> statement-breakpoint
-- A run none of whose parts started and failed is refused with them, so no wait or screen counts it as a failure.
UPDATE "test_runs" SET "status" = 'refused' WHERE "status" = 'failed'
  AND EXISTS (SELECT 1 FROM "test_parts" p WHERE p."run_id" = "test_runs"."id" AND p."status" = 'refused')
  AND NOT EXISTS (SELECT 1 FROM "test_parts" p WHERE p."run_id" = "test_runs"."id" AND p."status" = 'failed');
