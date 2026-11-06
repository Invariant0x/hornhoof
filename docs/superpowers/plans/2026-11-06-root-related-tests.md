# Root Related Tests Implementation Plan

> **For agentic workers:** Use executing-plans inline. The assigned task is approved; the common turn review is the gate.

**Goal:** Make root Vitest related selection follow real source imports without losing workspace tests or importing the app through database-only helpers.

**Architecture:** A root test.projects config extends each existing workspace config. Test-only protocol aliases point at source. A small setup preserves each fork's workspace cwd. Database/basic helpers are separate from the app fixture; only import statements change in their consumers.

**Tech Stack:** Locked Vitest5.0.5, Vite8, Node22, TypeScript and Node test scripts.

**Spec:** Hornhoof565 and parent309, including v4 additions, read2026-11-06. No architecture note is required.

## Global Constraints

- Branch task-565 from fresh turn-8, author Ivan Korol, no trailers/force/main.
- All author checks through targeted run_tests on the platform-selected Linux machine, no local heavy checks or full suite.
- No integration into280/222;566 owns selector/fallback/language adapters/replay10.
- No assertion, deadline or test removal. Compare complete file inventories without executing the whole suite; final executed test totals remain the turn's T3 responsibility.
- Coordinate mechanical imports with active owners. Preserve standalone workspace commands and production package exports.

## Review Focus

- Config containers can discover files without applying the right environment/setup; run real narrow tests from every workspace.
- Root cwd differs from project root; preserve relative fixture/CSS reads in fork workers.
- Protocol subpath aliases must not accidentally redirect production builds or ignore subpaths.
- A light helper re-exported through the heavy helper does not narrow its old consumers; switch actual light-only imports and prove a negative selection.
- Connecting no-proc adds a real variant; do not replace the normal tests or count variants as new unique files.

### Task1: Root projects, source aliases and reproducible evidence

**Files:** vitest.config.mjs; scripts/test/root-vitest.test.mjs and related-probe.mjs; scripts/test/workspace-cwd.mjs; root package.json; root MJS lint scope. MJS uses the existing root lint path without adding a second TypeScript program for app configs.

**Interfaces:** `vitest related <repo-relative files> --run` from root. Public API `createVitest({root,watch:false,related:files})`, `getRelevantTestSpecifications()` returns moduleId/project.name; `globTestSpecifications()` inventories files; always close(). The probe emits HH_RELATED_WIDTH with full selected file sets and does not execute tests.

- [x] Write Node integration contracts for five project identities, exact preservation of workspace file inventories, real server/protocol/node selection and a negative unrelated DB selection.
- [x] Remote RED on the unchanged config after npmci/protocol preparation; save full before inventories and widths. Run300 at67891cce: five expected failures, install/build/lint0. Normal workspace files201+125+73+17=416; the unconfigured root discovers476, including unrelated runner inputs.
- [x] Add the root config, test-only aliases and cwd setup; connect the existing no-proc variant under a unique name.
- [x] Remote312 contracts5/5 and narrow actual server/protocol/node/no-proc/CSS executions passed.312 overall remains failed because of separate tasks-merge/coverage failures. No full suite callbacks run.
- [x] Publish early test-only67891cce/API in566 and direct70032; both tools accepted.70032 reports455 as its active task, so this is a recorded handoff, not proof that566 consumed it.

### Task2: Separate light helpers and verify the selection reduction

**Files:** apps/server/test/helpers.ts; new helpers-db.ts/helpers-basic.ts; mechanically updated light-only consumers agreed with their owners.

**Interfaces:** Existing heavy helpers keep their app API and cleanup order. Direct light imports must not reach buildApp. No production behavior changes.

- [x] Keep the failing app-change-excludes-DB assertion from Task1 and record the before selection.
- [x] Move existing bodies without behavior edits, then change only the needed consumer imports.
- [ ] Run affected light/helper tests, types/test-types, lint, scoped coverage/CRAP/dryer remotely; preserve unsupported-tool output as a concern.
- [x] Record before/after widths for real server, protocol and node files;312 proves all baseline normal workspace files remain. Upstream five-file addition and no-proc variants are separate.

### Task3: Handoff and turn integration

**Files:** docs/superpowers/reports/2026-11-06-root-related-tests.md and inventory/width evidence.

**Interfaces:** Exact source SHA, run/part IDs, stage outcomes, load/CPU/memory facts and commands.566 consumes the public Vitest interface, not a private queue or new runner.

- [ ] Report root and per-package selection denominators, variant counts and any graph limitations without claiming executed full-suite totals.
- [ ] After green checks, fetch current turn-8, merge the task branch into turn-8 as authorized and run affected checks on that exact merge SHA before normal push.
- [ ] Submit with evidence and remaining parent309 integration/replay/turn7 percentage limits.
