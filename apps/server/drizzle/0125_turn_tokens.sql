CREATE TABLE "turn_tokens" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"subscription_id" uuid NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cache_read_tokens" bigint,
	"cache_write_tokens" bigint,
	"total_tokens" bigint,
	"model" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "turn_tokens_counts" CHECK (coalesce("turn_tokens"."input_tokens", 0) >= 0 and coalesce("turn_tokens"."output_tokens", 0) >= 0 and coalesce("turn_tokens"."cache_read_tokens", 0) >= 0 and coalesce("turn_tokens"."cache_write_tokens", 0) >= 0 and coalesce("turn_tokens"."total_tokens", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "api_protocol" text;--> statement-breakpoint
ALTER TABLE "turn_tokens" ADD CONSTRAINT "turn_tokens_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_tokens" ADD CONSTRAINT "turn_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_tokens" ADD CONSTRAINT "turn_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_tokens" ADD CONSTRAINT "turn_tokens_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_tokens_subscription_at" ON "turn_tokens" USING btree ("subscription_id","at");--> statement-breakpoint
CREATE INDEX "turn_tokens_company_at" ON "turn_tokens" USING btree ("company_id","at");