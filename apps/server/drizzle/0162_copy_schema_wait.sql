ALTER TABLE "machines" ADD COLUMN "copy_schema_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "copy_schema_attempt" integer;