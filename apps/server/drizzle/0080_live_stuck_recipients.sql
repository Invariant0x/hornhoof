WITH "open_stuck" AS (
  SELECT "r"."id", "a"."id" AS "asker_id", "a"."kind" AS "asker_kind", "a"."company_id",
    "a"."department_id" AS "asker_department_id", "t"."department_id" AS "task_department_id"
  FROM "requests" "r"
  JOIN "agents" "a" ON "a"."id" = "r"."agent_id"
  JOIN "tasks" "t" ON "t"."id" = "r"."task_id"
  WHERE "r"."kind" = 'stuck' AND "r"."status" = 'open' AND "r"."audience" = 'internal' AND "r"."triage_agent_id" IS NULL
), "routed" AS (
  SELECT "open_stuck"."id", COALESCE(
    (SELECT "h"."id" FROM "agents" "h" JOIN "departments" "d" ON "d"."id" = "open_stuck"."asker_department_id"
      WHERE "open_stuck"."asker_kind" <> 'orchestrator' AND "h"."department_id" = COALESCE("d"."parent_id", "d"."id")
        AND "h"."kind" = 'head' AND "h"."removed_at" IS NULL AND "h"."switched_off_at" IS NULL AND "h"."id" <> "open_stuck"."asker_id"
      ORDER BY "h"."created_at" LIMIT 1),
    (SELECT "o"."id" FROM "agents" "o"
      WHERE "open_stuck"."asker_kind" <> 'orchestrator' AND "o"."company_id" = "open_stuck"."company_id"
        AND "o"."kind" = 'orchestrator' AND "o"."removed_at" IS NULL AND "o"."id" <> "open_stuck"."asker_id"
      ORDER BY "o"."created_at" LIMIT 1),
    (SELECT "h"."id" FROM "agents" "h" JOIN "departments" "d" ON "d"."id" = "open_stuck"."task_department_id"
      WHERE "open_stuck"."asker_kind" = 'orchestrator' AND "h"."department_id" = COALESCE("d"."parent_id", "d"."id")
        AND "h"."kind" = 'head' AND "h"."removed_at" IS NULL AND "h"."switched_off_at" IS NULL
      ORDER BY "h"."created_at" LIMIT 1),
    (SELECT "h"."id" FROM "agents" "h"
      WHERE "open_stuck"."asker_kind" = 'orchestrator' AND "h"."company_id" = "open_stuck"."company_id"
        AND "h"."kind" = 'head' AND "h"."removed_at" IS NULL AND "h"."switched_off_at" IS NULL
      ORDER BY "h"."created_at" LIMIT 1)
  ) AS "recipient_id" FROM "open_stuck"
)
UPDATE "requests" "r" SET "triage_agent_id" = "routed"."recipient_id"
FROM "routed" WHERE "r"."id" = "routed"."id" AND "routed"."recipient_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "pending_wakes" "pw" USING "requests" "r"
WHERE "pw"."why" = 'explain' AND "pw"."text" = "r"."id"::text
  AND "r"."kind" = 'stuck' AND "r"."status" = 'open' AND "r"."audience" = 'internal';--> statement-breakpoint
INSERT INTO "pending_wakes" ("company_id", "agent_id", "task_id", "why", "text")
SELECT "company_id", "triage_agent_id", "task_id", 'explain', "id"::text FROM "requests"
WHERE "kind" = 'stuck' AND "status" = 'open' AND "audience" = 'internal' AND "triage_agent_id" IS NOT NULL;--> statement-breakpoint
