# Composable Skills Implementation Plan

This plan records the implementation units. The current task body controls execution and handoff.

**Goal:** Ship standalone abilities, short role identities and separate assignments across all departments, with preserved permissions and saved selections.

**Architecture:** Keep the existing template catalog and Part/SkillFile delivery. Move procedures out of roles, inline each ability's prerequisites and make workflow follow task gates and employee assignment. Retire DEV-GEN without resetting employees; reuse existing personal base storage as the assignment.

**Tech Stack:** TypeScript, Fastify, React, PostgreSQL/Drizzle, Markdown/YAML templates and Vitest.

**Spec:** `docs/superpowers/specs/2026-11-07-composable-skills-design.md`.

## Global Constraints

- Branch task-707-lego starts on released main f2bf36658b7e7b67f7f13fffff3bcb022f66fdb3 (0.8.1), outside planned turns. The release owner owns final integration and release. Do not change live cards/models.
- Personal features 6a: the implementer chooses the concrete proposal as the requested deliverable. No new storage/API/UI/self-write implementation is included and no scope question is pending.
- English template bodies, bilingual metadata, no em dashes; preserve sources and tool grants.
- Independent Security before shared merge for sensitive access/root/permissions/secrets remains mandatory.
- Remote affected checks on exact commits only; full final run belongs to its designated owner.

## Review Focus

- A legacy assignment must not hide the new role identity or disappear during a template reset/retirement.
- Cross-department skill combinations must not impose conflicting role duties or downstream gates.
- A head cannot use assignment editing to change another department, the orchestrator, a peer/head, model or permissions.
- Removing DEV-GEN must preserve custom selected skills, bodies, effort, timer and provider on saved cards.
- Public/support replies, financial actions, physical actions and sensitive code must retain their explicit authorization conditions after inlining.

## Task 1: Template contracts and bounded domain rewrites

**Files:** `templates/skills/*.md`, `templates/roles/*/*.md`, `templates/SOURCES.md`, `apps/server/test/templates.test.ts`, new `apps/server/test/composable-skills.test.ts`.

**Interfaces:** Existing `loadTemplates(dir): Templates`, `renderInstructions(templates, agent, place): Rendered`; no new tool grants. Skill bodies are independent of other skill selections.

- [ ] Add failing tests: all skill bodies have no other local skill IDs; all role bodies are a single identity sentence; no DEV-GEN entry; arbitrary single-ability selections render their complete method and safeguards.
- [ ] Run those tests through run_tests with an exact SHA guard and read the full RED log before editing templates.
- [ ] Rewrite common/orchestrator and domain groups with one writer per file group. Preserve each concrete domain safeguard, move role behavior into its appropriate ability, and make unconditional pipeline obligations conditional on task/assignment.
- [ ] Replace obsolete role-workflow/reference expectations with semantic skill and assembled-instruction checks, retaining the named safety behaviors and negative cases.
- [ ] Run affected template/instruction tests remotely, read logs, fix regressions and commit.

## Task 2: Separate assignment from role identity

**Files:** `apps/server/src/modules/agents/instructions.ts`, `routes.ts`, `apps/server/src/modules/tools/control.ts`, `mcp.ts`, `apps/web/src/ui/AgentCard.tsx`, `apps/web/src/types.ts`, EN/RU dictionaries; tests `instructions.test.ts`, `agents.test.ts`, `orchestrator-control.test.ts`, `tools.test.ts`, web `AgentCard.test.tsx`.

**Interfaces:** Add an assignment Part to the existing `Part` union; its text comes from existing `AgentOverrides.base`. Keep immutable role identity separate. Add assignment-only head editing bound to authenticated company/department identity, without changing the general employee-update authority.

- [ ] Add failing rendering tests for an existing custom base plus a short role identity, and card/raw round-trip tests.
- [ ] Add assignment ACL tests: same-department worker permitted; other company/department, head/orchestrator target and unrelated PATCH fields refused.
- [ ] Run RED remotely; implement normal Part/card composition and assignment-only command using existing persistence/history.
- [ ] Run affected server/web tests remotely, then browser checks for the touched card on an isolated fixture/stand using shipped locales, widths and themes. No live Tree/Speed.
- [ ] Read logs and commit; preserve legacy text byte-for-byte.

## Task 3: Retire generalist role and preserve saved cards

**Files:** New generated forward migration after current migration history, Drizzle journal/snapshot, `apps/server/test/migrations.test.ts`, any changed active role lookup/hiring tests.

**Interfaces:** Persisted role_key DEV-GEN becomes DEV-ENG; skills/overrides/templateHashes/effort/timer/model remain unchanged. Any actual skill-ID retirement additionally migrates selected IDs and keyed custom data without silent overwrite.

- [ ] Write migration regression fixtures with a DEV-GEN card carrying custom selected skills, overrides, effort, timer and model; assert no values are dropped.
- [ ] Run RED remotely, generate the custom migration through remote tooling, then add the minimal data migration and any required collision handling.
- [ ] Run affected migration/hiring tests remotely and read logs; explicitly record unsupported down migration and rollback compatibility.
- [ ] Commit the migration, keeping all already deployed migration files unchanged.

## Task 4: Release ability, Matrix preparation and final handoff

**Files:** Relevant standalone release/rollback/check abilities, `templates/SOURCES.md`, tests for their delivered safeguards, and `docs/` Matrix skill/assignment proposal.

**Interfaces:** A release ability works for any authorized employee that has it; role identity does not select the release route. Named Matrix cards are only a proposed configuration, never live writes.

- [ ] Add RED tests for version/notes/live-node/exact-approval/merge/publication conditions and for absence of fixed downstream role handoffs.
- [ ] Implement the release ability and migrate selections if an ID changes; run GREEN remotely and read logs.
- [ ] Prepare the five developers' skill sets and assignment text with provenance and no live card/model changes.
- [ ] Record the concrete 6a proposal, including card placement, permissions, self-append and normal SkillFile delivery, with future implementation stated explicitly.
- [ ] Integrate the preserved work with released main, run affected checks on the final exact candidate and report counts, migration behavior and evidence.
- [ ] Obtain an independent subagent review at maximum effort, resolve blockers and submit the branch/SHA and current RED/GREEN evidence through the normal task route. No main merge or release by the implementer.
