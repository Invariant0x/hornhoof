CREATE TABLE "feedback_submissions" (
	"key" text PRIMARY KEY NOT NULL,
	"repeats" integer,
	"sent" boolean DEFAULT false NOT NULL,
	"card_id" uuid
);
--> statement-breakpoint
CREATE TABLE "improvement_submissions" (
	"key" text PRIMARY KEY NOT NULL,
	"result" jsonb
);
--> statement-breakpoint
DROP INDEX "agent_events_message_sender_window";--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_card_id_feedback_inbox_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."feedback_inbox"("id") ON DELETE cascade ON UPDATE no action;