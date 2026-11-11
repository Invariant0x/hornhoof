-- The Telegram bots of heads and the orchestrator, the answers they carry back, and who each person is in Telegram.
CREATE TABLE "telegram_bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_enc" text NOT NULL,
	"bot_user_id" bigint NOT NULL,
	"username" text NOT NULL,
	"update_offset" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_bots_agent_id_unique" UNIQUE("agent_id"),
	CONSTRAINT "telegram_bots_bot_user_id_unique" UNIQUE("bot_user_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"after_seq" bigint NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"lang" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_replies_job_chat" UNIQUE("bot_id","job_id","chat_id")
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "telegram_username" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "telegram_user_id" bigint;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_replies" ADD CONSTRAINT "telegram_replies_bot_id_telegram_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."telegram_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_replies" ADD CONSTRAINT "telegram_replies_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "people_telegram_username" ON "people" USING btree ("telegram_username");--> statement-breakpoint
CREATE UNIQUE INDEX "people_telegram_user_id" ON "people" USING btree ("telegram_user_id");