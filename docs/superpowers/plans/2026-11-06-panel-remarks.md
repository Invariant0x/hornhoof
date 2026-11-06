# Panel remarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Design head's N1, N2, C1, C2, P1–P6, M1–M3, S1, S2, G1 and G2 remarks without changing the accepted record groups or long-text wrapping.

**Architecture:** Keep the existing components and tokens. Make small markup changes where the record semantics are wrong, put geometry in `theme.css`, and reuse `fitTable` for every sort table. Prove each change through the real browser fixtures in `apps/web/e2e/panel-overflow.spec.ts`, then capture the required evidence on the final SHA.

**Tech Stack:** React, TypeScript, CSS, Vitest, Playwright, Hornhoof `run_tests`.

**Spec:** `verdict-591.md` (Design head verdict #591, SHA256 a051d3a4e9970a7fabefaf0b95a0b8a6e17cf6a207f8af0ac08f8f248a3c781a).

## Global Constraints

- Work in `task-593` from fresh `origin/turn-8`; merge to `turn-8`, never `main` or force-push.
- Commits are Ivan Korol <invariant0x@icloud.com>, with no trailers.
- All installs, builds, tests, types, lint, coverage, CRAP and dryer run through `run_tests` on an exact SHA.
- Every behavior change starts with a failing test and a recorded RED result.
- Browser evidence: Chromium only, EN/RU, light/dark, 375/1440. Other engines and visual PASS remain NOT_RUN.
- Keep accepted 44px record groups, 8px gaps, end alignment and full long-name/URL wrapping. Do not change N3.
- No new colors, components, lifecycle, confirmation flow or second table layout.

## Review Focus

- Long machine names and translated column labels must switch a table to entries before any word splits: Task 3 browser assertions.
- People entry cells must not invent `Name` or `Actions` labels, and labels must align with the first value line: Task 2 DOM and computed-style assertions.
- Standalone Copy, Done, Cancel, Update, Disconnect and page-heading buttons must be at least 44px and end-aligned: Tasks 1 and 3 geometry assertions.
- The version stamp must not cover content at 375px: Task 1 bounding-box assertions.
- Every delivered image must come from the final source and show its actual state, including error, empty, saving and keyboard focus: Task 4 evidence checklist.

---

### Task 1: Notebook, command, settings and global marks

**Files:**
- Modify: `apps/web/src/ui/Notebook.tsx`
- Modify: `apps/web/src/theme.css`
- Test: `apps/web/e2e/panel-overflow.spec.ts`
- Test: `apps/web/test/css.test.ts`

**Interfaces:**
- Consumes: existing `Notebook`, `CommandBox`, `CopyButton`, `Settings`, `VersionMark`, `.people-head` and `.form-foot` markup.
- Produces: note text shaped as `<p><b>#N</b> text</p>`; product-styled notebook textarea; 44px end-aligned standalone buttons; a non-overlaying mobile `.version-mark`.

- [ ] **Step 1: Write failing browser and CSS tests**

Add assertions that:
- The note number and first text line share a paragraph and baseline (N1).
- Notebook textarea and placeholder use `--line2`, `--surface2`, `--ink`, `--muted`, square corners and the comment-field padding (N2).
- Command Cancel is at least 44px (C1); command Copy is below the code, at least 44px and end-aligned (C2).
- Settings Copy and Done are at least 44px and end-aligned (S1, S2).
- `.people-head > .btn` is at least 44px and remains end-aligned at 375px (G2).
- At 375px the version stamp is in normal flow and its rectangle intersects neither text nor buttons (G1).

- [ ] **Step 2: Run the tests to verify RED**

Run through `run_tests`: `npm test -w apps/web -- test/css.test.ts` and the named panel-overflow scenarios. Expected: current note structure, 30/32/40px controls, side-by-side Copy and fixed version mark fail for the stated reasons.

- [ ] **Step 3: Implement the minimal changes**

In `Notebook.tsx`, render the note number and text in one paragraph. In `theme.css`, add explicit notebook text and placeholder colors, square corners and existing padding; use `minmax(0, 1fr)` for `.command`; place `.command > .btn`, `.settings-link > .btn`, `.dialog > header .btn`, `.people-head > .btn` and panel action buttons at the end with `min-height: 44px`. At 375px make `.version-mark` static, full-width, end-aligned and padded after the page content.

- [ ] **Step 4: Run the same tests to verify GREEN**

Expected: all N1, N2, C1, C2, S1, S2, G1 and G2 assertions pass without changing accepted action groups.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/Notebook.tsx apps/web/src/theme.css apps/web/e2e/panel-overflow.spec.ts apps/web/test/css.test.ts
git commit -m "Align standalone panel controls with the design reference"
```

### Task 2: People records

**Files:**
- Modify: `apps/web/src/screens/People.tsx`
- Modify: `apps/web/src/theme.css`
- Test: `apps/web/e2e/panel-overflow.spec.ts`
- Test: `apps/web/test/css.test.ts`

**Interfaces:**
- Consumes: `PersonRow`, `.fit > .ptable[data-fit="entries"]` and existing `fitTable` measurement.
- Produces: `td.pname-cell` without `data-label`; `td.row-actions` without `data-label`; compact status and consistent record labels.

- [ ] **Step 1: Write failing tests**

For the long-name entry fixture assert:
- Status is inline and hugs its text (P1).
- The name is the full-width record heading with no generated `Name` label (P2).
- Actions have no generated `Actions` label (P3).
- Every generated label is 12px, weight 400 and `var(--muted)` at both widths (P4), aligned to the first value baseline (P5).
- The last value-to-action-group gap is 8px (P6).

- [ ] **Step 2: Run the tests to verify RED**

Expected: full-width status, `Name`/`Actions` pseudo-labels, 11px/600 mobile labels and 4px action gap fail.

- [ ] **Step 3: Implement the minimal changes**

Add `pname-cell` to the name cell and remove `data-label` from it and from `row-actions`. Set `.status` to `inline-block; max-inline-size: 100%`. In the entries-only label rule set 12px, weight 400, `var(--muted)` and `align-items: baseline`; change `row-actions` top padding to 8px. Scope the change away from real tables.

- [ ] **Step 4: Run the same tests to verify GREEN**

Expected: P1–P6 pass; accepted action order, wrapping and end alignment remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/People.tsx apps/web/src/theme.css apps/web/e2e/panel-overflow.spec.ts apps/web/test/css.test.ts
git commit -m "Correct people entry labels and status geometry"
```

### Task 3: Machine actions and sort-table fitting

**Files:**
- Modify: `apps/web/src/ui/SortTable.tsx`
- Modify: `apps/web/src/theme.css`
- Test: `apps/web/e2e/panel-overflow.spec.ts`
- Test: `apps/web/test/fit-table.test.ts`

**Interfaces:**
- Consumes: `fitTable(table: HTMLTableElement): void`, `.tbl` and machine action markup.
- Produces: a measured `.tbl.fit` host that sets `table.dataset.fit = 'entries'` whenever whole words no longer fit; 44px end-aligned machine actions.

- [ ] **Step 1: Write failing tests**

Assert Update programs and Disconnect are at least 44px and share the confirmation group's end edge (M1, M2). With the long machine-name fixture assert `.dt[data-fit="entries"]` and no clipped column fragments such as `unkno`, `ns` or `nts` (M3).

- [ ] **Step 2: Run the tests to verify RED**

Expected: 30/32px left-aligned actions and a real table with split words fail.

- [ ] **Step 3: Implement the minimal changes**

Add `.machine-actions` end alignment and 44px auto-height buttons. In `SortTable.tsx`, change the table host to `.tbl fit`, keep a table ref and use the existing People pattern: measure on mount/content/language changes, observe the host with `ResizeObserver`, and measure again after `document.fonts.ready`. Do not duplicate the fitting rule.

- [ ] **Step 4: Run the same tests to verify GREEN**

Expected: M1–M3 pass; fitting rows become records, while ordinary rows remain a real table.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/SortTable.tsx apps/web/src/theme.css apps/web/e2e/panel-overflow.spec.ts apps/web/test/fit-table.test.ts
git commit -m "Fit sort tables before splitting words and align machine actions"
```

### Task 4: Complete evidence and final quality

**Files:**
- Modify only for evidence: `apps/web/e2e/panel-overflow.spec.ts` and other existing affected test files.
- Review the final diff for the files changed in Tasks 1–3.

**Interfaces:**
- Consumes: all Tasks 1–3 changes and the missing-shot list in `verdict-591.md:92-103`.
- Produces: final-SHA screenshots and a list of attachment IDs for the Design head.

- [ ] **Step 1: Add the missing evidence scenarios**

Cover Russian Command plus EN light 375; Notebook empty/read error+retry/save error/saving/editing; Task detail dark desktop, full log, subtasks, filled comment and complete Cancel; all missing Russian Machine confirmation views and online machine; ordinary People table plus multiple records and invite/edit forms; Settings view and rename; real question/choice/approval/stuck cards; keyboard focus for the named controls; agent/window cards and Requests error/empty/saving states.

- [ ] **Step 2: Run the evidence matrix on the final SHA**

Run through `run_tests`: EN/RU × light/dark × 375/1440, all targeted scenarios. Record each artifact name, source SHA, actual version fixture and result. Do not claim Firefox, WebKit, RTL or visual PASS.

- [ ] **Step 3: Run final quality checks**

Run through `run_tests`: affected Vitest files, web `tsc`, `typecheck:tests`, changed-file ESLint, release check, affected coverage, CRAP under 10 for new/changed functions and dryer. Preserve pre-existing legacy metrics only with an explicit head-approved comparison.

- [ ] **Step 4: Review and merge**

Verify the final diff is limited to the planned files, no accepted record group or long-text behavior regressed, then merge `task-593` into fresh `turn-8`. Repeat targeted browser and type checks on the merge SHA.

- [ ] **Step 5: Attach and report the evidence**

Attach all final screenshots to #593 with source SHA in the report, list attachment IDs for the Design head, and submit the merge SHA plus exact commands/results. State explicitly that visual verdict and other engines are NOT_RUN.
