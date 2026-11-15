# Review provenance implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Pin each review, distribute large changes by task, and count only explicitly confirmed findings.

**Architecture:** Existing task event JSON holds immutable review revisions, sources and confirmations. Server readers resolve commits before transactions. Small review modules own parsing and policy; the task engine retains its CAS and single turn review. No database or protocol migration is needed (schema owner confirmed in task 460).

**Tech Stack:** TypeScript, Zod, Drizzle, PGlite and Vitest.

**Spec:** Hornhoof tasks 460 and 310, including the head's authority contract in task 460 on 2026-11-05.

## Global Constraints

- Work on task-460 from turn-8; the repository's author, no trailers; main is untouched.
- Targeted checks only; no full suite or release workflow. The head's later CEO decision requires every new T2 command through run_tests on a compatible platform-selected machine. Earlier local evidence keeps its actual origin; collect an already started background run, with no local fallback.
- Exact lowercase 40-character reviewed/fix SHA; repository outages are explicit degraded results.
- A turn review has one round. Only the original reviewer checks fixes for its own blocking security/data/spec finding. Medium comes from the existing effort policy.
- Threshold 800 changed lines is an initial configuration, not a measured optimum. No speed improvement is claimed without a measurement.
- Confirmed does not mean fixed or passed. Legacy numeric findings never become confirmed facts.

## Review Focus

- A branch moves while a review is running: retain the reviewed revision and reject evidence for another SHA.
- Two authors edit the same file: keep separate task ranges and author eligibility; do not merge ownership by directory.
- A reviewer loses access or an author changes: do not confirm or silently replace the original reviewer.
- Two concurrent confirmations or verdicts: one transition and one counted finding, with immutable history.
- Missing compare/run/provider data: explicit degraded/missing state, never fabricated zero findings or a self pass.

### Task 1: Pinned review and author evidence

**Files:** new `apps/server/src/modules/tasks/review-context.ts`; modify engine.ts, tools.ts and wake.ts; test `apps/server/test/review-provenance.test.ts`.

**Interfaces:** `captureReview(ctx, task)` returns a parsed event-local revision with `commit`, branch, author identity, verified run IDs/commits/part counts, and gate counts. `reviewContext(db, task)` reads the immutable revision, including after the branch advances. Repository calls happen before `move` opens a transaction.

- [ ] Write engine tests for pinned SHA, run identity/SHA matching, stale verdict rejection and immutable context after branch movement.
- [ ] Run `npx --no-install vitest run test/review-provenance.test.ts --root apps/server --maxWorkers=1`; expect assertion failures for absent context/stale acceptance.
- [ ] Implement capture, event storage, task tool delivery and verdict binding. Missing repositories produce explicit unavailable state; no remote error text is stored.
- [ ] Run the new file and test-evidence/tasks-engine tests; expect all pass. Commit the increment.

### Task 2: Vertical review assignments

**Files:** new review-plan.ts; reuse existing CompareReader and modify engine.ts; test review-plan.test.ts and tasks-turn-review.test.ts.

**Interfaces:** optional submit `review: { baseCommit }` records the source range resolved by the server. `planReview(slices, candidates, changedLines, contracts)` returns per-task assignments, an integration reviewer and explicit degraded reasons. Each assignment retains its own range even when paths overlap.

- [ ] Write cases for 800/801 lines, overlapping paths, provider aliases, shared contracts, missing independent providers and incomplete source inventories.
- [ ] Run targeted planner/turn tests; expect missing plan assertions to fail.
- [ ] Implement source comparison before transactions, immutable assignments in the turn review's created event, provider exclusions and common contract delivery. Keep all role gates and one turn review.
- [ ] Run planner/turn/gate compare tests; expect all pass. Commit the increment.

### Task 3: Findings, conditional fixes and explicit confirmations

**Files:** new review-findings.ts; modify engine.ts, tools.ts, wake-state.ts; tests review-findings.test.ts and review-provenance.test.ts.

**Interfaces:** verdict issues carry category/blocking/path/line/harm/task area; server adds finding ID, reviewer/vendor, revision and reviewed SHA. `confirm_finding` accepts an existing finding/revision, confirmed flag, reason and optional fix SHA. Server derives actor rights. Histories are append only, counters derive from the latest authorized confirmation per finding. A repeat carries `again: true` only for eligible original findings and the exact reviewed..fix range; it uses existing effort selection.

- [ ] Write cases for eligible repeat categories, own finding scope, unchanged paths, explicit confirmation rights, stale fix/revision/owner rejection, races, revocation and legacy exclusion.
- [ ] Run these tests; expect absent structured finding/repeat/confirmation behavior to fail.
- [ ] Implement input parsing, scoped findings, confirmation CAS/history and vendor counters. Noneligible task gate fixes advance through author proof without a fresh review; turn reviews never reopen.
- [ ] Run all affected tests plus server types, test types, ESLint, crapper and dryer. Expect zero failures; document legacy metrics and missing formatter separately.
- [ ] Commit, request one independent branch review, fix blocking findings once with RED/GREEN, push and merge into fresh turn-8 without force. Submit exact commits and evidence.

## Head addenda implemented during Task 3

- Explicit confirmations use immutable finding/revision/area provenance; author/head rights come from current server records. Confirmation is separate from fixed/PASS and retains revocation history.
- Mechanical changes use server `Wake.mechanical` only for entirely structural mechanical failed verdicts. State retains that flag; task 459 owns its effort consumer. `Wake.again` is explicit and only a qualifying original reviewer fix produces it.
- Run receipts, quality numbers and review lifecycle counters are separate. Producer 325 owns executing checks. The strict backend writer/reader port and unavailable behavior are documented in `docs/author-check-port.md`; real producer integration and three actual submissions belong to 325/331.
- Tests cover source task scope, foreign quality provenance, missing stages/coverage, CRAP threshold and a changed newer receipt refusing fallback to an older PASS.

## Consolidated fix pass after independent review

- Submission events own all fix restrictions. One reviewer's verdict cannot hide another's restriction. Automatic gate changes retain pending original reviewers and explicit repeat wakes; an unavailable original blocks the gate, including after another original passed.
- Both author and head confirmations validate current area ownership under the task lock. The head explicitly permits historical existence confirmation when the original reviewer is off or removed; its stored vendor stays unchanged. This does not allow a replacement fix review or clear a blocker.
- Verdict evidence is bound to the immutable candidate, while live branch freshness remains separate. Current quality is revalidated on reads and verdicts; the captured quality remains historical.
- Remote run 113 on c194 failed test types and CRAP; formatter is unavailable. It is not a passed author check. Remote RED 158 on test-only 599df0f3 reproduced eight failures and retained the head-approved historical reviewer case. Only targeted remote checks are authorized for this fix pass; no second independent review or full suite.
