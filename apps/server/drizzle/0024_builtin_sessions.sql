-- The built-in node now gives each agent of a company key a home of its own, so the sessions those agents had stay in
-- the key's old home. Their next turn starts a new session that catches up from the conversation instead.
UPDATE "jobs" SET "session_id" = NULL WHERE "session_id" IS NOT NULL AND "subscription_id" IN (SELECT "id" FROM "subscriptions" WHERE "kind" = 'api_key');
