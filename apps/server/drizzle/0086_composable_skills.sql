-- Preserve saved abilities, personal text and run settings when retiring the role.
UPDATE "agents" SET "role_key" = 'DEV-ENG' WHERE "role_key" = 'DEV-GEN';
--> statement-breakpoint
-- Keep the abilities split out of the original company skill on existing cards.
UPDATE "agents" SET "skills" = "skills" || '["orch-staff"]'::jsonb
WHERE "skills" ? 'orch-company' AND NOT "skills" ? 'orch-staff';
--> statement-breakpoint
UPDATE "agents" SET "skills" = "skills" || '["orch-people"]'::jsonb
WHERE "skills" ? 'orch-company' AND NOT "skills" ? 'orch-people';
--> statement-breakpoint
UPDATE "agents" SET "skills" = "skills" || '["orch-resources"]'::jsonb
WHERE "skills" ? 'orch-company' AND NOT "skills" ? 'orch-resources';
