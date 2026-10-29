-- The central agent is called the orchestrator now; the CEO is the chief.
UPDATE "agents" SET "kind" = 'orchestrator' WHERE "kind" = 'chief';--> statement-breakpoint
UPDATE "agents" SET "name" = 'Orchestrator' WHERE "name" = 'Chief';--> statement-breakpoint
UPDATE "subscriptions" SET "label" = 'Orchestrator' WHERE "label" = 'Chief';--> statement-breakpoint
UPDATE "subscriptions" SET "target_kind" = 'orchestrator' WHERE "target_kind" = 'chief';
