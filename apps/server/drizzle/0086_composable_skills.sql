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
--> statement-breakpoint
-- Preserve pending staffing choices when retiring the role.
UPDATE "proposals" AS proposal
SET "items" = (
  SELECT jsonb_agg(
    CASE WHEN item->>'role' = 'DEV-GEN'
      THEN jsonb_set(item, '{role}', '"DEV-ENG"'::jsonb)
      ELSE item END
    ORDER BY ordinal
  )
  FROM jsonb_array_elements(proposal."items") WITH ORDINALITY AS entry(item, ordinal)
)
WHERE proposal."kind" = 'staff'
  AND proposal."status" = 'pending'
  AND jsonb_typeof(proposal."items") = 'array'
  AND proposal."items" @> '[{"role":"DEV-GEN"}]'::jsonb;
