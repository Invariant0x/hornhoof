CREATE TABLE "notebook_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"text" text NOT NULL,
	"person_id" uuid,
	"by_orchestrator" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "notebook_notes_company_number" UNIQUE("company_id","number")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "timer_minutes" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "timer_order" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "timer_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "timer_for_work" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notebook_notes" ADD CONSTRAINT "notebook_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_notes" ADD CONSTRAINT "notebook_notes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_agent_id_status" ON "jobs" USING btree ("agent_id","status");