CREATE TABLE "test_part_timings" (
	"part_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"packages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_snapshots" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"facts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "work_kind" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "risk_class" text;--> statement-breakpoint
ALTER TABLE "test_part_timings" ADD CONSTRAINT "test_part_timings_part_id_test_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."test_parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_part_timings" ADD CONSTRAINT "test_part_timings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_part_timings" ADD CONSTRAINT "test_part_timings_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_snapshots" ADD CONSTRAINT "turn_snapshots_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_snapshots" ADD CONSTRAINT "turn_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_part_timings_run_id" ON "test_part_timings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "turn_snapshots_company_id" ON "turn_snapshots" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_work_kind" CHECK ("tasks"."work_kind" IS NULL OR "tasks"."work_kind" IN ('bug', 'known_behavior', 'unknown_path', 'legacy_code'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_risk_class" CHECK ("tasks"."risk_class" IS NULL OR "tasks"."risk_class" IN ('money', 'access', 'security', 'data', 'none'));--> statement-breakpoint
UPDATE "tasks" SET
  "work_kind" = CASE lower(trim(substring(split_part("body", E'\n', 1) from '^Вид:\s*([^.]+)')))
    WHEN 'ошибка' THEN 'bug'
    WHEN 'известное поведение' THEN 'known_behavior'
    WHEN 'неизвестный путь' THEN 'unknown_path'
    WHEN 'старый код' THEN 'legacy_code'
  END,
  "risk_class" = CASE lower(trim(substring(split_part("body", E'\n', 1) from 'Класс риска:\s*([^.]+)')))
    WHEN 'деньги' THEN 'money'
    WHEN 'доступ' THEN 'access'
    WHEN 'безопасность' THEN 'security'
    WHEN 'данные' THEN 'data'
    WHEN 'нет' THEN 'none'
  END
WHERE "status" NOT IN ('done', 'cancelled') AND "body" LIKE 'Вид:%';
