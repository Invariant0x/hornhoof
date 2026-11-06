-- Text moved between skills, and a card holds a list of its own: a card keeps what it could read. The policy comes last, as the skills added before it point to it.
UPDATE "agents" SET "skills" = "skills" || '["dev-review-verdict"]'::jsonb WHERE "skills" ?| array['dev-security-review', 'dev-review-diff'] AND NOT "skills" ? 'dev-review-verdict';--> statement-breakpoint
UPDATE "agents" SET "skills" = "skills" || '["dev-tdd"]'::jsonb WHERE "skills" ? 'dev-implement' AND NOT "skills" ? 'dev-tdd';--> statement-breakpoint
UPDATE "agents" SET "skills" = "skills" || '["dev-browser-check"]'::jsonb WHERE "skills" ? 'dev-frontend-ui' AND NOT "skills" ? 'dev-browser-check';--> statement-breakpoint
UPDATE "agents" SET "skills" = "skills" || '["dev-ci-release"]'::jsonb WHERE "skills" ? 'dev-work-pipeline' AND NOT "skills" ? 'dev-ci-release';--> statement-breakpoint
UPDATE "agents" SET "skills" = "skills" || '["dev-testing-policy"]'::jsonb WHERE "skills" ?| array['dev-engineering-rules', 'dev-gates', 'dev-implement', 'dev-language-rules', 'dev-browser-check', 'dev-e2e-tests', 'dev-migrations', 'dev-review-diff', 'dev-review-verdict', 'dev-work-pipeline'] AND NOT "skills" ? 'dev-testing-policy';
