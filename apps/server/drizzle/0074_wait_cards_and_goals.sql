ALTER TABLE "wait_notices" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "goal_ref_kind" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "goal_ref_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "goal_episode_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "goal_impact" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "goal_revision" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "goal_state" text;--> statement-breakpoint
ALTER TABLE "wait_notices" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "wait_notices" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wait_notices" ADD COLUMN "acknowledged_by_person_id" uuid;--> statement-breakpoint
ALTER TABLE "wait_notices" ADD CONSTRAINT "wait_notices_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_notices" ADD CONSTRAINT "wait_notices_acknowledged_by_person_id_people_id_fk" FOREIGN KEY ("acknowledged_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "requests_one_open_goal" ON "requests" USING btree ("company_id","goal_ref_kind","goal_ref_id") WHERE "requests"."goal_state" = 'open';--> statement-breakpoint
CREATE INDEX "wait_notices_cards" ON "wait_notices" USING btree ("person_id","created_at") WHERE "wait_notices"."person_id" IS NOT NULL AND "wait_notices"."acknowledged_at" IS NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_goal_whole" CHECK (num_nonnulls("requests"."goal_ref_kind", "requests"."goal_ref_id", "requests"."goal_episode_id", "requests"."goal_impact", "requests"."goal_revision", "requests"."goal_state") IN (0, 6));--> statement-breakpoint
ALTER TABLE "wait_notices" ADD CONSTRAINT "wait_notices_one_recipient" CHECK (("wait_notices"."agent_id" IS NULL) <> ("wait_notices"."person_id" IS NULL));