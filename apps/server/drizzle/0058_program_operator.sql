CREATE TABLE "program_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"program_instance_id" uuid,
	"ordinal" integer NOT NULL,
	"reference" text NOT NULL,
	"kind" text NOT NULL,
	"digest" text NOT NULL,
	"source_delivery_id" uuid,
	"attempted_at" timestamp with time zone,
	"receipt_at" timestamp with time zone,
	"first_activity_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_deliveries_ordinal" UNIQUE("agent_id","ordinal"),
	CONSTRAINT "program_deliveries_reference" UNIQUE("agent_id","reference")
);
--> statement-breakpoint
CREATE TABLE "program_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"launched" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"exited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_operator_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"operator_agent_id" uuid NOT NULL,
	"operator_job_id" uuid NOT NULL,
	"actor_name" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"program_instance_id" uuid NOT NULL,
	"snapshot" text NOT NULL,
	"generation" integer NOT NULL,
	"key" text NOT NULL,
	"reason" text NOT NULL,
	"digest" text NOT NULL,
	"result" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "program_operator_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"program_instance_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence_key" text NOT NULL,
	"delivery_id" uuid,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"capability" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"operator_agent_id" uuid,
	"operator_job_id" uuid,
	"escalation_job_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"escalated_at" timestamp with time zone,
	"resolution" jsonb,
	"recovery_hold" boolean DEFAULT false NOT NULL,
	"continuation_job_id" uuid,
	"snapshot" jsonb,
	"picture_id" uuid,
	CONSTRAINT "program_operator_case_evidence" UNIQUE("company_id","agent_id","program_instance_id","reason","evidence_key")
);
--> statement-breakpoint
CREATE TABLE "program_operator_signals" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"program_instance_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence_key" text NOT NULL,
	"case_id" uuid NOT NULL,
	CONSTRAINT "program_operator_signals_agent_id_program_instance_id_reason_evidence_key_pk" PRIMARY KEY("agent_id","program_instance_id","reason","evidence_key")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "operator_case_id" uuid;--> statement-breakpoint
ALTER TABLE "program_deliveries" ADD CONSTRAINT "program_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_deliveries" ADD CONSTRAINT "program_deliveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_deliveries" ADD CONSTRAINT "program_deliveries_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_deliveries" ADD CONSTRAINT "program_deliveries_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_deliveries" ADD CONSTRAINT "program_deliveries_program_instance_id_program_instances_id_fk" FOREIGN KEY ("program_instance_id") REFERENCES "public"."program_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_deliveries" ADD CONSTRAINT "program_deliveries_source_delivery_id_program_deliveries_id_fk" FOREIGN KEY ("source_delivery_id") REFERENCES "public"."program_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_instances" ADD CONSTRAINT "program_instances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_instances" ADD CONSTRAINT "program_instances_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_instances" ADD CONSTRAINT "program_instances_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_actions" ADD CONSTRAINT "program_operator_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_actions" ADD CONSTRAINT "program_operator_actions_case_id_program_operator_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."program_operator_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_actions" ADD CONSTRAINT "program_operator_actions_operator_agent_id_agents_id_fk" FOREIGN KEY ("operator_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_actions" ADD CONSTRAINT "program_operator_actions_operator_job_id_jobs_id_fk" FOREIGN KEY ("operator_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_actions" ADD CONSTRAINT "program_operator_actions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_actions" ADD CONSTRAINT "program_operator_actions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_actions" ADD CONSTRAINT "program_operator_actions_program_instance_id_program_instances_id_fk" FOREIGN KEY ("program_instance_id") REFERENCES "public"."program_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_cases" ADD CONSTRAINT "program_operator_cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_cases" ADD CONSTRAINT "program_operator_cases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_cases" ADD CONSTRAINT "program_operator_cases_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_cases" ADD CONSTRAINT "program_operator_cases_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_cases" ADD CONSTRAINT "program_operator_cases_program_instance_id_program_instances_id_fk" FOREIGN KEY ("program_instance_id") REFERENCES "public"."program_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_cases" ADD CONSTRAINT "program_operator_cases_delivery_id_program_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."program_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_cases" ADD CONSTRAINT "program_operator_cases_operator_agent_id_agents_id_fk" FOREIGN KEY ("operator_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_cases" ADD CONSTRAINT "program_operator_cases_operator_job_id_jobs_id_fk" FOREIGN KEY ("operator_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_cases" ADD CONSTRAINT "program_operator_cases_escalation_job_id_jobs_id_fk" FOREIGN KEY ("escalation_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_cases" ADD CONSTRAINT "program_operator_cases_continuation_job_id_jobs_id_fk" FOREIGN KEY ("continuation_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_cases" ADD CONSTRAINT "program_operator_cases_picture_id_attachments_id_fk" FOREIGN KEY ("picture_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_signals" ADD CONSTRAINT "program_operator_signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_signals" ADD CONSTRAINT "program_operator_signals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_signals" ADD CONSTRAINT "program_operator_signals_program_instance_id_program_instances_id_fk" FOREIGN KEY ("program_instance_id") REFERENCES "public"."program_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_operator_signals" ADD CONSTRAINT "program_operator_signals_case_id_program_operator_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."program_operator_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_deliveries_job_id" ON "program_deliveries" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "program_instances_agent_id" ON "program_instances" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "program_operator_actions_case_id" ON "program_operator_actions" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "program_operator_case_open" ON "program_operator_cases" USING btree ("agent_id","program_instance_id") WHERE "program_operator_cases"."status" = 'open';--> statement-breakpoint
CREATE INDEX "program_operator_case_deadline" ON "program_operator_cases" USING btree ("deadline_at") WHERE "program_operator_cases"."status" = 'open';--> statement-breakpoint
CREATE INDEX "program_operator_case_hold" ON "program_operator_cases" USING btree ("agent_id") WHERE "program_operator_cases"."recovery_hold";--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_operator_case_id_program_operator_cases_id_fk" FOREIGN KEY ("operator_case_id") REFERENCES "public"."program_operator_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_events_operator_evidence" ON "agent_events" USING btree ("company_id",(data->>'operatorEvidenceId')) WHERE data->>'operatorEvidenceId' is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_events_operator_ordinal" ON "agent_events" USING btree ("company_id",(data->'operatorEvidence'->>'instance'),(data->'operatorEvidence'->>'ordinal')) WHERE data->>'operatorEvidenceId' is not null;--> statement-breakpoint
CREATE INDEX "agent_events_operator_instance" ON "agent_events" USING btree ("agent_id",(data->'operatorEvidence'->>'instance')) WHERE data->>'operatorEvidenceId' is not null;--> statement-breakpoint
CREATE INDEX "attachments_operator_case_id" ON "attachments" USING btree ("operator_case_id");