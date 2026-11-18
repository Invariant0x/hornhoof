# Retired staging batches

Historical migration note, not an available implementation.

The experimental staging components were removed. Migration
[`0095_drop_unused_workspace_and_staging.sql`](../apps/server/drizzle/0095_drop_unused_workspace_and_staging.sql)
drops their private tables and the unused workspace tables. There is no staging
publisher, node Git helper or agent staging command to enable in this release.

Current task submission and integration follow [Tasks and turns](../guide/tasks-and-turns.md).
The old component contracts remain available in this file's Git history; they do
not describe current modules, tables or supported configuration.
