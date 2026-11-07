-- The speed skill is on every role's list, and a card keeps a list of its own: every head and member gets it once. The orchestrator's skills come from code.
UPDATE "agents" SET "skills" = "skills" || '["hh-work-fast"]'::jsonb WHERE "kind" IN ('head', 'worker') AND NOT "skills" ? 'hh-work-fast';
