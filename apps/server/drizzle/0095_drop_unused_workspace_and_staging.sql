ALTER TABLE "jobs" DROP CONSTRAINT "jobs_workspace_id_task_workspaces_id_fk";--> statement-breakpoint
DROP INDEX "jobs_workspace_id";--> statement-breakpoint
DROP TABLE "author_workspace_slots" CASCADE;--> statement-breakpoint
DROP TABLE "staging_batches" CASCADE;--> statement-breakpoint
DROP TABLE "staging_operations" CASCADE;--> statement-breakpoint
DROP TABLE "staging_plans" CASCADE;--> statement-breakpoint
DROP TABLE "staging_trials" CASCADE;--> statement-breakpoint
DROP TABLE "task_area_locks" CASCADE;--> statement-breakpoint
DROP TABLE "task_workspace_merge_receipts" CASCADE;--> statement-breakpoint
DROP TABLE "task_workspace_operations" CASCADE;--> statement-breakpoint
DROP TABLE "task_workspace_sessions" CASCADE;--> statement-breakpoint
DROP TABLE "task_workspace_submissions" CASCADE;--> statement-breakpoint
DROP TABLE "task_workspaces" CASCADE;--> statement-breakpoint
DROP TABLE "workspace_repositories" CASCADE;--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_assignment_epoch";--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_workspace_pair";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_assignment_epoch";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "assignment_epoch";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "workspace_spec_version";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "assignment_epoch";
