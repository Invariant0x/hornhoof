# Commit impact ports and replay

`apps/node/src/test-impact.ts` is a pure selector. Its explicit input contains package roots, languages and suite IDs, the canonical environment `impact` fields, the complete canonical `TestUnit` inventory, Git changes and collected graphs. The output records selected units, package fallbacks, migration commands and blocking problems. It does not execute tests or migration commands.

`test-impact-adapters.ts` maps project/file collection rows to canonical suite/file units. Supply an explicit project-to-suite map and a complete inventory; an unknown row or missing inventory unit makes the graph unavailable. For mixed-language inventory, independently declare `requiredSuiteIds` for this adapter; absent that declaration, every inventory suite must be covered. Root Vitest collection uses the separate `related-probe.mjs` provider, one changed path per invocation, in a child whose cwd is the checkout root. Collection is not test execution.

Whole-package policy keeps known consumer packages and expands them completely. When no complete graph bounds those consumers, selection widens to all declared packages. Overlapping policy rules are combined. Canonical `(suiteId, selectionUnit)` groups always remain complete, including newly added tests.

A changed `.test` or `.spec` file absent from the Vitest collection makes that adapter unavailable, even if other tests were selected. An E2E test outside the configured projects cannot prove an empty impact. Whole-package fallback covers the declared inventory; supplying other runners and their complete inventories remains the caller's responsibility.

The Python helper under `impact-python/` parses a complete package file list without importing repository modules. It supports local imports in package-root and `src/` layouts, transitive and relative imports, package initializers and cycles. Conftest hooks, unknown external dependencies, dynamic imports, star imports, syntax errors, ambiguous modules and invalid paths make the graph unavailable. The standalone adapter supports one canonical suite per Python package; ambiguous multiple-suite packages use a whole-package fallback. Its scoped, pinned check dependencies and formatting settings are not a repository-wide Python standard.

## Standalone report

Run these commands through the shared test runner, with the expected candidate SHA checked first:

```sh
npm ci
npm run build -w @hornhoof/protocol
npm run build -w @hornhoof/node
node scripts/test/replay-impact.mjs request.json > replay.json
```

The caller supplies `request.json` with `environment` (the selector input above), `projectSuites` (Vitest project name to canonical suite IDs), and optionally `comparator`. The comparator port requires a verified completed full execution at the same candidate: exact commit, run/part IDs, passed/failed status, complete inventory and failing units. Native receipt retrieval and authority remain the caller's responsibility. Do not substitute synthetic receipts or an unrelated historical run.

Use a fresh immutable checkout for the candidate; this reporting port does not lock a concurrently edited worktree. The script reads ten first-parent changes from `refs/remotes/origin/main` and applies those historical diffs to the current pinned candidate's inventory and graph. It never checks out old commits, changes refs, runs migration commands or executes ten full suites. Files changed since those historical commits may be missing at the candidate; the report preserves conservative fallbacks and blocked new-test cases.

The JSON scope is `historical-diffs-at-candidate`. Width uses canonical test units as its denominator, including separate project variants. Without a suitable full comparator, omitted failures are `unavailable`, not zero. With one, an omitted observed failure is reported without claiming the change caused it. Exit codes are 0 for a recorded report, 2 for observed omitted failures, 3 for blocked selection, and 1 for collection/input failure before a report can be produced. Exit 0 does not mean the selected tests passed.

Production environment/runner integration (#280/#222), selection-miss storage (#308), and timing against turn 7 are separate unfinished ports. They are not implemented by this script.
