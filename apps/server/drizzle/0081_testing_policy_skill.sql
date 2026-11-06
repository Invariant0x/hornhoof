-- The testing policy and the gate's part of a security review moved into skills of their own; cards that had their text keep it.
UPDATE "agents" SET "skills" = "skills" || '["dev-testing-policy"]'::jsonb WHERE "skills" ? 'dev-engineering-rules' AND NOT "skills" ? 'dev-testing-policy';--> statement-breakpoint
UPDATE "agents" SET "skills" = "skills" || '["dev-review-verdict"]'::jsonb WHERE "skills" ? 'dev-security-review' AND NOT "skills" ? 'dev-review-verdict';
