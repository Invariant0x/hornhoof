-- Each turn belongs to one top-level department, which opens and closes its own turns. A turn takes the top department of
-- its first root task, the first unfinished one for a turn that has not closed; a turn with no such task takes Development,
-- else the company's first department. The work of other departments leaves the open turn and goes on outside turns, and
-- the planned work of other departments moves into a planned turn of its own department. Closed turns keep their history.
ALTER TABLE "turns" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
WITH RECURSIVE "tops"("id", "top") AS (
  SELECT "id", "id" FROM "departments" WHERE "parent_id" IS NULL
  UNION
  SELECT "departments"."id", "tops"."top" FROM "departments" JOIN "tops" ON "departments"."parent_id" = "tops"."id"
), "chosen" AS (
  SELECT DISTINCT ON ("tasks"."turn_id") "tasks"."turn_id", "tops"."top"
  FROM "tasks" JOIN "tops" ON "tops"."id" = "tasks"."department_id" JOIN "turns" ON "turns"."id" = "tasks"."turn_id"
  WHERE "tasks"."parent_id" IS NULL
  ORDER BY "tasks"."turn_id", ("turns"."status" <> 'closed' AND "tasks"."status" NOT IN ('done', 'cancelled')) DESC, "tasks"."number"
)
UPDATE "turns" SET "department_id" = "chosen"."top" FROM "chosen" WHERE "turns"."id" = "chosen"."turn_id";--> statement-breakpoint
UPDATE "turns" SET "department_id" = (
  SELECT "departments"."id" FROM "departments"
  WHERE "departments"."company_id" = "turns"."company_id" AND "departments"."parent_id" IS NULL
  ORDER BY coalesce("departments"."template_key" = 'development', false) DESC, "departments"."position", "departments"."created_at", "departments"."id"
  LIMIT 1
) WHERE "department_id" IS NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "split_from" uuid;--> statement-breakpoint
WITH RECURSIVE "tops"("id", "top") AS (
  SELECT "id", "id" FROM "departments" WHERE "parent_id" IS NULL
  UNION
  SELECT "departments"."id", "tops"."top" FROM "departments" JOIN "tops" ON "departments"."parent_id" = "tops"."id"
), "others" AS (
  SELECT DISTINCT "turns"."id" AS "turn_id", "turns"."company_id", "turns"."number", "tops"."top", "top"."position", "top"."created_at"
  FROM "turns"
  JOIN "tasks" ON "tasks"."turn_id" = "turns"."id" AND "tasks"."parent_id" IS NULL AND "tasks"."status" = 'planned'
  JOIN "tops" ON "tops"."id" = "tasks"."department_id"
  JOIN "departments" "top" ON "top"."id" = "tops"."top"
  WHERE "turns"."status" = 'planned' AND "tops"."top" <> "turns"."department_id"
), "base" AS (
  SELECT "companies"."id" AS "company_id", greatest("companies"."turn_numbers_used", coalesce(max("turns"."number"), 0)) AS "last"
  FROM "companies" LEFT JOIN "turns" ON "turns"."company_id" = "companies"."id"
  GROUP BY "companies"."id"
)
INSERT INTO "turns" ("company_id", "department_id", "number", "title", "goal", "status", "mode", "messages", "started_by", "created_by_agent_id", "created_at", "split_from")
SELECT "others"."company_id", "others"."top",
  "base"."last" + row_number() OVER (PARTITION BY "others"."company_id" ORDER BY "others"."number", "others"."position", "others"."created_at", "others"."top"),
  "source"."title", "source"."goal", 'planned', "source"."mode", "source"."messages", "source"."started_by", "source"."created_by_agent_id", "source"."created_at", "source"."id"
FROM "others" JOIN "turns" "source" ON "source"."id" = "others"."turn_id" JOIN "base" ON "base"."company_id" = "others"."company_id";--> statement-breakpoint
WITH RECURSIVE "tops"("id", "top") AS (
  SELECT "id", "id" FROM "departments" WHERE "parent_id" IS NULL
  UNION
  SELECT "departments"."id", "tops"."top" FROM "departments" JOIN "tops" ON "departments"."parent_id" = "tops"."id"
), "tree"("id", "root") AS (
  SELECT "tasks"."id", "tasks"."id" FROM "tasks" JOIN "turns" ON "turns"."id" = "tasks"."turn_id" WHERE "tasks"."parent_id" IS NULL AND "turns"."status" = 'planned'
  UNION
  SELECT "tasks"."id", "tree"."root" FROM "tasks" JOIN "tree" ON "tasks"."parent_id" = "tree"."id"
)
UPDATE "tasks" SET "turn_id" = "split"."id"
FROM "tree" JOIN "tasks" "root" ON "root"."id" = "tree"."root" JOIN "tops" ON "tops"."id" = "root"."department_id"
  JOIN "turns" "split" ON "split"."split_from" = "root"."turn_id" AND "split"."department_id" = "tops"."top"
WHERE "tasks"."id" = "tree"."id" AND "tasks"."turn_id" = "root"."turn_id";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "split_from";--> statement-breakpoint
WITH RECURSIVE "tops"("id", "top") AS (
  SELECT "id", "id" FROM "departments" WHERE "parent_id" IS NULL
  UNION
  SELECT "departments"."id", "tops"."top" FROM "departments" JOIN "tops" ON "departments"."parent_id" = "tops"."id"
), "tree"("id", "root") AS (
  SELECT "tasks"."id", "tasks"."id" FROM "tasks" JOIN "turns" ON "turns"."id" = "tasks"."turn_id" WHERE "tasks"."parent_id" IS NULL AND "turns"."status" <> 'closed'
  UNION
  SELECT "tasks"."id", "tree"."root" FROM "tasks" JOIN "tree" ON "tasks"."parent_id" = "tree"."id"
)
UPDATE "tasks" SET "turn_id" = NULL
FROM "tree" JOIN "tasks" "root" ON "root"."id" = "tree"."root" JOIN "turns" ON "turns"."id" = "root"."turn_id" LEFT JOIN "tops" ON "tops"."id" = "root"."department_id"
WHERE "tasks"."id" = "tree"."id" AND "tasks"."turn_id" = "turns"."id" AND "tops"."top" IS DISTINCT FROM "turns"."department_id";--> statement-breakpoint
UPDATE "tasks" SET "turn_id" = NULL WHERE "turn_id" IN (SELECT "id" FROM "turns" WHERE "department_id" IS NULL AND "status" <> 'closed');--> statement-breakpoint
UPDATE "turns" SET "status" = 'closed', "opened_at" = coalesce("opened_at", now()), "closed_at" = now() WHERE "department_id" IS NULL AND "status" <> 'closed';--> statement-breakpoint
DROP INDEX "turns_one_open";--> statement-breakpoint
CREATE UNIQUE INDEX "turns_one_open" ON "turns" USING btree ("company_id","department_id") WHERE status = 'open';--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_department" CHECK ("turns"."status" = 'closed' OR "turns"."department_id" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "tasks_after" ON "tasks" USING gin ("after");
