CREATE TABLE "agent_fallbacks" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"home_subscription_id" uuid NOT NULL,
	"home_model" text NOT NULL,
	"home_effort" text,
	"subscription_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "fallbacks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_fallbacks" ADD CONSTRAINT "agent_fallbacks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_fallbacks" ADD CONSTRAINT "agent_fallbacks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_fallbacks" ADD CONSTRAINT "agent_fallbacks_home_subscription_id_subscriptions_id_fk" FOREIGN KEY ("home_subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_fallbacks" ADD CONSTRAINT "agent_fallbacks_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;