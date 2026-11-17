CREATE TABLE "company_phones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"transport" text NOT NULL,
	"endpoint" text,
	"hardware_key" text NOT NULL,
	"name" text NOT NULL,
	"lending" boolean DEFAULT true NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "company_phones_generation" CHECK ("company_phones"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "phone_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"phone_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"declaration_id" uuid,
	"account" text NOT NULL,
	"kind" text NOT NULL,
	"text" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_frames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"attachment_id" uuid,
	"capture" jsonb NOT NULL,
	CONSTRAINT "phone_frames_sequence" UNIQUE("session_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "phone_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"phone_id" uuid,
	"queue_order" bigserial NOT NULL,
	"agent_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"generation" integer,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "phone_sessions_held_phone" CHECK ("phone_sessions"."status" in ('queued', 'cancelled') or "phone_sessions"."phone_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "company_phones" ADD CONSTRAINT "company_phones_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_phones" ADD CONSTRAINT "company_phones_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_phones" ADD CONSTRAINT "company_phones_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_phones" ADD CONSTRAINT "company_phones_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_actions" ADD CONSTRAINT "phone_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_actions" ADD CONSTRAINT "phone_actions_phone_id_company_phones_id_fk" FOREIGN KEY ("phone_id") REFERENCES "public"."company_phones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_actions" ADD CONSTRAINT "phone_actions_session_id_phone_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."phone_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_actions" ADD CONSTRAINT "phone_actions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_actions" ADD CONSTRAINT "phone_actions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_frames" ADD CONSTRAINT "phone_frames_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_frames" ADD CONSTRAINT "phone_frames_session_id_phone_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."phone_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_frames" ADD CONSTRAINT "phone_frames_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_sessions" ADD CONSTRAINT "phone_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_sessions" ADD CONSTRAINT "phone_sessions_phone_id_company_phones_id_fk" FOREIGN KEY ("phone_id") REFERENCES "public"."company_phones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_sessions" ADD CONSTRAINT "phone_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_sessions" ADD CONSTRAINT "phone_sessions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_sessions" ADD CONSTRAINT "phone_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_phones_machine_serial" ON "company_phones" USING btree ("machine_id","serial") WHERE "company_phones"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "company_phones_hardware" ON "company_phones" USING btree ("hardware_key") WHERE "company_phones"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "company_phones_company" ON "company_phones" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "phone_actions_account" ON "phone_actions" USING btree ("phone_id","account","at");--> statement-breakpoint
CREATE INDEX "phone_actions_session" ON "phone_actions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "phone_actions_task" ON "phone_actions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "phone_frames_session" ON "phone_frames" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "phone_sessions_task" ON "phone_sessions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "phone_sessions_company_queue" ON "phone_sessions" USING btree ("company_id","queue_order");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_sessions_active" ON "phone_sessions" USING btree ("phone_id") WHERE "phone_sessions"."status" in ('starting', 'active', 'revoking');--> statement-breakpoint
CREATE UNIQUE INDEX "phone_sessions_job" ON "phone_sessions" USING btree ("job_id") WHERE "phone_sessions"."status" in ('queued', 'starting', 'active', 'revoking');