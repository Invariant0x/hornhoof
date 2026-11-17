# Employee history attribution, task 1220

Architecture only. Base: `task-1112` at `72c1a37423e03c79e49670bf4280379c326e5d30`.
This belongs to turn 32 and must never enter turn 31. The head's order is to save this plan, finish task 1119, then implement this task or resume when task 1112 is accepted. Refresh the accepted base before implementation; task 1112 is still under review.

## Storage and authorship

Add nullable `acting_agent_id` to `agent_changes`, referring to `agents.id`. Keep `person_id` as the person whose authority was used, including an ordinary human author. Existing rows remain unchanged with a null agent. Keep orchestrator and automatic records as they are.

Use an attribution helper dedicated to employee changes in `apps/server/src/auth/session.ts`. Derive the acting head only from the authenticated `Person.via` and `viaHead`, never request fields. Leave attribution of other journals unchanged. Use the helper for employee changes, reset, removal, hiring and removal of a department's teams. Extend the hire attribution type so it preserves the agent id rather than dropping it. Audit the remaining `agent_changes` writers and use the same mapping where a person or an internal caller supplies attribution; automatic writers stay unchanged.

## API and card

Join the acting agent through a separate table alias in the card query. Keep `personName` and `byOrchestrator`; add nullable `actingAgent: { id, name }`. The card formats a head as `Head Hana (authority: Dana)` and `глава Хана (права Даны)` through en/ru translation functions. Human, orchestrator and old rows keep their existing display. Reuse the current history list and tokens, with full wrapping for long names. Restore the truthful statement in `hh-head.md` only with the implementation.

## Migration and checks

Generate an additive migration and snapshot with Drizzle after taking the accepted task 1112 and the turn 32 migration journal. Tell the head the exact next number and paths before submission. Do not reserve 0130 from task 1112's old journal or change any shipped migration. Leave old rows untouched. Check a fresh database, upgrade with existing history, and repeat application. Old code can ignore the nullable column; down migrations are not supplied by this project.

RED first: the head's hire/change/reset/fire/team-removal records lack the acting agent on this base. GREEN must prove both agent and authority person, a department owner and CEO fallback, unchanged human/orchestrator attribution, and that input cannot choose the author. Check the employee card response and en/ru rendering, including an old row and a removed head.

Named local checks: `head-department-control.test.ts`, `agents.test.ts`, a focused `agent-changes-migration.test.ts`, `migrations.test.ts`, and web `AgentCard.test.tsx`. Add directly affected caller files found by the import graph. Run server/web types, test types, changed-file eslint, builds and the exact-commit author check. No full suite or `run_tests` on this branch. Check the card through named browser scenarios using the existing owner-screen setup, across three engines, narrow/wide widths, all shipped themes, measured longest/shortest locales and a shipped RTL locale when present.

## Paths for the head

- `docs/tasks/task-1220-plan.md`
- `apps/server/src/db/schema.ts`
- `apps/server/drizzle/0NNN_agent_change_actor.sql`
- `apps/server/drizzle/meta/0NNN_snapshot.json`
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
- `apps/web/e2e/agent-history.spec.ts`
- `apps/web/e2e/owner-screens.config.ts` if the existing selector must include the new scenario
- `templates/skills/hh-head.md`

Confirm the final numbered paths with the head before Development submission. Review and independent Security are mandatory, followed by Tests on the final exact candidate. Integration requires the head's authorization and targets turn 32 only.
