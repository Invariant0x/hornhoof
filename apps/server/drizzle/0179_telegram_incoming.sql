CREATE TABLE "telegram_incoming" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"update_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"payload_enc" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_incoming_update" UNIQUE("bot_id","update_id")
);
--> statement-breakpoint
ALTER TABLE "telegram_incoming" ADD CONSTRAINT "telegram_incoming_bot_id_telegram_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."telegram_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_incoming_chat_order" ON "telegram_incoming" USING btree ("bot_id","chat_id","update_id");