# Panel Overflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make panel text and action groups fit their real widths without hiding content, while preserving panel behavior and applying the final common visual standard when its authorized handoff arrives.

**Architecture:** Use the existing DOM and CSS variables. Add only the semantic Notebook action container needed for whole-group placement, then use shared structural selectors for shrinking, wrapping and action flow. Keep final spacing and visual polish separate until the approved #478 snapshot is delivered through the head.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Playwright.

**Spec:** Hornhoof tasks #465 and #470, plus the published #469 preliminary inventory and BEFORE geometry.

## Global Constraints

- No global `overflow: hidden` or clipped text used to disguise a layout defect.
- No edits in files owned by active Requests, AgentWindow, AgentTerminal or People writers.
- Preserve #369 panel alignment, #335 terminal fit, #411 rendering performance and #398 access control.
- Real supported locales only, currently EN and RU; synthetic expansion is separate and missing RTL is not a pass.
- Only focused tests, package types, `typecheck:tests`, lint, crapper and dryer. No root `npm test`, `run_tests` or mutator.
- Work on `task-470`, commit as Ivan Korol without trailers, merge to `turn-8` without force, never change main.

## Review Focus

- Unbroken URL, command, author and task strings must wrap instead of widening their panel.
- A whole action group must move below its text on one edge without split or inaccessible controls.
- Narrow desktop side panels and phone overlays must preserve terminal geometry and keyboard behavior.
- Loading, error, edit and populated states must keep the same overflow contract.
- Hidden agents and forbidden payloads must not be introduced by layout fixtures or exposed as integration evidence.

---

### Task 1: Baseline browser contract

**Files:**
- Create: `apps/web/e2e/panel-overflow.spec.ts`
- Read: `apps/web/e2e/agent-window-panels-api.ts`, `apps/web/e2e/api.ts`, `apps/web/src/theme.css`

**Interfaces:**
- Consumes: `openAgent(page, settings, who)`, `serveApi(page)`, existing `--panel-width` CSS variable.
- Produces: repeatable BEFORE/AFTER captures named by surface, locale, theme, viewport and panel width.

- [ ] **Step 1: Write failing Notebook and task-list geometry tests**

Assert each content and action rectangle stays inside its panel, full text remains available, the Notebook Change/Remove group is below the note on one row, and long task briefs wrap rather than clip.

- [ ] **Step 2: Run baseline and save evidence**

Run: `npm run test:browser -w apps/web -- e2e/panel-overflow.spec.ts --workers=2 --timeout=120000`
Expected: Notebook content/actions exceed the body and `.trow-brief` is `nowrap`; screenshots are saved before assertions.

- [ ] **Step 3: Record the exact baseline contracts**

List the exercised surface, DOM selector, viewport, panel width, locale, theme and observed failure. Do not mark any unexercised #469 inventory row as captured.

### Task 2: Notebook and shared panel structure

**Files:**
- Modify: `apps/web/src/ui/Notebook.tsx`
- Modify: `apps/web/src/theme.css`
- Modify: `apps/web/e2e/panel-overflow.spec.ts`
- Test: `apps/web/test/Notebook.test.tsx`

**Interfaces:**
- Consumes: existing note view and panel frame.
- Produces: `.notebook-item-actions`, one flex group containing Change and Remove; shared panel children can shrink with `min-width: 0`.

- [ ] **Step 1: Keep the failing browser assertions ahead of production edits**

Confirm the failure is the grid `auto 1fr auto auto auto` and unbounded siblings, not a server or fixture failure.

- [ ] **Step 2: Implement the smallest structural fix**

Wrap Notebook actions, use a shrinkable text column, wrap long text and place the whole action group on one edge below the note. Add shared panel child min-width and wrapping rules, including task brief and command grid tracks. Do not hide overflow.

- [ ] **Step 3: Run focused behavior and browser tests**

Run: `npm test -w apps/web -- test/Notebook.test.tsx`
Expected: all existing add/edit/remove/read-error/stream/localization behavior passes.

Run: `npm run test:browser -w apps/web -- e2e/panel-overflow.spec.ts`
Expected: geometry and full-text assertions pass in EN/RU, both themes, phone/desktop and narrow/wide side panels.

- [ ] **Step 4: Commit the independently useful structure**

Commit Notebook, structural CSS, browser tests and this plan only after the focused checks pass.

### Task 3: Extend the contract across inventory families

**Files:**
- Modify: `apps/web/src/theme.css`
- Modify: `apps/web/e2e/panel-overflow.spec.ts`
- Test: existing affected unit and Playwright suites

**Interfaces:**
- Consumes: shared `.ac-body`, `.panel-form`, `.command`, `.trow`, `.ptable`, `.req-actions`, `.repo-actions`, `.settings-actions`, `.machine-actions`, `.ask` structures.
- Produces: one checked status table with explicit exercised and pending rows.

- [ ] **Step 1: Add failing cases for shared text and action structures**

Cover task detail, inline confirmation, settings/forms, command text, people/table rows and available panel states. Coordinate any missing semantic insertion with the active owner instead of editing that owner's file.

- [ ] **Step 2: Apply shared structural rules without changing component behavior**

Add flex wrapping, shrinkable grid tracks and `overflow-wrap: anywhere` only where the real DOM requires them. Keep action labels and terminal layout intact.

- [ ] **Step 3: Run affected regressions**

Run focused Notebook, TaskPanel, People, Requests, Department and existing side-panel/terminal-fit tests.
Expected: all affected tests pass, with no browser console errors or new failed requests.

- [ ] **Step 4: Commit each verified inventory increment separately**

Record exact files, tests, remaining unexercised panels and any owner coordination required.

### Task 4: Authorized visual handoff and delivery

**Files:**
- Modify only the layout/style files justified by Tasks 2–3 and the approved #478 snapshot
- Create: final BEFORE/AFTER matrix and checked-place table as task attachments

**Interfaces:**
- Consumes: the authorized #478 implementation snapshot delivered through the head/orchestrator.
- Produces: final common spacing/edge treatment and the complete checked matrix.

- [ ] **Step 1: Pause only final visual polish if the handoff is absent**

Report the independent structural work and the exact unfinished visual part. Do not call all of #465 blocked and do not invent the design.

- [ ] **Step 2: Apply the delivered common standard**

Keep the behavior contract unchanged, update only final layout/style details and repeat the same BEFORE/AFTER captures.

- [ ] **Step 3: Run delivery checks**

Run affected tests, web TypeScript, `typecheck:tests`, lint, crapper, dryer, release checks and `git diff --check`.
Expected: all pass; no full suite or external test runner is used.

- [ ] **Step 4: Merge and submit**

Push `task-470`, run the focused checks on the merge into fresh `turn-8`, push without force and submit exact SHAs, commands, logs, screenshots and the complete checked-place table.
