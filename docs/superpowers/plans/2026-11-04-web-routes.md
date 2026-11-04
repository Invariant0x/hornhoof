# Web routes implementation plan

> For agentic workers: execute inline with executing-plans, using RED/GREEN increments.

**Goal:** Every workspace section and task, person and machine card has a shareable path and browser history.

**Architecture:** A single route module parses and builds local paths. Shell consumes its history hook without remounting the agent window store. Cards use the same scoped API data as their existing screens; missing or forbidden records show a translated unavailable page.

**Tech stack:** React, TypeScript, History API, Vitest, Playwright.

**Spec:** Hornhoof tasks #301 and #302 (current task body and log).

## Global constraints

- Work on task-302 from origin/turn-7; merge into fresh turn-7 after submit. Never change main.
- English source and commits, EN/RU text, no em dashes, no Russian letter yo.
- npm ci first; only affected tests. Mutator is not run. Use crapper, dryer and four manual web mutants.
- Preserve /invite/<token>, keep agent windows mounted, never trust a URL for authorization.
- Paths: /, /tasks[/id], /people[/id], /departments/id, /subscriptions, /machines[/id], /improvements, /versions, /profile, /settings, /about.

## Review focus

- Malformed percent escapes and encoded separators must show unavailable, without throwing or redirecting.
- A late answer for an old record must never appear under the next record's path.
- Forbidden or removed records must never fall back to a different record or the map.
- Login must retain the local destination; external return parameters must have no navigation effect.
- Back/forward and modal close must retain agent window drafts and minimized strips.

### Task 1: Local route model and history

**Files:** Create apps/web/src/routes.ts and apps/web/test/routes.test.tsx.

**Interfaces:** Route is a discriminated union; routePath(Route): string, parseRoute(path: string): Route, useRoute(): { route, navigate }.

- [x] Write parser/builder and hook tests: all sections and IDs, malformed/unsafe paths, duplicate navigation and popstate.
- [x] Run npm test -w apps/web -- test/routes.test.tsx --maxWorkers=1; expect RED for absent routing.
- [x] Implement parser, safe builders and history hook; run the same command, expect GREEN; commit.

### Task 2: Workspace and deep links

**Files:** Modify App.tsx, screens/Shell.tsx, People.tsx, Machines.tsx, ui/SortTable.tsx, ui/TaskPanel.tsx and i18n/en.ts, ru.ts. Add route-unavailable view and integration tests.

**Interfaces:** Shell consumes Route; People/Machines accept selected ID and selection callback; route failures render a common unavailable view with a home action. Login rechecks auth without replacing pathname.

- [x] Write integration tests for navigation, direct department/task/person/machine/account paths, unauthorized/missing records, login and window survival.
- [x] Run affected integration tests and observe missing behavior before implementation.
- [x] Replace duplicated navigation state with Route, connect record selection and guarded failures; preserve existing screen props for standalone consumers.
- [x] Run changed screen tests plus App/Shell/agent window tests; expect GREEN; commit.

### Task 3: Browser evidence and delivery

**Files:** Add apps/web/e2e/routes.spec.ts and its fixture. Update this plan with evidence.

**Interfaces:** Browser fixture provides scoped company records and two authenticated people, auth transitions and explicit 403/404 replies.

- [x] Write browser navigation/history/deep-link cases and observe RED on the baseline source.
- [x] Run Chromium in EN/RU, light/dark, 1440/375; copy links to an isolated second person's context, reload, retain minimized windows and drafts. Save screenshots and attach them to #302.
- [x] Prove four manual mutants fail: no pushState, no popstate, login resets home, unsafe external navigation.
- [x] Run scoped tests with coverage, tsc, typecheck:tests, changed-file ESLint, crapper and dryer. Review the complete diff independently.
Delivery procedure: merge fresh turn-7, repeat affected checks, commit and push task-302, submit evidence, then merge/push turn-7 as authorized. Publication receipts are recorded in the task log.

## Review decisions

The independent review reproduced a machine card hidden by search after Back and a dialog closing to a later history entry's section. Both have failing regressions before the fix. A routed card remains visible through filters, and each history entry stores its own safe local dialog background. Broad component complexity remains an explicit delivery concern. Server fallback and real server authorization belong to #303 and #291; the web browser tests use scoped fixtures.

## Verification on the integrated branch

- Source integrated with turn-7 at `816f34e9`: 18 affected test files, 395 passing tests with Vitest V8 coverage.
- `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright HORNHOOF_BROWSER_PORT=4302 npm run test:browser -w apps/web -- routes.spec.ts --workers=1`: 55 passed. EN/RU, light/dark, 1440/375; separate viewer context, direct links/reloads, drafts/windows, denied and delayed records, filtered machine history and revisited dialogs.
- `npm run typecheck:tests`, `npx --no-install tsc -p apps/web/tsconfig.json --noEmit`, ESLint on the 23 changed TS/TSX files and `git diff --check`: exit 0.
- Four targeted manual mutants: each assertion failure exits 1, baseline exits 0; no test timeouts; original source hashes restored. Installed mutator was not run.
- Crapper with the current LCOV, preserving counts and normalizing only SF paths: new functions at most 9.2. Dryer at 0.8: no duplicate candidates.
- Independent review found two navigation defects, both reproduced RED and corrected with unit and browser regressions.
- Thirty screenshots attached to #302 cover all language/theme/viewport combinations. The per-turn upload cap stopped the remaining 19 images and the raw evidence archive; local artifacts are retained.

Delivery concerns: large existing components remain above CRAP 10; Shell grew from CC50 to CC80 (CRAP80.7). Server fallback and real server authorization are verified by #303 and #291, respectively, rather than these mocked browser fixtures. Existing jsdom canvas warnings remain.
