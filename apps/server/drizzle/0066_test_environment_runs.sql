ALTER TABLE "test_parts" ADD COLUMN "environment_selection" jsonb;--> statement-breakpoint
ALTER TABLE "test_parts" ADD COLUMN "environment_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "environment_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "environment_hash" text;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "environment_request" jsonb;--> statement-breakpoint
CREATE INDEX "test_runs_environment_request" ON "test_runs" USING btree (("environment_request"->>'requestId')) WHERE "test_runs"."environment_request" is not null and "test_runs"."environment_snapshot" is null and "test_runs"."status" = 'running';