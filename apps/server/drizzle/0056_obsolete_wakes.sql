UPDATE "jobs" SET "status" = 'obsolete' WHERE "status" = 'failed' AND "error" = 'stale' AND "started_at" IS NULL AND "node_id" IS NULL;
