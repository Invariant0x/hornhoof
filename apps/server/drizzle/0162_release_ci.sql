CREATE TABLE "ci_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"commit" text NOT NULL,
	"branch" text NOT NULL,
	"workflow" text NOT NULL,
	"run_id" bigint,
	"state" text DEFAULT 'waiting' NOT NULL,
	"note" text,
	"release_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "ci_dispatches_company_commit" UNIQUE("company_id","commit"),
	CONSTRAINT "ci_dispatches_commit" CHECK ("ci_dispatches"."commit" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "ci_dispatches_state" CHECK ("ci_dispatches"."state" IN ('waiting', 'recorded', 'ended')),
	CONSTRAINT "ci_dispatches_settled" CHECK (("ci_dispatches"."state" = 'waiting') = ("ci_dispatches"."settled_at" IS NULL)),
	CONSTRAINT "ci_dispatches_recorded" CHECK (("ci_dispatches"."state" = 'recorded') = ("ci_dispatches"."release_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "autonomous_releases" ALTER COLUMN "test_run_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "autonomous_releases" ADD COLUMN "ci_state" text;--> statement-breakpoint
ALTER TABLE "autonomous_releases" ADD COLUMN "ci_checks" integer;--> statement-breakpoint
ALTER TABLE "turn_releases" ADD COLUMN "ci_state" text;--> statement-breakpoint
ALTER TABLE "turn_releases" ADD COLUMN "ci_checks" integer;--> statement-breakpoint
ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_release_id_turn_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."turn_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_dispatches_waiting" ON "ci_dispatches" USING btree ("created_at") WHERE state = 'waiting';--> statement-breakpoint
ALTER TABLE "autonomous_releases" ADD CONSTRAINT "autonomous_releases_proof" CHECK (("autonomous_releases"."test_run_number" IS NOT NULL AND "autonomous_releases"."ci_state" IS NULL AND "autonomous_releases"."ci_checks" IS NULL) OR ("autonomous_releases"."test_run_number" IS NULL AND (("autonomous_releases"."ci_state" = 'green' AND "autonomous_releases"."ci_checks" > 0) IS TRUE OR ("autonomous_releases"."ci_state" = 'none' AND "autonomous_releases"."ci_checks" IS NULL) IS TRUE)));--> statement-breakpoint
ALTER TABLE "turn_releases" ADD CONSTRAINT "turn_releases_ci" CHECK (("turn_releases"."ci_state" IS NULL AND "turn_releases"."ci_checks" IS NULL) OR ("turn_releases"."run_id" IS NULL AND (("turn_releases"."ci_state" = 'green' AND "turn_releases"."ci_checks" > 0) IS TRUE OR ("turn_releases"."ci_state" = 'none' AND "turn_releases"."ci_checks" IS NULL) IS TRUE)));