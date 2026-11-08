# Unified Development Echelons Implementation Plan

> **For agentic workers:** Use `executing-plans` inline. Task #719 requires one author for every implementation part. Do not delegate implementation or start another implementation branch. The task's remote affected-check and independent final-review rules override generic skill suite and review instructions.

**Goal:** Replace the old Development gate/author-return workflow with one forward route, including its task engine, map, templates and applicable test execution.

**Architecture:** Store one required route record per task, with one current owner and an ordered stage history. Keep candidate and finding provenance in immutable task events. Pure transition/model/metric functions sit behind one authorized transactional command handler consumed by tools and HTTP.

**Tech Stack:** TypeScript, Zod, Drizzle/PostgreSQL, Fastify/MCP, Solid web components, Vitest and Playwright.

**Spec:** Current Hornhoof task #719, CEO instructions 200/201. The older `docs/superpowers/specs/2026-11-08-development-echelons.md` is source material only; its compatibility, opt-in and strict pair policies are superseded.

## Global Constraints

- One author, one working branch `task-717`, one isolated worktree. No parallel builders or implementation subagents.
- Original report base is `e0d362be11294e0df9a7ef5036389283bffa030b`. Integration base after David's current main is `e54dd0e55d5972693afc9dd84ca47f53919a70e7`.
- No `echelonsEnabled`, opt-in, nullable second route, author returns or compatibility implementation.
- No automated old-record conversion before 1.0. Generate schema normally for fresh installation; record exact manual release data work separately. Never change the live database.
- Different underlying providers and a reviewer not weaker than the producer; Codex production requires Claude review. Equal capability is allowed. Unknown capability blocks assignment.
- Review is mandatory for executable work. Security is mandatory for declared sensitive risk and can be added by Review. Coordination groups aggregate child results without inventing code candidates or a second legacy engine.
- Every change has a test written first. Author checks use `run_tests`, on exact pushed SHAs, with explicit selection; no local installs/builds/types/lint/tests or full-product author suite.
- Existing receipts prove their original inputs only. Formatter, producer quality, comparator and browser readiness gaps remain explicit.
- English repository text, no em dash; user-visible text in English and Russian. Commits by Ivan Korol, without trailers.
- Independent review/security and final #729 follow author submission. No main, publication, version change, live model or subscription change. Operations #725-728 are untouched.

## Material Inventory

| Source | State and use |
| --- | --- |
| #723 `60f60d43dae4891c99bfd954b2580b27dc239db3` | Already included; selection/fingerprint/pure mutation support, original GREEN 1457/1458. |
| #718 `f28e32b2c4104ab617ce130040b30a1baf24eed6` | Already included design material; replace superseded compatibility/model sections. |
| #720 `554800a0c6ce0170e81d47dac92a7751abaf279b` | Saved material. RED 1471 asserts the now-cancelled nullable contract; do not import that test. |
| Former #719 worktree | Quiescent at the same #720 commit; clean, no uncommitted files. |
| #721 `f6757bad7f9a816dc36192585313e2a640bca884` | Clean material: useful stage components and tests, unfinished canvas/metrics, browser and coverage gaps. Adapt, do not merge blindly. |
| #722 `b584fc51d52fa2b2afdc9230059936e92d72485a` | Clean material: standalone repair skills and short roles. Remove old-path/model assumptions before use. |

## Review Focus

- A duplicate completion after a response loss must return the same event/result and never create two owners.
- A reviewer changing its model, plan, provider or path scope cannot complete using an old assignment.
- An identical SHA on a different task/branch/candidate cannot borrow another task's test receipt.
- An existing database lacking route records must require the documented manual release work, never execute an old path or invent historical attestations.
- Hidden or idle map entries must not expose another task's owner, candidate or findings, or invent activity from a role name.

## Increment 1: Required route and public acceptance frontier

**Files:** `apps/server/test/development-echelons-route.test.ts`, `packages/protocol/src/echelons.ts`, protocol exports/tests, `apps/server/src/db/schema.ts`, generated schema artifacts, `modules/tasks/echelons-store.ts`, `engine.ts`, `views.ts`.

**Interfaces:** `EchelonsSnapshot` is a required public snapshot with ordered stages, current owner, phase, revision, candidate ID and security reason. `task_routes` holds one route for each task; missing historical records are invalid data requiring manual release correction, not an alternate workflow. `createTask` inserts task and route atomically.

- [ ] Write real engine/view tests: small work starts at Development with Review pending, including the existing Development template; omitted gates cannot bypass Review.
- [ ] Push, print `check:author --sha HEAD --base e54dd0e5...`, execute its exact plan through `run_tests`; expect missing-route/mandatory-Review assertions, not import/setup errors.
- [ ] Add required protocol/schema/store and task creation/read projection. Delete old gate/panel/stage/bounce/merge fields and their replaced consumers; update relevant fixture contracts.
- [ ] Generate schema through the project Drizzle tool remotely. Schema DDL only, no old-row updates or route backfill.
- [ ] Run affected acceptance/schema/type checks remotely; commit the proved increment.

## Increment 2: Assignment, forward transitions and fixes

**Files:** `modules/tasks/echelons-policy.ts`, `echelons-assign.ts`, `echelons-commands.ts`, `echelons-candidates.ts`, `engine.ts`, `tools.ts`, `routes.ts`, scope/permission/race tests.

**Interfaces:** `reviewEligibility(producer, checker)` compares trusted capability bands and normalized providers; no pair whitelist or strictly-greater requirement. `moveEchelon(ctx, actor, task, command)` consumes expected task version, route revision, candidate ID and idempotency key, and owns the sole transactional completion path.

- [ ] Write RED tests for equal-capability cross-provider acceptance; same-provider, weaker, unknown capability and non-Claude-after-Codex refusal.
- [ ] Write RED tests for Review/Security retaining their own fixes, final candidate parent/producer provenance, wrong-goal escalation, optional Security insertion, and no author wake.
- [ ] Implement trusted capability resolution, capability-based stage selection, path leases, immutable candidates and CAS/idempotent handoff.
- [ ] Remove panel fan-out, author-return, old turn review/fix loops and unused entities/tests. Preserve unrelated task comments, dependencies, requests and group aggregation through the new engine.
- [ ] Prove stale owner/model, cross-company/path and duplicate-completion cases; prove independent A/Review and B/Development overlap. Run affected checks and commit.

## Increment 3: Exact candidate Tests and source-backed findings

**Files:** `modules/tasks/echelons-evidence.ts`, `echelons-findings.ts`, applicable `review-*` consumers, test-run boundary files, `scripts/author-check/**`, `scripts/mutation/**`, test wiring where required.

**Interfaces:** Tests accepts only `{candidateId, routeRevision, baseCommit, commit, branch}` with verified completed parts or verified reuse at the same influencing fingerprint. Finding projections count unique server finding/event identities by Review/Security and keep fixes separate from confirmations.

- [ ] Write RED tests for stale author receipts after a fix, wrong branch/task/revision, zero/malformed results and duplicate finding ingestion.
- [ ] Wire existing selection/fingerprint and narrow pure-function mutation ports into final-candidate acceptance; preserve applicable check failures and unavailable evidence.
- [ ] Verify selection separately from execution, exact final SHA including fixes, changed tests and influencing conditions. DB/process/network/unknown purity is not mutated.
- [ ] Prove Tests content failure escalates to the head and infrastructure failure stays retryable at Tests; Tests cannot edit the candidate.
- [ ] Run affected checks and commit.

## Increment 4: Actual map, task UI and standalone template abilities

**Files:** organization/task/tree projections, relevant `apps/web/src` task/map components, both dictionaries, adapted #721 tests, `templates/**`, loader/tests and guides.

**Interfaces:** Task/detail/list/org all carry the same required route snapshot; `EchelonFindingsView` is derived from visible events. Stage labels are literally Architecture, Development, Review, Security and Tests in every locale. Any capable assigned agent can check/fix; no new special role exists.

- [ ] Adapt material tests into RED for actual stage owners, skips/added Security, live refresh, finding provenance and no old author-return display. Remove cancelled null/disabled cases and invalid test helper options.
- [ ] Implement UI on the existing design system; integrate only the useful portions of the saved material. Resolve the known empty-coverage seam and fixture 404 causes.
- [ ] Adapt standalone Review/Security check-and-fix skills and short roles for the sole new route. Remove cancelled old-path text and inventory assumptions.
- [ ] Run affected unit/type/language/browser checks remotely. Verify longest/shortest shipped locales, narrow/desktop, light/dark and applicable browser engines. Missing readiness is not PASS.
- [ ] Commit the proved increment.

## Increment 5: Clean-install proof and release data handoff

**Files:** fresh-schema tests, `.hornhoof/test-environment.json` and wiring only where the new route needs them, `docs/development-echelons-release-data.md`, updated task guide/spec.

- [ ] Prove fresh schema installation and that no schema change translates old tasks or assigns existing staff/models.
- [ ] Record manual release order: capture old fields before replaced schema fields disappear, create required route records and ownership/scope/model metadata for affected rows, keep historical events truthful, verify constraints before enabling work.
- [ ] Identify each affected table/field, selection condition and expected result. Do not implement or run a bulk converter or fabricate decision events.
- [ ] Finish affected author checks on the exact final SHA; report source receipts and new receipts distinctly. Do not start #729 or independent review before submission.
- [ ] Submit #719 with one final `task-717` SHA, original base, implemented/deleted behavior, all RED/GREEN IDs, limits and the manual data checklist. David owns main and release.

## Execution Rulings

- The current task replaces the earlier approved note wherever they disagree. No compatibility code or cancelled nullable test is carried forward.
- Route records are separate required records rather than a nullable task switch. Fresh installation creates them through normal application writes; existing records are repaired manually at release.
- Capability comparison uses trusted product policy bands, permits equality and fails closed for unknown identity/capability. It is an assignment policy, not a claimed benchmark result or role/effort inference.
- Coordination groups aggregate child outcomes and do not invent source-code candidates. Executable work always has Review; this distinction is task structure, not a legacy/opt-in route.
- Skill bookkeeping never runs local project checks. Record actual remote receipts in the execution ledger instead of invoking local `task-done` test scripts.
