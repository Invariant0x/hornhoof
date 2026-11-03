-- An earlier reconnect of a personal plan could leave the older subscription in waiting_machine with no agents, no
-- test runs on its node, and its node still in ready after the newer subscription of the same provider and owner in
-- the same company reached ready.
UPDATE "nodes" n SET "status" = 'needs_login'
WHERE n."status" = 'ready'
  AND (n."key_hash" IS NULL OR EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."id" = n."subscription_id" AND s."removed_at" IS NOT NULL));--> statement-breakpoint
UPDATE "subscriptions" s SET "lease_node_id" = NULL
WHERE s."kind" = 'personal' AND s."status" = 'waiting_machine'
  AND NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."subscription_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "jobs" j WHERE j."subscription_id" = s."id" AND j."agent_id" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "nodes" n INNER JOIN "test_parts" tp ON tp."node_id" = n."id" WHERE n."subscription_id" = s."id")
  AND EXISTS (SELECT 1 FROM "subscriptions" o WHERE o."company_id" = s."company_id" AND o."owner_person_id" = s."owner_person_id" AND o."provider" = s."provider" AND o."kind" = 'personal' AND o."removed_at" IS NULL AND o."status" = 'ready' AND (o."created_at", o."id") > (s."created_at", s."id"));--> statement-breakpoint
UPDATE "agents" SET "node_id" = NULL
WHERE "node_id" IN (
  SELECT n."id" FROM "nodes" n INNER JOIN "subscriptions" s ON s."id" = n."subscription_id"
  WHERE s."kind" = 'personal' AND s."status" = 'waiting_machine'
    AND NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."subscription_id" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "jobs" j WHERE j."subscription_id" = s."id" AND j."agent_id" IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM "nodes" nr INNER JOIN "test_parts" tp ON tp."node_id" = nr."id" WHERE nr."subscription_id" = s."id")
    AND EXISTS (SELECT 1 FROM "subscriptions" o WHERE o."company_id" = s."company_id" AND o."owner_person_id" = s."owner_person_id" AND o."provider" = s."provider" AND o."kind" = 'personal' AND o."removed_at" IS NULL AND o."status" = 'ready' AND (o."created_at", o."id") > (s."created_at", s."id"))
);--> statement-breakpoint
UPDATE "jobs" SET "node_id" = NULL
WHERE "node_id" IN (
  SELECT n."id" FROM "nodes" n INNER JOIN "subscriptions" s ON s."id" = n."subscription_id"
  WHERE s."kind" = 'personal' AND s."status" = 'waiting_machine'
    AND NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."subscription_id" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "jobs" j WHERE j."subscription_id" = s."id" AND j."agent_id" IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM "nodes" nr INNER JOIN "test_parts" tp ON tp."node_id" = nr."id" WHERE nr."subscription_id" = s."id")
    AND EXISTS (SELECT 1 FROM "subscriptions" o WHERE o."company_id" = s."company_id" AND o."owner_person_id" = s."owner_person_id" AND o."provider" = s."provider" AND o."kind" = 'personal' AND o."removed_at" IS NULL AND o."status" = 'ready' AND (o."created_at", o."id") > (s."created_at", s."id"))
);--> statement-breakpoint
DELETE FROM "plan_credentials"
WHERE "subscription_id" IN (
  SELECT s."id" FROM "subscriptions" s
  WHERE s."kind" = 'personal' AND s."status" = 'waiting_machine'
    AND NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."subscription_id" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "jobs" j WHERE j."subscription_id" = s."id" AND j."agent_id" IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM "nodes" n INNER JOIN "test_parts" tp ON tp."node_id" = n."id" WHERE n."subscription_id" = s."id")
    AND EXISTS (SELECT 1 FROM "subscriptions" o WHERE o."company_id" = s."company_id" AND o."owner_person_id" = s."owner_person_id" AND o."provider" = s."provider" AND o."kind" = 'personal' AND o."removed_at" IS NULL AND o."status" = 'ready' AND (o."created_at", o."id") > (s."created_at", s."id"))
);--> statement-breakpoint
DELETE FROM "jobs"
WHERE "agent_id" IS NULL AND "subscription_id" IN (
  SELECT s."id" FROM "subscriptions" s
  WHERE s."kind" = 'personal' AND s."status" = 'waiting_machine'
    AND NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."subscription_id" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "jobs" j WHERE j."subscription_id" = s."id" AND j."agent_id" IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM "nodes" n INNER JOIN "test_parts" tp ON tp."node_id" = n."id" WHERE n."subscription_id" = s."id")
    AND EXISTS (SELECT 1 FROM "subscriptions" o WHERE o."company_id" = s."company_id" AND o."owner_person_id" = s."owner_person_id" AND o."provider" = s."provider" AND o."kind" = 'personal' AND o."removed_at" IS NULL AND o."status" = 'ready' AND (o."created_at", o."id") > (s."created_at", s."id"))
);--> statement-breakpoint
DELETE FROM "nodes"
WHERE "subscription_id" IN (
  SELECT s."id" FROM "subscriptions" s
  WHERE s."kind" = 'personal' AND s."status" = 'waiting_machine'
    AND NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."subscription_id" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "jobs" j WHERE j."subscription_id" = s."id" AND j."agent_id" IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM "nodes" n INNER JOIN "test_parts" tp ON tp."node_id" = n."id" WHERE n."subscription_id" = s."id")
    AND EXISTS (SELECT 1 FROM "subscriptions" o WHERE o."company_id" = s."company_id" AND o."owner_person_id" = s."owner_person_id" AND o."provider" = s."provider" AND o."kind" = 'personal' AND o."removed_at" IS NULL AND o."status" = 'ready' AND (o."created_at", o."id") > (s."created_at", s."id"))
);--> statement-breakpoint
DELETE FROM "subscriptions" s
WHERE s."kind" = 'personal' AND s."status" = 'waiting_machine'
  AND NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."subscription_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "jobs" j WHERE j."subscription_id" = s."id" AND j."agent_id" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "nodes" n INNER JOIN "test_parts" tp ON tp."node_id" = n."id" WHERE n."subscription_id" = s."id")
  AND EXISTS (SELECT 1 FROM "subscriptions" o WHERE o."company_id" = s."company_id" AND o."owner_person_id" = s."owner_person_id" AND o."provider" = s."provider" AND o."kind" = 'personal' AND o."removed_at" IS NULL AND o."status" = 'ready' AND (o."created_at", o."id") > (s."created_at", s."id"));
