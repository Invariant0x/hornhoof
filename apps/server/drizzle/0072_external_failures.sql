CREATE TABLE "external_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"intent_digest" text NOT NULL,
	"intent" jsonb NOT NULL,
	"consumer" jsonb NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"current_attempt_id" uuid,
	"outcome" jsonb,
	"postcondition_sha" text,
	"cancelled_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_operations_company_identity" UNIQUE("id","company_id"),
	CONSTRAINT "external_operations_digest" CHECK ("external_operations"."intent_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "external_operations_generation" CHECK ("external_operations"."generation" > 0),
	CONSTRAINT "external_operations_state" CHECK ("external_operations"."state" IN ('ready','executing','deferred','outcome_unknown','satisfied','failed_permanent','cancelled')),
	CONSTRAINT "external_operations_intent_bound" CHECK (jsonb_typeof("external_operations"."intent") = 'object' AND octet_length("external_operations"."intent"::text) <= 16384),
	CONSTRAINT "external_operations_consumer_bound" CHECK (jsonb_typeof("external_operations"."consumer") = 'object' AND octet_length("external_operations"."consumer"::text) <= 4096),
	CONSTRAINT "external_operations_outcome_bound" CHECK ("external_operations"."outcome" IS NULL OR (jsonb_typeof("external_operations"."outcome") = 'object' AND octet_length("external_operations"."outcome"::text) <= 65536)),
	CONSTRAINT "external_operations_postcondition" CHECK ("external_operations"."postcondition_sha" IS NULL OR "external_operations"."postcondition_sha" ~ '^[a-f0-9]{40}$')
);
--> statement-breakpoint
CREATE TABLE "external_recovery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"producer_node_id" uuid,
	"producer_link_id" uuid,
	"outcome" jsonb,
	"settlement" jsonb,
	"receipt_digest" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "external_attempts_generation" UNIQUE("operation_id","generation"),
	CONSTRAINT "external_attempts_generation_positive" CHECK ("external_recovery_attempts"."generation" > 0),
	CONSTRAINT "external_attempts_receipt" CHECK ("external_recovery_attempts"."receipt_digest" IS NULL OR "external_recovery_attempts"."receipt_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "external_attempts_outcome_bound" CHECK ("external_recovery_attempts"."outcome" IS NULL OR (jsonb_typeof("external_recovery_attempts"."outcome") = 'object' AND octet_length("external_recovery_attempts"."outcome"::text) <= 65536)),
	CONSTRAINT "external_attempts_settlement_bound" CHECK ("external_recovery_attempts"."settlement" IS NULL OR (jsonb_typeof("external_recovery_attempts"."settlement") = 'object' AND octet_length("external_recovery_attempts"."settlement"::text) <= 4096))
);
--> statement-breakpoint
CREATE TABLE "external_recovery_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_digest" text NOT NULL,
	"adapter" text NOT NULL,
	"endpoint_digest" text NOT NULL,
	"credential_revision" integer NOT NULL,
	"failure_family" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"first_failure_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"ops_deadline_at" timestamp with time zone NOT NULL,
	"policy_revision" integer NOT NULL,
	"owner_agent_id" uuid,
	"claim_operation_id" uuid,
	"claim_until" timestamp with time zone,
	"release_revision" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_cases_company_identity" UNIQUE("id","company_id"),
	CONSTRAINT "external_cases_scope" CHECK ("external_recovery_cases"."scope_digest" ~ '^[a-f0-9]{64}$' AND "external_recovery_cases"."endpoint_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "external_cases_adapter" CHECK ("external_recovery_cases"."adapter" = 'git'),
	CONSTRAINT "external_cases_family" CHECK ("external_recovery_cases"."failure_family" IN ('transport','temporary','rate_limit')),
	CONSTRAINT "external_cases_revisions" CHECK ("external_recovery_cases"."credential_revision" > 0 AND "external_recovery_cases"."policy_revision" > 0 AND "external_recovery_cases"."generation" > 0 AND "external_recovery_cases"."release_revision" >= 0),
	CONSTRAINT "external_cases_deadline" CHECK ("external_recovery_cases"."ops_deadline_at" >= "external_recovery_cases"."first_failure_at"),
	CONSTRAINT "external_cases_claim_pair" CHECK (("external_recovery_cases"."claim_operation_id" IS NULL) = ("external_recovery_cases"."claim_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "external_recovery_members" (
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"release_revision" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "external_recovery_members_case_id_operation_id_pk" PRIMARY KEY("case_id","operation_id"),
	CONSTRAINT "external_members_release_revision" CHECK ("external_recovery_members"."release_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "external_recovery_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"notice_kind" text NOT NULL,
	"notification_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_notices_one_logical_signal" UNIQUE("company_id","case_id","notice_kind"),
	CONSTRAINT "external_notices_kind" CHECK ("external_recovery_notices"."notice_kind" = 'operations')
);
--> statement-breakpoint
ALTER TABLE "external_operations" ADD CONSTRAINT "external_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recovery_attempts" ADD CONSTRAINT "external_recovery_attempts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recovery_attempts" ADD CONSTRAINT "external_recovery_attempts_producer_node_id_nodes_id_fk" FOREIGN KEY ("producer_node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recovery_attempts" ADD CONSTRAINT "external_recovery_attempts_operation_id_company_id_external_operations_id_company_id_fk" FOREIGN KEY ("operation_id","company_id") REFERENCES "public"."external_operations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recovery_cases" ADD CONSTRAINT "external_recovery_cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recovery_cases" ADD CONSTRAINT "external_recovery_cases_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recovery_members" ADD CONSTRAINT "external_recovery_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recovery_members" ADD CONSTRAINT "external_recovery_members_case_id_company_id_external_recovery_cases_id_company_id_fk" FOREIGN KEY ("case_id","company_id") REFERENCES "public"."external_recovery_cases"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recovery_members" ADD CONSTRAINT "external_recovery_members_operation_id_company_id_external_operations_id_company_id_fk" FOREIGN KEY ("operation_id","company_id") REFERENCES "public"."external_operations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recovery_notices" ADD CONSTRAINT "external_recovery_notices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recovery_notices" ADD CONSTRAINT "external_recovery_notices_case_id_company_id_external_recovery_cases_id_company_id_fk" FOREIGN KEY ("case_id","company_id") REFERENCES "public"."external_recovery_cases"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_operations_state" ON "external_operations" USING btree ("company_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "external_cases_open_scope" ON "external_recovery_cases" USING btree ("company_id","scope_digest") WHERE "external_recovery_cases"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "external_cases_due" ON "external_recovery_cases" USING btree ("next_attempt_at") WHERE "external_recovery_cases"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "external_cases_ops_due" ON "external_recovery_cases" USING btree ("ops_deadline_at") WHERE "external_recovery_cases"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "external_members_operation" ON "external_recovery_members" USING btree ("operation_id");