CREATE TABLE "telegram_chat_languages" (
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"lang" text NOT NULL,
	CONSTRAINT "telegram_chat_languages_bot_id_chat_id_pk" PRIMARY KEY("bot_id","chat_id")
);
--> statement-breakpoint
ALTER TABLE "telegram_chat_languages" ADD CONSTRAINT "telegram_chat_languages_bot_id_telegram_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."telegram_bots"("id") ON DELETE cascade ON UPDATE no action;