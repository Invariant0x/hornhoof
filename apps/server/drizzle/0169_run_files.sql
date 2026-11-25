-- A run's logs and the files its parts made name their run (#2036): the files of runs that ended 30 days ago go by that,
-- and a file an agent or a person named like one is no run's and stays. The files runs made before are found once, here,
-- as they were found until now, by their task and name, and also by the turn that started the run and their time.
ALTER TABLE "attachments" ADD COLUMN "test_run_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_test_run_id" ON "attachments" USING btree ("test_run_id");--> statement-breakpoint
UPDATE "attachments" a SET "test_run_id" = r."id" FROM "test_runs" r
  WHERE a."task_id" = r."task_id" AND a."job_id" = r."job_id" AND a."created_at" >= r."created_at"
    AND (a."name" LIKE r."kind" || '-' || r."number" || '-%' OR a."name" LIKE (CASE WHEN r."kind" = 'work' THEN 'work' ELSE 'test' END) || '-' || r."number" || '-%');
