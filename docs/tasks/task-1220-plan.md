# Employee history attribution, task 1220

Implementation base: `task-1112` at `76c4b7d571aba37c5eefd12cac4eeee4945c01e5`.
This belongs to turn 32 and must never enter turn 31. The head explicitly authorized implementation from this checked base. Take later changes of task 1112 into this branch if it moves. Review, independent Security and Tests precede integration by the head.

## Storage and authorship

Add nullable `acting_agent_id` to `agent_changes`, referring to `agents.id`. Keep `person_id` as the person whose authority was used, including an ordinary human author. Existing rows remain unchanged with a null agent. Keep orchestrator and automatic records as they are.

Use an attribution helper dedicated to employee changes in `apps/server/src/auth/session.ts`. Derive the acting head only from the authenticated `Person.via` and `viaHead`, never request fields. Leave attribution of other journals unchanged. Use the helper for employee changes, reset, removal, hiring and removal of a department's teams. Extend the hire attribution type so it preserves the agent id rather than dropping it. Audit the remaining `agent_changes` writers and use the same mapping where a person or an internal caller supplies attribution; automatic writers stay unchanged.

## API and card

Join the acting agent through a separate table alias in the card query. Keep `personName` and `byOrchestrator`; add nullable `actingAgent: { id, name }`. The card formats a head as `Head Hana (authority: Dana)` and `глава Хана (права Даны)` through en/ru translation functions. Human, orchestrator and old rows keep their existing display. Reuse the current history list and tokens, with full wrapping for long names. Restore the truthful statement in `hh-head.md` only with the implementation.

## Migration and checks

Generated the additive migration and snapshot with Drizzle. The head reserved `0139_agent_change_actor`: 0137 belongs to task 1077 and 0138 to task 1119. Its journal time, 1794902232536, is strictly after 0138's 1794891391437. The snapshot follows 0136 in this base; the head will link it to 0138 when integrating the three changes. No existing migration or row is changed. Check a fresh database, upgrade with existing history, and repeat application. Old code can ignore the nullable column; down migrations are not supplied by this project.

RED first: the head's hire/change/reset/fire/team-removal records lack the acting agent on this base. GREEN must prove both agent and authority person, a department owner and CEO fallback, unchanged human/orchestrator attribution, and that input cannot choose the author. Check the employee card response and en/ru rendering, including an old row and a removed head.

Named local checks: `head-department-control.test.ts`, `agents.test.ts`, a focused `agent-changes-migration.test.ts`, `migrations.test.ts`, and web `AgentCard.test.tsx`. Add directly affected caller files found by the import graph. Run server/web types, test types, changed-file eslint, builds and the exact-commit author check. No full suite or `run_tests` on this branch. Check the card through named browser scenarios using the existing owner-screen setup, across three engines, narrow/wide widths, all shipped themes, measured longest/shortest locales and a shipped RTL locale when present.

## Paths for the head

- `docs/tasks/task-1220-plan.md`
- `apps/server/src/db/schema.ts`
- `apps/server/drizzle/0139_agent_change_actor.sql`
- `apps/server/drizzle/meta/0139_snapshot.json`
- `apps/server/drizzle/meta/_journal.json`
- `apps/server/src/auth/session.ts`
- `apps/server/src/modules/agents/routes.ts`
- `apps/server/src/modules/departments/hire.ts`
- `apps/server/src/modules/departments/routes.ts`
- `apps/server/src/modules/assistants/setup.ts`
- `apps/server/src/modules/people/routes.ts`
- `apps/server/src/modules/telegram/routes.ts`
- `apps/server/test/head-department-control.test.ts`
- `apps/server/test/agents.test.ts`
- `apps/server/test/agent-changes-migration.test.ts`
- `apps/web/src/types.ts`
- `apps/web/src/ui/AgentCard.tsx`
- `apps/web/src/i18n/en.ts`
- `apps/web/src/i18n/ru.ts`
- `apps/web/test/AgentCard.test.tsx`
- `apps/web/test/api-mock.ts`
- `apps/web/e2e/agent-history.spec.ts`
- `apps/web/e2e/agent-history.config.ts`
- `templates/skills/hh-head.md`

The head added all 24 paths to the task before submission. Review and independent Security are mandatory, followed by Tests on the final exact candidate. Integration requires the head's authorization and targets turn 32 only.
