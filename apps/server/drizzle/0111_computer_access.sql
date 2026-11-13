CREATE TABLE "computer_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"job_id" uuid,
	"agent_id" uuid,
	"command" text NOT NULL,
	"timeout_s" integer NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"exit" integer,
	"output" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	CONSTRAINT "computer_runs_state" CHECK (state IN ('waiting', 'sent', 'done', 'lost')),
	CONSTRAINT "computer_runs_timeout" CHECK (timeout_s BETWEEN 1 AND 1800)
);
--> statement-breakpoint
ALTER TABLE "computer_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "machine_access" (
	"machine_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"until" timestamp with time zone,
	"asked_reason" text,
	"asked_at" timestamp with time zone,
	"opened_by" uuid,
	"opened_at" timestamp with time zone,
	"grant" jsonb,
	CONSTRAINT "machine_access_asked" CHECK ((asked_reason IS NULL) = (asked_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "machine_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "computer_runs" ADD CONSTRAINT "computer_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_runs" ADD CONSTRAINT "computer_runs_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_runs" ADD CONSTRAINT "computer_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_runs" ADD CONSTRAINT "computer_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_access" ADD CONSTRAINT "machine_access_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_access" ADD CONSTRAINT "machine_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_access" ADD CONSTRAINT "machine_access_opened_by_people_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "computer_runs_machine_state" ON "computer_runs" USING btree ("machine_id","state");