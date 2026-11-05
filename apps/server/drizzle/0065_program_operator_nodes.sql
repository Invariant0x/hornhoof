-- A program operator stands on no machine until its first turn, and without a machine it was never called, so it never got
-- that turn. Each one with a plan that has a live machine goes on the oldest of them. Its next turn still moves to whichever
-- machine of the plan can take it. Other agents keep getting theirs at their first turn, spread by how free the machines are.
UPDATE "agents" AS operator
SET "node_id" = (
  SELECT node."id" FROM "nodes" AS node
  WHERE node."subscription_id" = operator."subscription_id" AND node."company_id" = operator."company_id" AND node."key_hash" IS NOT NULL
  ORDER BY node."created_at", node."id"
  LIMIT 1
)
WHERE operator."role_key" = 'OPS-PROGRAM'
  AND operator."node_id" IS NULL
  AND operator."removed_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "subscriptions" AS plan
    WHERE plan."id" = operator."subscription_id" AND plan."company_id" = operator."company_id" AND plan."kind" = 'personal' AND plan."removed_at" IS NULL
  );
