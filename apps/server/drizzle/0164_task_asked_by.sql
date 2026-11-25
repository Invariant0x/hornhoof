ALTER TABLE "tasks" ADD COLUMN "asked_by_person_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subtask_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_asked_by_person_id_people_id_fk" FOREIGN KEY ("asked_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_asked_by" ON "tasks" USING btree ("asked_by_person_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_subtask_reason_known" CHECK ("tasks"."subtask_reason" IS NULL OR "tasks"."subtask_reason" IN ('independent_result', 'other_owner', 'parallel_block'));--> statement-breakpoint
UPDATE "tasks" SET "asked_by_person_id" = "created_by_person_id" WHERE "created_by_person_id" IS NOT NULL;--> statement-breakpoint
WITH RECURSIVE "down" ("id", "asker") AS (
	SELECT "id", "asked_by_person_id" FROM "tasks" WHERE "asked_by_person_id" IS NOT NULL
	UNION
	SELECT "t"."id", "d"."asker" FROM "tasks" "t" JOIN "down" "d" ON "t"."parent_id" = "d"."id" WHERE "t"."asked_by_person_id" IS NULL
)
UPDATE "tasks" SET "asked_by_person_id" = "down"."asker" FROM "down" WHERE "tasks"."id" = "down"."id" AND "tasks"."asked_by_person_id" IS NULL;
