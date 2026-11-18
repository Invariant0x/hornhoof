-- Clear the old time windows and unanswered requests. Commands from those windows cannot run under standing access.
UPDATE "computer_runs" SET state = 'done', exit = 126, output = 'Computer access changed during the update. This command was not run.', done_at = now() WHERE state = 'waiting';--> statement-breakpoint
UPDATE "computer_runs" SET state = 'lost', done_at = now() WHERE state = 'sent';--> statement-breakpoint
DELETE FROM "machine_access";--> statement-breakpoint
ALTER TABLE "machine_access" DROP CONSTRAINT "machine_access_asked";--> statement-breakpoint
ALTER TABLE "machine_access" DROP CONSTRAINT "machine_access_opened_by_people_id_fk";
--> statement-breakpoint
ALTER TABLE "machine_access" ADD COLUMN "employees" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "computer_closed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_access" DROP COLUMN "until";--> statement-breakpoint
ALTER TABLE "machine_access" DROP COLUMN "asked_reason";--> statement-breakpoint
ALTER TABLE "machine_access" DROP COLUMN "asked_at";--> statement-breakpoint
ALTER TABLE "machine_access" DROP COLUMN "opened_by";--> statement-breakpoint
ALTER TABLE "machine_access" DROP COLUMN "opened_at";--> statement-breakpoint
ALTER TABLE "machine_access" DROP COLUMN "grant";
