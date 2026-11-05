# Stryker and Vitest pilot

This is a separate npm project. It does not change the application's lockfile
or production dependencies. Run one pilot at a time in a checkout.

```sh
# From the repository root:
npm ci
cd apps/node/quality/stryker
npm ci --workspaces=false
npm test
node run.mjs --compare
```

`mutator` must be the patched tool from the node quality stage. To use another
installed copy, set `MUTATOR_BIN` to its executable path. `node run.mjs` runs
only Stryker. Both modes copy the current `apps/node/src/redact.ts` and its
existing two tests into this isolated project. They never edit those source
files. Generated copies, reports, coverage, caches and dependencies are ignored.

The comparison runs mutator from the monorepo root with `--root .`, a scoped
Vitest command, one worker, `--mutate-all`, and the LCOV produced by those same
tests. Coverage collection is outside the timed mutation runs. Exit 3 from
mutator means survivors were found; configuration errors, compilation errors
and timeouts still fail the script. Stryker uses its Vitest runner, including
its unmutated dry run and per-test coverage. Its break threshold is zero
because this pilot records test gaps rather than serving as a release gate.

The first run after a fingerprint change is cold. To measure another cold run,
remove only `reports/incremental.json` before starting. Reports include source
and test SHA-256 hashes, declared tool versions, elapsed wall time, exit codes
and outcome counts. JSON and full logs remain under `reports/`.

## Cache validity

`cache.mjs` hashes every file in this pilot except dependencies and generated
outputs, including source, tests, helpers, settings, scripts and the lockfile.
It also hashes all environment values, Node versions, platform and architecture.
Only a digest is saved; environment values are never written to reports.
A changed, added or removed input deletes Stryker's incremental report before
Stryker starts. Unchanged inputs retain it. Use `npm ci` after dependency
changes so installed packages agree with the lockfile.

This guard is needed because Stryker's own incremental comparison does not
track helper files, dependencies or environment changes. See the official
[incremental limitations](https://stryker-mutator.io/docs/stryker-js/incremental/)
and [Vitest runner](https://stryker-mutator.io/docs/stryker-js/vitest-runner/).

The local `.npmrc` enables `legacy-peer-deps`: npm 10.9.9 crashes in Arborist
while resolving Vitest 5's optional browser peer graph (`edgesOut` on null).
Required runtime peers are explicitly pinned, including Vite; the actual pilot
verifies that this exact combination works. No browser runner is used.

## Observed comparison

Linux, Node 22.23.4, TypeScript 5.9.3, Vitest/coverage-v8 5.0.5, Vite 8.3.5,
Stryker core/Vitest runner 10.1.1. Source revision: `f289196b`.
One cold sample, concurrency 1, identical source and tests:

| Tool | Wall seconds | Killed | Survived | Uncovered | Compile error | Timeout | Total | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Patched mutator | 2.094 | 2 | 2 | 0 | 0 | 0 | 4 | 3 |
| Stryker with Vitest | 3.700 | 15 | 7 | 0 | 0 | 0 | 22 | 0 |

Different mutation operators produce different totals, so mutation percentages
are not comparable. This small timing sample does not establish performance
for a larger project. Neither tool found compilation errors or timeouts in
this sample; the Python regression fixtures check those outcomes separately.

| Location | mutator | Stryker | Finding |
| --- | --- | --- | --- |
| `redact.ts:8`, delete `!` | Killed | Killed (condition operator) | Existing tests exercise the empty value. |
| `redact.ts:8`, `||` to `&&` | Killed | Killed | Existing tests exercise short values. |
| `redact.ts:8`, `<` to `<=` | Survived | Survived | No test at exactly the minimum length, 8. |
| `redact.ts:15`, `-` to `+` | Survived | Survived | No overlapping secrets to exercise replacement order. |
| `redact.ts:12`, remove regex end anchor | No such operator | Survived | Potentially equivalent for generated base64; inspect before adding a test. |
| `redact.ts:12`, remove regex repetition | No such operator | Survived | Existing input does not distinguish all padding lengths. |
| `redact.ts:12`, replace empty replacement string | No such operator | Survived | The existing test does not exercise the unpadded variant. |
| `redact.ts:15`, remove sorting | No such operator | Survived | Replacement order is untested. |
| `redact.ts:15`, comparator returns undefined | No such operator | Survived | Replacement order is untested. |

Other Stryker operators account for its remaining kills; the JSON report lists
all 22 mutants and their exact replacements. This task records the gaps;
changes to the product's redaction tests belong to their author and are not
part of this tooling patch.

Input hashes:

- Source: `f9d87665aa13d566d819f465d56bf325333f71444b263427bce309f2628b5e5d`
- Tests: `01c9dac1e1d6b376f0d0976c0413b6c16f22b605160b1bc536172f1ca81202a1`
