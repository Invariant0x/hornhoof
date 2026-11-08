ALTER TABLE "tasks" DROP CONSTRAINT "tasks_review_has_executor";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_gates_lists";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_counts";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "gates";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "panel";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "stage";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "merging";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "bounces";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_counts" CHECK ("tasks"."silent" >= 0);