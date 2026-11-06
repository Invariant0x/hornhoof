ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id" UNIQUE("company_id","id");
--> statement-breakpointALTER TABLE "requests" ADD CONSTRAINT "requests_company_id" UNIQUE("company_id","id");
--> statement-breakpointCREATE TABLE "model_check_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"binding_digest" text NOT NULL,
	"report_id" uuid NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invalidated_reason" text,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_check_certificates_status" CHECK ("model_check_certificates"."status" IN ('active', 'invalidated')),
	CONSTRAINT "model_check_certificates_validity" CHECK ("model_check_certificates"."valid_until" > "model_check_certificates"."evaluated_at"),
	CONSTRAINT "model_check_certificates_end" CHECK (("model_check_certificates"."status" = 'invalidated') = ("model_check_certificates"."invalidated_reason" IS NOT NULL) AND ("model_check_certificates"."status" = 'invalidated') = ("model_check_certificates"."invalidated_at" IS NOT NULL)),
	CONSTRAINT "model_check_certificates_binding" CHECK ("model_check_certificates"."binding_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbound_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"product_id" uuid,
	"channel_id" uuid NOT NULL,
	"sender_domain" text NOT NULL,
	"label" text NOT NULL,
	"config_enc" text NOT NULL,
	"config_generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_accounts_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "outbound_accounts_label" UNIQUE("channel_id","label"),
	CONSTRAINT "outbound_accounts_domain" CHECK ("outbound_accounts"."sender_domain" = lower("outbound_accounts"."sender_domain") AND "outbound_accounts"."sender_domain" <> ''),
	CONSTRAINT "outbound_accounts_status" CHECK ("outbound_accounts"."status" IN ('active', 'invalid', 'revoked')),
	CONSTRAINT "outbound_accounts_generation" CHECK ("outbound_accounts"."config_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "outbound_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"message_id" uuid,
	"message_revision" integer,
	"content_digest" text,
	"account_id" uuid,
	"binding_generation" integer,
	"channel_id" uuid,
	"template_id" uuid,
	"template_revision" integer,
	"segment_id" uuid,
	"locale" text,
	"policy_digest" text NOT NULL,
	"source_revisions_digest" text NOT NULL,
	"authority_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_approvals_request" UNIQUE("request_id"),
	CONSTRAINT "outbound_approvals_kind" CHECK (CASE "outbound_approvals"."kind"
    WHEN 'message' THEN "outbound_approvals"."message_id" IS NOT NULL AND "outbound_approvals"."message_revision" IS NOT NULL AND "outbound_approvals"."content_digest" IS NOT NULL AND "outbound_approvals"."account_id" IS NOT NULL AND "outbound_approvals"."binding_generation" IS NOT NULL AND "outbound_approvals"."channel_id" IS NULL AND "outbound_approvals"."template_id" IS NULL AND "outbound_approvals"."template_revision" IS NULL AND "outbound_approvals"."segment_id" IS NULL AND "outbound_approvals"."locale" IS NULL
    WHEN 'approach' THEN "outbound_approvals"."channel_id" IS NOT NULL AND "outbound_approvals"."template_id" IS NOT NULL AND "outbound_approvals"."template_revision" IS NOT NULL AND "outbound_approvals"."segment_id" IS NOT NULL AND "outbound_approvals"."locale" IS NOT NULL AND "outbound_approvals"."message_id" IS NULL AND "outbound_approvals"."message_revision" IS NULL AND "outbound_approvals"."content_digest" IS NULL AND "outbound_approvals"."account_id" IS NULL AND "outbound_approvals"."binding_generation" IS NULL
    ELSE false END),
	CONSTRAINT "outbound_approvals_content" CHECK ("outbound_approvals"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "outbound_approvals_policy" CHECK ("outbound_approvals"."policy_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "outbound_approvals_sources" CHECK ("outbound_approvals"."source_revisions_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "outbound_approvals_authority" CHECK ("outbound_approvals"."authority_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbound_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"message_revision" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"config_generation" integer NOT NULL,
	"channel_generation" integer NOT NULL,
	"account_bucket_id" uuid NOT NULL,
	"domain_bucket_id" uuid NOT NULL,
	"status" text NOT NULL,
	"provider_receipt" text,
	"safe_code" text,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_attempts_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "outbound_attempts_status" CHECK ("outbound_attempts"."status" IN ('reserved', 'sending', 'accepted', 'definitely_not_accepted', 'unknown')),
	CONSTRAINT "outbound_attempts_outcome" CHECK (CASE "outbound_attempts"."status"
    WHEN 'accepted' THEN "outbound_attempts"."provider_receipt" IS NOT NULL AND "outbound_attempts"."safe_code" IS NULL AND "outbound_attempts"."ended_at" IS NOT NULL
    WHEN 'definitely_not_accepted' THEN "outbound_attempts"."safe_code" IS NOT NULL AND "outbound_attempts"."provider_receipt" IS NULL AND "outbound_attempts"."ended_at" IS NOT NULL
    WHEN 'unknown' THEN "outbound_attempts"."safe_code" IS NOT NULL AND "outbound_attempts"."provider_receipt" IS NULL AND "outbound_attempts"."ended_at" IS NOT NULL
    ELSE "outbound_attempts"."safe_code" IS NULL AND "outbound_attempts"."provider_receipt" IS NULL AND "outbound_attempts"."ended_at" IS NULL END)
);
--> statement-breakpoint
CREATE TABLE "outbound_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "outbound_bindings_generation" UNIQUE("account_id","generation"),
	CONSTRAINT "outbound_bindings_status" CHECK ("outbound_bindings"."status" IN ('active', 'released')),
	CONSTRAINT "outbound_bindings_positive" CHECK ("outbound_bindings"."generation" > 0),
	CONSTRAINT "outbound_bindings_release" CHECK (("outbound_bindings"."status" = 'released') = ("outbound_bindings"."released_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "outbound_catalog_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"product_id" uuid,
	"channel_id" uuid,
	"entry_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"locale" text,
	"value" jsonb NOT NULL,
	"digest" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"created_by_kind" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_catalog_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "outbound_catalog_revision" UNIQUE("company_id","entry_id","revision"),
	CONSTRAINT "outbound_catalog_positive" CHECK ("outbound_catalog_revisions"."revision" > 0),
	CONSTRAINT "outbound_catalog_kind" CHECK ("outbound_catalog_revisions"."value" ->> 'kind' = "outbound_catalog_revisions"."kind"),
	CONSTRAINT "outbound_catalog_status" CHECK ("outbound_catalog_revisions"."status" IN ('proposed', 'published', 'revoked')),
	CONSTRAINT "outbound_catalog_author" CHECK ("outbound_catalog_revisions"."created_by_kind" IN ('person', 'agent')),
	CONSTRAINT "outbound_catalog_published" CHECK (("outbound_catalog_revisions"."status" = 'proposed') = ("outbound_catalog_revisions"."published_by" IS NULL) AND ("outbound_catalog_revisions"."published_by" IS NULL) = ("outbound_catalog_revisions"."published_at" IS NULL)),
	CONSTRAINT "outbound_catalog_revoked" CHECK (("outbound_catalog_revisions"."status" = 'revoked') = ("outbound_catalog_revisions"."revoked_at" IS NOT NULL)),
	CONSTRAINT "outbound_catalog_validity" CHECK ("outbound_catalog_revisions"."valid_until" IS NULL OR "outbound_catalog_revisions"."valid_until" > "outbound_catalog_revisions"."valid_from"),
	CONSTRAINT "outbound_catalog_digest" CHECK ("outbound_catalog_revisions"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbound_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"adapter" text NOT NULL,
	"purpose" text NOT NULL,
	"audience" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"stopped_reason" text,
	"stopped_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_channels_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "outbound_channels_place" UNIQUE NULLS NOT DISTINCT("department_id","product_id","name"),
	CONSTRAINT "outbound_channels_adapter" CHECK ("outbound_channels"."adapter" IN ('smtp', 'webhook')),
	CONSTRAINT "outbound_channels_audience" CHECK ("outbound_channels"."audience" IN ('direct', 'public')),
	CONSTRAINT "outbound_channels_status" CHECK ("outbound_channels"."status" IN ('new', 'active', 'stopped')),
	CONSTRAINT "outbound_channels_generation" CHECK ("outbound_channels"."generation" > 0),
	CONSTRAINT "outbound_channels_stop" CHECK (("outbound_channels"."status" = 'stopped') = ("outbound_channels"."stopped_at" IS NOT NULL) AND ("outbound_channels"."status" = 'stopped') = ("outbound_channels"."stopped_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "outbound_contact_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedup_key" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_contact_events_dedup" UNIQUE("company_id","dedup_key"),
	CONSTRAINT "outbound_contact_events_kind" CHECK ("outbound_contact_events"."kind" IN ('consent_granted', 'consent_revoked', 'unsubscribed', 'suppressed')),
	CONSTRAINT "outbound_contact_events_evidence" CHECK ("outbound_contact_events"."evidence_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbound_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"address_enc" text NOT NULL,
	"address_hash" text NOT NULL,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"suppressed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_contacts_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "outbound_contacts_address" UNIQUE("company_id","kind","address_hash"),
	CONSTRAINT "outbound_contacts_kind" CHECK ("outbound_contacts"."kind" IN ('email', 'direct')),
	CONSTRAINT "outbound_contacts_suppressed" CHECK ("outbound_contacts"."do_not_contact" = ("outbound_contacts"."suppressed_at" IS NOT NULL)),
	CONSTRAINT "outbound_contacts_hash" CHECK ("outbound_contacts"."address_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbound_daily_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"day" date NOT NULL,
	"timezone" text NOT NULL,
	"limit_version" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"unknown" integer DEFAULT 0 NOT NULL,
	"definitely_failed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_daily_usage_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "outbound_daily_usage_bucket" UNIQUE("company_id","scope","scope_key","day","timezone","limit_version"),
	CONSTRAINT "outbound_daily_usage_scope" CHECK ("outbound_daily_usage"."scope" IN ('account', 'domain')),
	CONSTRAINT "outbound_daily_usage_counts" CHECK ("outbound_daily_usage"."reserved" >= 0 AND "outbound_daily_usage"."accepted" >= 0 AND "outbound_daily_usage"."unknown" >= 0 AND "outbound_daily_usage"."definitely_failed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "outbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"attempt_id" uuid,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_events_once" UNIQUE("company_id","source","provider_event_id"),
	CONSTRAINT "outbound_events_kind" CHECK ("outbound_events"."kind" IN ('delivered', 'bounce', 'refusal', 'complaint'))
);
--> statement-breakpoint
CREATE TABLE "outbound_message_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"sealed_enc" text NOT NULL,
	"source_revisions_digest" text NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_message_revisions_number" UNIQUE("message_id","revision"),
	CONSTRAINT "outbound_message_revisions_positive" CHECK ("outbound_message_revisions"."revision" > 0),
	CONSTRAINT "outbound_message_revisions_content" CHECK ("outbound_message_revisions"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "outbound_message_revisions_sources" CHECK ("outbound_message_revisions"."source_revisions_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "outbound_message_revisions_policy_digest" CHECK ("outbound_message_revisions"."policy_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"product_id" uuid,
	"task_id" uuid NOT NULL,
	"author_agent_id" uuid NOT NULL,
	"author_job_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"binding_generation" integer NOT NULL,
	"target_kind" text NOT NULL,
	"contact_id" uuid,
	"audience_entry_id" uuid,
	"ticket_id" uuid,
	"ticket_revision" integer,
	"classification_id" uuid,
	"segment_id" uuid,
	"sampling_ordinals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_messages_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "outbound_messages_idempotency" UNIQUE("company_id","author_agent_id","idempotency_key"),
	CONSTRAINT "outbound_messages_positive" CHECK ("outbound_messages"."revision" > 0),
	CONSTRAINT "outbound_messages_status" CHECK ("outbound_messages"."status" IN ('scheduled', 'waiting_checks', 'waiting_approval', 'rejected', 'reserved', 'sending', 'sent', 'definitely_failed', 'unknown', 'cancelled')),
	CONSTRAINT "outbound_messages_target" CHECK (CASE "outbound_messages"."target_kind"
    WHEN 'contact' THEN "outbound_messages"."contact_id" IS NOT NULL AND "outbound_messages"."segment_id" IS NOT NULL AND "outbound_messages"."audience_entry_id" IS NULL AND "outbound_messages"."ticket_id" IS NULL AND "outbound_messages"."ticket_revision" IS NULL AND "outbound_messages"."classification_id" IS NULL
    WHEN 'audience' THEN "outbound_messages"."audience_entry_id" IS NOT NULL AND "outbound_messages"."segment_id" IS NOT NULL AND "outbound_messages"."contact_id" IS NULL AND "outbound_messages"."ticket_id" IS NULL AND "outbound_messages"."ticket_revision" IS NULL AND "outbound_messages"."classification_id" IS NULL
    WHEN 'ticket' THEN "outbound_messages"."contact_id" IS NOT NULL AND "outbound_messages"."ticket_id" IS NOT NULL AND "outbound_messages"."ticket_revision" IS NOT NULL AND "outbound_messages"."classification_id" IS NOT NULL AND "outbound_messages"."segment_id" IS NULL AND "outbound_messages"."audience_entry_id" IS NULL
    ELSE false END),
	CONSTRAINT "outbound_messages_rejected" CHECK ("outbound_messages"."status" <> 'rejected' OR jsonb_array_length("outbound_messages"."reason_codes") > 0),
	CONSTRAINT "outbound_messages_request" CHECK ("outbound_messages"."request_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbound_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'granted' NOT NULL,
	"source" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "outbound_permissions_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "outbound_permissions_status" CHECK ("outbound_permissions"."status" IN ('granted', 'revoked')),
	CONSTRAINT "outbound_permissions_revoked" CHECK (("outbound_permissions"."status" = 'revoked') = ("outbound_permissions"."revoked_at" IS NOT NULL)),
	CONSTRAINT "outbound_permissions_evidence" CHECK ("outbound_permissions"."evidence_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbound_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"digest" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_policies_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "outbound_policies_revision" UNIQUE("channel_id","revision"),
	CONSTRAINT "outbound_policies_positive" CHECK ("outbound_policies"."revision" > 0),
	CONSTRAINT "outbound_policies_digest" CHECK ("outbound_policies"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbound_review_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"message_revision" integer NOT NULL,
	"check_id" uuid NOT NULL,
	"binding_digest" text NOT NULL,
	"subject_digest" text NOT NULL,
	"reviewer" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_review_receipts_once" UNIQUE("message_id","message_revision","binding_digest"),
	CONSTRAINT "outbound_review_receipts_binding" CHECK ("outbound_review_receipts"."binding_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "outbound_review_receipts_subject" CHECK ("outbound_review_receipts"."subject_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbound_sampling_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"next" integer DEFAULT 1 NOT NULL,
	"clean_outcomes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_sampling_counters_scope" UNIQUE("company_id","channel_id","scope","scope_key"),
	CONSTRAINT "outbound_sampling_counters_kind" CHECK ("outbound_sampling_counters"."scope" IN ('channel', 'segment', 'author')),
	CONSTRAINT "outbound_sampling_counters_values" CHECK ("outbound_sampling_counters"."next" > 0 AND "outbound_sampling_counters"."clean_outcomes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "support_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"ticket_revision" integer NOT NULL,
	"ticket_digest" text NOT NULL,
	"binding_digest" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"class_id" text,
	"requires_human" boolean,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewer" jsonb,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_classifications_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "support_classifications_once" UNIQUE("company_id","ticket_id","ticket_revision","binding_digest"),
	CONSTRAINT "support_classifications_idempotency" UNIQUE("company_id","idempotency_key"),
	CONSTRAINT "support_classifications_status" CHECK ("support_classifications"."status" IN ('pending', 'ready', 'unavailable')),
	CONSTRAINT "support_classifications_decision" CHECK (CASE "support_classifications"."status"
    WHEN 'pending' THEN "support_classifications"."class_id" IS NULL AND "support_classifications"."requires_human" IS NULL AND "support_classifications"."reviewer" IS NULL AND "support_classifications"."decided_at" IS NULL
    WHEN 'ready' THEN "support_classifications"."class_id" IS NOT NULL AND "support_classifications"."requires_human" IS NOT NULL AND "support_classifications"."reviewer" IS NOT NULL AND "support_classifications"."decided_at" IS NOT NULL
    ELSE "support_classifications"."class_id" IS NULL AND "support_classifications"."requires_human" IS NULL AND "support_classifications"."decided_at" IS NOT NULL END),
	CONSTRAINT "support_classifications_ticket_digest" CHECK ("support_classifications"."ticket_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "support_classifications_binding_digest" CHECK ("support_classifications"."binding_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"product_id" uuid,
	"ticket_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"contact_id" uuid NOT NULL,
	"text_enc" text NOT NULL,
	"digest" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_revision" UNIQUE("company_id","ticket_id","revision"),
	CONSTRAINT "support_tickets_positive" CHECK ("support_tickets"."revision" > 0),
	CONSTRAINT "support_tickets_status" CHECK ("support_tickets"."status" IN ('open', 'escalated', 'closed')),
	CONSTRAINT "support_tickets_digest" CHECK ("support_tickets"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "model_check_certificates" ADD CONSTRAINT "model_check_certificates_check_id_model_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."model_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_check_certificates" ADD CONSTRAINT "model_check_certificates_report" FOREIGN KEY ("report_id") REFERENCES "public"."model_check_evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_accounts" ADD CONSTRAINT "outbound_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_accounts" ADD CONSTRAINT "outbound_accounts_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_accounts" ADD CONSTRAINT "outbound_accounts_department" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_accounts" ADD CONSTRAINT "outbound_accounts_product" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_accounts" ADD CONSTRAINT "outbound_accounts_channel" FOREIGN KEY ("company_id","channel_id") REFERENCES "public"."outbound_channels"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_approvals" ADD CONSTRAINT "outbound_approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_approvals" ADD CONSTRAINT "outbound_approvals_of_request" FOREIGN KEY ("company_id","request_id") REFERENCES "public"."requests"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_approvals" ADD CONSTRAINT "outbound_approvals_message" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."outbound_messages"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_approvals" ADD CONSTRAINT "outbound_approvals_account" FOREIGN KEY ("company_id","account_id") REFERENCES "public"."outbound_accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_approvals" ADD CONSTRAINT "outbound_approvals_channel" FOREIGN KEY ("company_id","channel_id") REFERENCES "public"."outbound_channels"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_approvals" ADD CONSTRAINT "outbound_approvals_revision" FOREIGN KEY ("message_id","message_revision") REFERENCES "public"."outbound_message_revisions"("message_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_message" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."outbound_messages"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_account" FOREIGN KEY ("company_id","account_id") REFERENCES "public"."outbound_accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_account_bucket" FOREIGN KEY ("company_id","account_bucket_id") REFERENCES "public"."outbound_daily_usage"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_domain_bucket" FOREIGN KEY ("company_id","domain_bucket_id") REFERENCES "public"."outbound_daily_usage"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_revision" FOREIGN KEY ("message_id","message_revision") REFERENCES "public"."outbound_message_revisions"("message_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_binding" FOREIGN KEY ("account_id","binding_generation") REFERENCES "public"."outbound_bindings"("account_id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_bindings" ADD CONSTRAINT "outbound_bindings_account" FOREIGN KEY ("company_id","account_id") REFERENCES "public"."outbound_accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_catalog_revisions" ADD CONSTRAINT "outbound_catalog_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_catalog_revisions" ADD CONSTRAINT "outbound_catalog_revisions_published_by_people_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_catalog_revisions" ADD CONSTRAINT "outbound_catalog_department" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_catalog_revisions" ADD CONSTRAINT "outbound_catalog_product" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_catalog_revisions" ADD CONSTRAINT "outbound_catalog_channel" FOREIGN KEY ("company_id","channel_id") REFERENCES "public"."outbound_channels"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_channels" ADD CONSTRAINT "outbound_channels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_channels" ADD CONSTRAINT "outbound_channels_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_channels" ADD CONSTRAINT "outbound_channels_department" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_channels" ADD CONSTRAINT "outbound_channels_product" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_contact_events" ADD CONSTRAINT "outbound_contact_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_contact_events" ADD CONSTRAINT "outbound_contact_events_contact" FOREIGN KEY ("company_id","contact_id") REFERENCES "public"."outbound_contacts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_contacts" ADD CONSTRAINT "outbound_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_daily_usage" ADD CONSTRAINT "outbound_daily_usage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_events" ADD CONSTRAINT "outbound_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_events" ADD CONSTRAINT "outbound_events_attempt" FOREIGN KEY ("company_id","attempt_id") REFERENCES "public"."outbound_attempts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message_revisions" ADD CONSTRAINT "outbound_message_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message_revisions" ADD CONSTRAINT "outbound_message_revisions_message" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."outbound_messages"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message_revisions" ADD CONSTRAINT "outbound_message_revisions_policy" FOREIGN KEY ("company_id","policy_id") REFERENCES "public"."outbound_policies"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_author_job_id_jobs_id_fk" FOREIGN KEY ("author_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_department" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_product" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_channel" FOREIGN KEY ("company_id","channel_id") REFERENCES "public"."outbound_channels"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_account" FOREIGN KEY ("company_id","account_id") REFERENCES "public"."outbound_accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_contact" FOREIGN KEY ("company_id","contact_id") REFERENCES "public"."outbound_contacts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_classification" FOREIGN KEY ("company_id","classification_id") REFERENCES "public"."support_classifications"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_binding" FOREIGN KEY ("account_id","binding_generation") REFERENCES "public"."outbound_bindings"("account_id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_ticket" FOREIGN KEY ("company_id","ticket_id","ticket_revision") REFERENCES "public"."support_tickets"("company_id","ticket_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_permissions" ADD CONSTRAINT "outbound_permissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_permissions" ADD CONSTRAINT "outbound_permissions_contact" FOREIGN KEY ("company_id","contact_id") REFERENCES "public"."outbound_contacts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_permissions" ADD CONSTRAINT "outbound_permissions_channel" FOREIGN KEY ("company_id","channel_id") REFERENCES "public"."outbound_channels"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_policies" ADD CONSTRAINT "outbound_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_policies" ADD CONSTRAINT "outbound_policies_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_policies" ADD CONSTRAINT "outbound_policies_channel" FOREIGN KEY ("company_id","channel_id") REFERENCES "public"."outbound_channels"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_review_receipts" ADD CONSTRAINT "outbound_review_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_review_receipts" ADD CONSTRAINT "outbound_review_receipts_check_id_model_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."model_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_review_receipts" ADD CONSTRAINT "outbound_review_receipts_message" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."outbound_messages"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_review_receipts" ADD CONSTRAINT "outbound_review_receipts_revision" FOREIGN KEY ("message_id","message_revision") REFERENCES "public"."outbound_message_revisions"("message_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_sampling_counters" ADD CONSTRAINT "outbound_sampling_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_sampling_counters" ADD CONSTRAINT "outbound_sampling_counters_channel" FOREIGN KEY ("company_id","channel_id") REFERENCES "public"."outbound_channels"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_classifications" ADD CONSTRAINT "support_classifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_classifications" ADD CONSTRAINT "support_classifications_ticket" FOREIGN KEY ("company_id","ticket_id","ticket_revision") REFERENCES "public"."support_tickets"("company_id","ticket_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_department" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_product" FOREIGN KEY ("company_id","product_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_contact" FOREIGN KEY ("company_id","contact_id") REFERENCES "public"."outbound_contacts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_check_certificates_one_active" ON "model_check_certificates" USING btree ("check_id") WHERE "model_check_certificates"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_attempts_one_of_message" ON "outbound_attempts" USING btree ("message_id") WHERE "outbound_attempts"."status" <> 'definitely_not_accepted';--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_attempts_one_of_account" ON "outbound_attempts" USING btree ("company_id","account_id") WHERE "outbound_attempts"."status" IN ('sending', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_bindings_one_author" ON "outbound_bindings" USING btree ("company_id","account_id") WHERE "outbound_bindings"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_bindings_one_account" ON "outbound_bindings" USING btree ("company_id","agent_id") WHERE "outbound_bindings"."status" = 'active';--> statement-breakpoint
CREATE INDEX "outbound_messages_due" ON "outbound_messages" USING btree ("scheduled_at") WHERE "outbound_messages"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "outbound_messages_task" ON "outbound_messages" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_permissions_active" ON "outbound_permissions" USING btree ("contact_id","channel_id","purpose") WHERE "outbound_permissions"."status" = 'granted';--> statement-breakpoint
-- What is frozen stays frozen whoever writes: revisions, bytes, approvals, receipts and generations (#403, sections 6 to 8).
CREATE FUNCTION outbound_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'this change to % is refused: what it holds is never changed or taken back', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_policies BEFORE UPDATE OR DELETE ON "outbound_policies" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_contact_events BEFORE UPDATE OR DELETE ON "outbound_contact_events" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_message_revisions BEFORE UPDATE OR DELETE ON "outbound_message_revisions" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_approvals BEFORE UPDATE OR DELETE ON "outbound_approvals" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_review_receipts BEFORE UPDATE OR DELETE ON "outbound_review_receipts" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_events BEFORE UPDATE OR DELETE ON "outbound_events" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_bindings_kept BEFORE DELETE ON "outbound_bindings" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_catalog_revisions_kept BEFORE DELETE ON "outbound_catalog_revisions" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_permissions_kept BEFORE DELETE ON "outbound_permissions" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_messages_kept BEFORE DELETE ON "outbound_messages" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_attempts_kept BEFORE DELETE ON "outbound_attempts" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_daily_usage_kept BEFORE DELETE ON "outbound_daily_usage" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_sampling_counters_kept BEFORE DELETE ON "outbound_sampling_counters" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_support_tickets_kept BEFORE DELETE ON "support_tickets" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_support_classifications_kept BEFORE DELETE ON "support_classifications" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_bindings_frozen BEFORE UPDATE OF company_id, account_id, agent_id, generation ON "outbound_bindings" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_catalog_revisions_frozen BEFORE UPDATE OF company_id, department_id, product_id, channel_id, entry_id, revision, kind, locale, value, digest, valid_from, valid_until, created_by_kind, created_by_id ON "outbound_catalog_revisions" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_contacts_frozen BEFORE UPDATE OF company_id, kind, address_hash ON "outbound_contacts" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_messages_frozen BEFORE UPDATE OF company_id, department_id, product_id, task_id, author_agent_id, author_job_id, idempotency_key, request_digest, channel_id, account_id, binding_generation, target_kind, contact_id, audience_entry_id, ticket_id, ticket_revision, classification_id, segment_id, sampling_ordinals ON "outbound_messages" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_attempts_frozen BEFORE UPDATE OF company_id, message_id, message_revision, account_id, binding_generation, config_generation, channel_generation, account_bucket_id, domain_bucket_id ON "outbound_attempts" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_daily_usage_frozen BEFORE UPDATE OF company_id, scope, scope_key, day, timezone, limit_version ON "outbound_daily_usage" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_support_tickets_frozen BEFORE UPDATE OF company_id, department_id, product_id, ticket_id, revision, contact_id, text_enc, digest ON "support_tickets" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_support_classifications_frozen BEFORE UPDATE OF company_id, ticket_id, ticket_revision, ticket_digest, binding_digest, idempotency_key ON "support_classifications" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_model_check_certificates_frozen BEFORE UPDATE OF check_id, binding_digest, report_id, evaluated_at, valid_until ON "model_check_certificates" FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_channels_one_way BEFORE UPDATE ON "outbound_channels" FOR EACH ROW WHEN (NEW.generation < OLD.generation) EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_accounts_one_way BEFORE UPDATE ON "outbound_accounts" FOR EACH ROW WHEN (NEW.config_generation < OLD.config_generation) EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_messages_one_way BEFORE UPDATE ON "outbound_messages" FOR EACH ROW WHEN (NEW.revision < OLD.revision) EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_contacts_one_way BEFORE UPDATE ON "outbound_contacts" FOR EACH ROW WHEN (OLD.do_not_contact AND NOT NEW.do_not_contact) EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_bindings_one_way BEFORE UPDATE ON "outbound_bindings" FOR EACH ROW WHEN (OLD.status = 'released') EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_catalog_revisions_one_way BEFORE UPDATE ON "outbound_catalog_revisions" FOR EACH ROW WHEN (OLD.status = 'revoked' OR (OLD.status = 'published' AND NEW.status = 'proposed') OR (OLD.published_by IS NOT NULL AND OLD.published_by IS DISTINCT FROM NEW.published_by)) EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_permissions_one_way BEFORE UPDATE ON "outbound_permissions" FOR EACH ROW WHEN (OLD.status = 'revoked') EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_attempts_one_way BEFORE UPDATE ON "outbound_attempts" FOR EACH ROW WHEN (OLD.status IN ('accepted', 'definitely_not_accepted')) EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_support_classifications_one_way BEFORE UPDATE ON "support_classifications" FOR EACH ROW WHEN (OLD.status <> 'pending') EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_model_check_certificates_one_way BEFORE UPDATE ON "model_check_certificates" FOR EACH ROW WHEN (OLD.status = 'invalidated') EXECUTE FUNCTION outbound_refuse_change();
--> statement-breakpoint
CREATE TRIGGER outbound_guard_outbound_sampling_counters_one_way BEFORE UPDATE ON "outbound_sampling_counters" FOR EACH ROW WHEN (NEW.next < OLD.next) EXECUTE FUNCTION outbound_refuse_change();
