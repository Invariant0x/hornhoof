ALTER TABLE "jobs" ADD COLUMN "quota_refusal" jsonb;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "quota_state" jsonb;