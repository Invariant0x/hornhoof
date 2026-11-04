# Node Connection History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record and explain every machine node connection and disconnect, including the node's own reconnect report, and show a bounded 24-hour summary in the machine card.

**Architecture:** `NodeHub` classifies socket lifecycle events and passes them to a small server history module. A new append-mostly event table stores server observations and the node report on the matching disconnect. The existing machine routes expose the same data under the existing machine visibility rule, and a focused React component renders it in both languages.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, PostgreSQL/PGlite, Vitest, React, Testing Library, Playwright.

**Spec:** Hornhoof task #285 and parent task #283, including the `NodeReconnect` protocol contract merged in `c7f31edb`.

## Global Constraints

- Branch from fresh `origin/turn-7`; commit as Ivan Korol without trailers; merge only to `turn-7` after submit.
- Tests fail before their production change and pass afterward. Run only changed areas, not the whole suite.
- English code and commits; EN and RU screen strings; no em dashes; Russian uses `е`, not `ё`.
- Keep 14 days and at most 2000 events per machine. No new permissions, credentials in logs, or changes to `awaySince`, `isOnline`, or existing `onClose` behavior.
- Do not run mutator. Run crapper, dryer, and manual web mutants on the changes.

## Review Focus

- Replaced and concurrently closing sockets must produce one disconnect and the correct offline duration; cover in socket/hub tests.
- Old nodes omit `node.reconnect`; their server events must still work; cover in socket tests.
- A listed person may read history only for their own machine, never another person's or company's; cover API tests.
- Ongoing and zero-duration outages must not distort summary averages; cover summary tests.
- Missing history, loading, and failed API responses must leave the rest of the machine card usable; cover component tests.

---

### Task 1: Event Schema and Storage

**Files:**
- Create: `apps/server/src/modules/nodes/history.ts`
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0058_node_connection_history.sql` and generated metadata
- Test: `apps/server/test/node-history.test.ts`, `apps/server/test/migrations.test.ts`

**Interfaces:**
- Produces: `recordNodeConnection(ctx, id, event)`, `attachNodeReconnect(db, id, report)`, `pruneNodeConnectionHistory(db, now)`, and `NodeConnectionEvent` types.

- [ ] Write failing tests for connected/disconnected rows, offline duration on reconnect, node report attachment, 14-day pruning, and the per-machine 2000-event cap.
- [ ] Run `npx vitest run test/node-history.test.ts` in `apps/server`; confirm failures are missing schema/module behavior.
- [ ] Add `node_connection_events` with company/machine/node references, event kind and time, actor/cause, close code/reason, offline milliseconds, node report JSON, and lookup indexes. Generate migration 0058 without data backfill.
- [ ] Implement storage and pruning with machine and company taken from the authenticated node row, never from the socket message.
- [ ] Add fresh-install and pre-0058 upgrade migration tests; run them and the storage tests until green.
- [ ] Commit the proved increment.

### Task 2: Socket Lifecycle and Node Reports

**Files:**
- Modify: `apps/server/src/modules/nodes/hub.ts`, `messages.ts`, `app.ts`
- Test: `apps/server/test/hub.test.ts`, `apps/server/test/socket.test.ts`, `apps/server/test/node-history.test.ts`

**Interfaces:**
- Consumes: Task 1 storage functions.
- Produces: hub lifecycle callback carrying event kind, time, actor/cause, close code/reason, and socket error detail.

- [ ] Add failing hub/socket cases for missed pongs, node close, socket error, replacement, server stop, and `node.reconnect` after `hello`.
- [ ] Run the focused tests and verify each new case fails for the missing history behavior.
- [ ] Move each socket's message chain into its entry, classify the end once, and emit connect/disconnect events without changing existing close handling.
- [ ] Handle `node.reconnect` only for the current keyed node; attach it to the latest disconnect. Treat its absence as normal.
- [ ] Log one safe server line per real node connect/disconnect with hostname, cause, and close code, never a key.
- [ ] Run hub, socket, and history tests until green; commit.

### Task 3: Summary and Protected API

**Files:**
- Modify: `apps/server/src/modules/nodes/history.ts`, `routes.ts`
- Test: `apps/server/test/node-history.test.ts`

**Interfaces:**
- Produces: `GET /api/machines/:id/connection-history` returning `{ summary, events }`; summary covers 24 hours and events are newest first.

- [ ] Write failing API tests for disconnect count, rounded average offline time, most frequent cause, combined server/node details, another person's machine, a listed person's own machine, and another company.
- [ ] Run the tests and confirm 404/route or assertion failures for the missing behavior.
- [ ] Implement summary calculation and the route with the same live-machine, company, owner/company-scope check as the machine list. Include ongoing offline duration up to the response time.
- [ ] Run API and history tests until green; commit.

### Task 4: Machine Card History

**Files:**
- Create: `apps/web/src/ui/MachineConnectionHistory.tsx`
- Modify: `apps/web/src/screens/Machines.tsx`, `types.ts`, `theme.css`, `i18n/en.ts`, `i18n/ru.ts`
- Test: `apps/web/test/Machines.test.tsx`, `apps/web/e2e/machine-connection-history.spec.ts`

**Interfaces:**
- Consumes: Task 3 API and shared connection event types local to web.

- [ ] Write failing EN/RU component tests for the 24-hour summary, recent events, offline duration, node observations, empty state, and failed request.
- [ ] Run `npx vitest run test/Machines.test.tsx` in `apps/web`; verify the new assertions fail.
- [ ] Implement a compact history section in real machine cards only, with locale dates, plain-language causes, safe wrapping, and no additional permissions or controls.
- [ ] Run component tests until green, then add a browser scenario with seeded API history.
- [ ] Exercise EN/RU, light/dark, 1440/375, check overflow and console errors, and attach screenshots.
- [ ] Run manual web mutants for summary selection, event wording, empty/error states, and responsive rendering; commit.

### Task 5: Verification and Integration

- [ ] Run focused server/web tests, migration tests, browser spec, `typecheck:tests`, server/web `tsc`, and ESLint on changed files.
- [ ] Run crapper and dryer from the repository root on branch changes; do not run mutator.
- [ ] Inspect `git diff --check`, migration numbering against fresh `turn-7`, and final diff for scope and secrets.
- [ ] Push `task-285-connection-history`, submit evidence, merge into fresh `turn-7`, rerun affected checks on the merge, and report the merge commit.
