ALTER TABLE "turns" ALTER COLUMN "started_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "messages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "turns" SET "opened_at" = "created_at";
