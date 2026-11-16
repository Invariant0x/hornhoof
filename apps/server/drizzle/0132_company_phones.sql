CREATE TABLE "company_phones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"transport" text NOT NULL,
	"endpoint" text,
	"hardware_key" text,
	"name" text NOT NULL,
	"lending" boolean DEFAULT true NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "company_phones_generation" CHECK ("company_phones"."generation" >= 0)
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
	"phone_id" uuid NOT NULL,
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
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "vault_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"site" text NOT NULL,
	"login" text NOT NULL,
	"password_enc" text NOT NULL,
	"totp_enc" text,
	"scope_kind" text DEFAULT 'company' NOT NULL,
	"scope_department_id" uuid,
	"scope_agent_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_entries_scope" CHECK (("vault_entries"."scope_kind" = 'company' AND "vault_entries"."scope_department_id" IS NULL AND "vault_entries"."scope_agent_id" IS NULL) OR ("vault_entries"."scope_kind" = 'department' AND "vault_entries"."scope_department_id" IS NOT NULL AND "vault_entries"."scope_agent_id" IS NULL) OR ("vault_entries"."scope_kind" = 'agent' AND "vault_entries"."scope_agent_id" IS NOT NULL AND "vault_entries"."scope_department_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "vault_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_id" uuid,
	"entry_name" text NOT NULL,
	"site" text NOT NULL,
	"kind" text NOT NULL,
	"person_id" uuid,
	"agent_id" uuid,
	"job_id" uuid,
	"task_id" uuid,
	"target" text,
	"fields" jsonb,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "company_phones" ADD CONSTRAINT "company_phones_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_phones" ADD CONSTRAINT "company_phones_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_phones" ADD CONSTRAINT "company_phones_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_phones" ADD CONSTRAINT "company_phones_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_frames" ADD CONSTRAINT "phone_frames_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_frames" ADD CONSTRAINT "phone_frames_session_id_phone_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."phone_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_frames" ADD CONSTRAINT "phone_frames_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_sessions" ADD CONSTRAINT "phone_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_sessions" ADD CONSTRAINT "phone_sessions_phone_id_company_phones_id_fk" FOREIGN KEY ("phone_id") REFERENCES "public"."company_phones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_sessions" ADD CONSTRAINT "phone_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_sessions" ADD CONSTRAINT "phone_sessions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_sessions" ADD CONSTRAINT "phone_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_entries" ADD CONSTRAINT "vault_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_entries" ADD CONSTRAINT "vault_entries_scope_department_id_departments_id_fk" FOREIGN KEY ("scope_department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_entries" ADD CONSTRAINT "vault_entries_scope_agent_id_agents_id_fk" FOREIGN KEY ("scope_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_entries" ADD CONSTRAINT "vault_entries_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_entries" ADD CONSTRAINT "vault_entries_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_log" ADD CONSTRAINT "vault_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_log" ADD CONSTRAINT "vault_log_entry_id_vault_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."vault_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_log" ADD CONSTRAINT "vault_log_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_log" ADD CONSTRAINT "vault_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_log" ADD CONSTRAINT "vault_log_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_log" ADD CONSTRAINT "vault_log_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_phones_machine_serial" ON "company_phones" USING btree ("machine_id","serial") WHERE "company_phones"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "company_phones_hardware" ON "company_phones" USING btree ("hardware_key") WHERE "company_phones"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "company_phones_company" ON "company_phones" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "phone_frames_session" ON "phone_frames" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "phone_sessions_task" ON "phone_sessions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "phone_sessions_job" ON "phone_sessions" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "phone_sessions_queue" ON "phone_sessions" USING btree ("phone_id","queue_order");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_sessions_active" ON "phone_sessions" USING btree ("phone_id") WHERE "phone_sessions"."status" in ('starting', 'active', 'revoking');--> statement-breakpoint
CREATE UNIQUE INDEX "phone_sessions_borrower" ON "phone_sessions" USING btree ("phone_id","job_id") WHERE "phone_sessions"."status" in ('queued', 'starting', 'active', 'revoking');--> statement-breakpoint
CREATE UNIQUE INDEX "vault_entries_company_name" ON "vault_entries" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX "vault_log_entry_at" ON "vault_log" USING btree ("entry_id","created_at");--> statement-breakpoint
CREATE INDEX "vault_log_company_at" ON "vault_log" USING btree ("company_id","created_at");