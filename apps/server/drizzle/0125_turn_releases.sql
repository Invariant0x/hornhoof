-- Turns become releases. A department always has one open turn, the release it gets ready; a task joins it only as its
-- result is accepted into the turn branch, and the tag of a recorded release closes it. Planned turns go: their work goes
-- to the head of its department now, with what its turn was for kept in its log. Of the open turns only what was accepted
-- into their branch, or done turnkey, stays in them; the rest goes on as it was, outside every turn until it is accepted.
-- A release is approved by a person or, with autonomous release on and every commit of it checked, by an entry of the
-- autonomous release log: one of the two.
CREATE TABLE "turn_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"commit" text NOT NULL,
	"base_commit_sha" text NOT NULL,
	"run_id" uuid,
	"tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"task_id" uuid,
	"approval_request_id" uuid,
	"autonomous_release_id" uuid,
	"requested_by_agent_id" uuid,
	"covered" boolean NOT NULL,
	"uncovered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turn_releases_commit" CHECK ("turn_releases"."commit" ~ '^[0-9a-f]{40}$' AND "turn_releases"."base_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "turn_releases_approved_once" CHECK (("turn_releases"."approval_request_id" IS NULL) <> ("turn_releases"."autonomous_release_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "turn_releases" ADD CONSTRAINT "turn_releases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_releases" ADD CONSTRAINT "turn_releases_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_releases" ADD CONSTRAINT "turn_releases_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_releases" ADD CONSTRAINT "turn_releases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_releases" ADD CONSTRAINT "turn_releases_approval_request_id_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_releases" ADD CONSTRAINT "turn_releases_autonomous_release_id_autonomous_releases_id_fk" FOREIGN KEY ("autonomous_release_id") REFERENCES "public"."autonomous_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_releases" ADD CONSTRAINT "turn_releases_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_releases_turn_id" ON "turn_releases" USING btree ("turn_id");--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "version" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "commit" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "base_version" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "base_commit" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "start_commit" text;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_department_version" ON "turns" USING btree ("company_id","department_id","version") WHERE version IS NOT NULL;--> statement-breakpoint
-- What a planned turn was for stays in the log of each of its tasks.
INSERT INTO "task_events" ("company_id", "task_id", "kind", "text", "data")
SELECT "tasks"."company_id", "tasks"."id", 'updated',
  'It was planned in Turn ' || "turns"."number" || ' "' || coalesce(nullif("turns"."title", ''), "turns"."goal") || '": ' || "turns"."goal"
    || ' Turns are releases now, so it goes on outside every turn until its result is accepted into the open one.',
  jsonb_build_object('fields', jsonb_build_array('turn'), 'plannedTurn', "turns"."number", 'title', "turns"."title", 'goal', "turns"."goal")
FROM "tasks" JOIN "turns" ON "turns"."id" = "tasks"."turn_id"
WHERE "turns"."status" = 'planned';--> statement-breakpoint
-- Planned work goes to the head of the top-level department it is for, as a planned turn starting would have given it.
WITH RECURSIVE "tops"("id", "top") AS (
  SELECT "id", "id" FROM "departments" WHERE "parent_id" IS NULL
  UNION
  SELECT "departments"."id", "tops"."top" FROM "departments" JOIN "tops" ON "departments"."parent_id" = "tops"."id"
), "heads" AS (
  SELECT DISTINCT ON ("agents"."department_id") "agents"."department_id", "agents"."id"
  FROM "agents" WHERE "agents"."kind" = 'head' AND "agents"."removed_at" IS NULL
  ORDER BY "agents"."department_id", "agents"."created_at", "agents"."id"
)
UPDATE "tasks" SET "status" = CASE WHEN "heads"."id" IS NULL THEN 'blocked' ELSE 'open' END, "assignee_agent_id" = "heads"."id", "version" = "tasks"."version" + 1, "updated_at" = now()
FROM "tasks" "planned" LEFT JOIN "tops" ON "tops"."id" = "planned"."department_id" LEFT JOIN "heads" ON "heads"."department_id" = "tops"."top"
WHERE "tasks"."id" = "planned"."id" AND "tasks"."status" = 'planned';--> statement-breakpoint
-- Of a turn that has not closed only what was accepted into its branch, or done turnkey, stays in it.
UPDATE "tasks" SET "turn_id" = NULL
FROM "turns"
WHERE "turns"."id" = "tasks"."turn_id" AND "turns"."status" <> 'closed' AND NOT (
  "turns"."status" = 'open' AND "tasks"."status" = 'done' AND (
    EXISTS (SELECT 1 FROM "task_routes" WHERE "task_routes"."task_id" = "tasks"."id" AND "task_routes"."state"->>'resultKind' = 'turnkey')
    OR EXISTS (SELECT 1 FROM "task_events" WHERE "task_events"."task_id" = "tasks"."id" AND "task_events"."kind" = 'report'
      AND "task_events"."data"->'acceptedCandidate'->'integration'->>'branch' = 'turn-' || "turns"."number")
  )
);--> statement-breakpoint
-- The numbers of planned turns stay given, so no later turn takes one of them.
UPDATE "companies" SET "turn_numbers_used" = greatest("companies"."turn_numbers_used", "used"."last")
FROM (SELECT "company_id", max("number") AS "last" FROM "turns" GROUP BY "company_id") "used"
WHERE "used"."company_id" = "companies"."id";--> statement-breakpoint
DELETE FROM "turns" WHERE "status" = 'planned';--> statement-breakpoint
-- Every top-level department runs one open turn, numbered after every turn its company gave.
WITH "missing" AS (
  SELECT "departments"."company_id", "departments"."id",
    row_number() OVER (PARTITION BY "departments"."company_id" ORDER BY "departments"."position", "departments"."created_at", "departments"."id") AS "n"
  FROM "departments"
  WHERE "departments"."parent_id" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "turns" WHERE "turns"."department_id" = "departments"."id" AND "turns"."status" = 'open')
)
INSERT INTO "turns" ("company_id", "department_id", "number", "goal", "status", "opened_at")
SELECT "missing"."company_id", "missing"."id", "companies"."turn_numbers_used" + "missing"."n", 'The next release.', 'open', now()
FROM "missing" JOIN "companies" ON "companies"."id" = "missing"."company_id";--> statement-breakpoint
UPDATE "companies" SET "turn_numbers_used" = greatest("companies"."turn_numbers_used", "used"."last")
FROM (SELECT "company_id", max("number") AS "last" FROM "turns" GROUP BY "company_id") "used"
WHERE "used"."company_id" = "companies"."id";--> statement-breakpoint
ALTER TABLE "departments" DROP CONSTRAINT "departments_work_mode";--> statement-breakpoint
ALTER TABLE "departments" DROP COLUMN "work_mode";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "mode";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status" CHECK ("tasks"."status" IN ('open', 'working', 'review', 'waiting', 'blocked', 'done', 'cancelled'));--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_status" CHECK ("turns"."status" IN ('open', 'closed'));
