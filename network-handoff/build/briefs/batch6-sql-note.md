# This slice

The `sql-check.ts` part of Plan 3 Task 3, with its dependency `libpg-query` 17.7.3. Security class: two readers at once, each alone. This was split off ahead of the task; `confirm.ts`, `agent-sql.ts`, `client.ts`, `database.ts` and the texts stay for that task's own writer, and nothing calls `checkAgentSql` yet, so do not report those as missing. The writer's rulings are the lines starting `Plan 3 Task 3: Ruling` in `/home/altera/hornhoof-network/network-build/progress.md`; a ruling is a claim to check.

Read the code and the parser's tree as a reviewer: does any statement or function ruling 4 refuses get past the walk, and is any ordinary statement refused that the plan lets through. Use the parser locally if a question needs it. Nothing here goes near a real database or a live service.
