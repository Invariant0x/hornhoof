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
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vault_entries" ADD CONSTRAINT "vault_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_entries" ADD CONSTRAINT "vault_entries_scope_department_id_departments_id_fk" FOREIGN KEY ("scope_department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_entries" ADD CONSTRAINT "vault_entries_scope_agent_id_agents_id_fk" FOREIGN KEY ("scope_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_entries" ADD CONSTRAINT "vault_entries_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_entries" ADD CONSTRAINT "vault_entries_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_log" ADD CONSTRAINT "vault_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_log" ADD CONSTRAINT "vault_log_entry_id_vault_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."vault_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_log" ADD CONSTRAINT "vault_log_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_log" ADD CONSTRAINT "vault_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_log" ADD CONSTRAINT "vault_log_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vault_entries_company_name" ON "vault_entries" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX "vault_log_entry_at" ON "vault_log" USING btree ("entry_id","created_at");--> statement-breakpoint
CREATE INDEX "vault_log_company_at" ON "vault_log" USING btree ("company_id","created_at");