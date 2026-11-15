-- The log of what was set up for a department's messages and by whom: a person, or the department's head carrying out
-- that person's word. It holds no setting, address or secret, only what changed and the ids it changed.
CREATE TABLE "outbound_setup_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"channel_id" uuid,
	"kind" text NOT NULL,
	"subject_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"person_id" uuid NOT NULL,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_setup_events_kind" CHECK ("outbound_setup_events"."kind" IN ('channel_created', 'policy_set', 'auto_send_on', 'auto_send_off', 'channel_stopped', 'channel_reopened', 'catalog_published', 'catalog_revoked', 'account_set_up', 'account_rotated', 'account_revoked', 'account_bound', 'account_released'))
);
--> statement-breakpoint
ALTER TABLE "outbound_setup_events" ADD CONSTRAINT "outbound_setup_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_setup_events" ADD CONSTRAINT "outbound_setup_events_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_setup_events" ADD CONSTRAINT "outbound_setup_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_setup_events" ADD CONSTRAINT "outbound_setup_events_place" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_setup_events" ADD CONSTRAINT "outbound_setup_events_channel" FOREIGN KEY ("company_id","channel_id") REFERENCES "public"."outbound_channels"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_setup_events_department" ON "outbound_setup_events" USING btree ("company_id","department_id","created_at");