# Quality tool patches

`mutator-worker-modules.patch` applies to unclebob/mutator at the
`MUTATOR_COMMIT` pinned in `../Dockerfile`. The upstream code and this patch
are under its 0BSD license. This patch is maintained here; it has not been
submitted upstream.

The upstream worker copies the mutated module and its relative importers.
Vitest loads `setupFiles` without a source import. That bootstrap module
stays a symlink into the original tree, outside the worker's Vite root.
Vitest then fails before running any tests, and mutator counts the setup
failure as a kill.

For JavaScript and TypeScript targets, workers now copy all local JS/TS
modules, including configuration and bootstrap modules. Dependencies and
assets remain linked; build output and `node_modules` are not copied. Each
worker keeps its own files. Other languages retain the upstream module layout.
Additional bootstrap and importer copies retain their permissions. A test
can still launch a JS script through its shebang, and a private module does
not become readable to other users.
The image applies the patch before installing mutator and runs
`test_mutator_workers.py` before the quality stage can finish.

Use a scoped test command from the repository root, for example:

```sh
mutator apps/web/src/screens/Department.tsx --lines 325,553,565 \
  --no-coverage --mutate-all --max-workers 1 \
  --test-command 'cd apps/web && npx vitest run test/Department.test.tsx -t "lays out the gates|real rework" --maxWorkers=1'
```

The example's line numbers belong to turn 5; select the current changed
lines when checking another revision. This example intentionally bypasses
coverage to reproduce a known equivalent `useState(0)` to `useState(1)`
mutation. Normal task checks should reuse their scoped coverage report.

## Where a part of a run lies

crapper and dryer take a file for a test when any folder on its absolute path
is called `test`, `tests`, `spec`, `specs` or `__tests__`, and mutator asks
crapper. Under such a folder they find no source and still exit 0, which reads
like a clean result. A node therefore runs its parts in `<data>/runs/<part>`,
and these tools need no patch for it.

The image runs `test_part_paths.py` with each tool's own Python before the
quality stage can finish, and `../test/tests-run.test.ts` holds the path in that
file to the node's code. A clone of your own under such a folder still has this
problem.

## Prepared coverage for crapper

`crapper-coverage-report.patch` applies to unclebob/crapper at the pinned
`CRAPPER_COMMIT`, under the same 0BSD terms as `LICENSE.mutator`. It adds an
explicit LCOV input, in addition to upstream's `--use-existing-coverage`:

```sh
crapper --root . apps/node/src/load.ts --coverage-report path/to/saved.lcov
```

The path is relative to `--root`, or absolute. This reads only that report,
without invoking a coverage or test command. Missing, unreadable or empty
reports fail before writing metrics. The flag cannot be combined with other
coverage options. The caller owns the report's freshness and must supply the
report from the same source revision. The image checks both installed copies
of crapper, including the dependency installed with mutator.

## Honest mutator outcomes

`mutator-outcomes.patch` applies after `mutator-worker-modules.patch` to the
pinned `MUTATOR_COMMIT`, under `LICENSE.mutator`. It preserves the JS/TS
bootstrap-copy fix and adds unmutated checks in both the original project and
all worker overlays. A baseline check runs even when no mutations are selected.

Known zero-test summaries and configuration failures abort with exit 2 and a
reason. Unknown nonzero command failures also abort unless the output contains
a test-failure marker. A test assertion failure is `killed`; successful tests
are `survived`; sites outside coverage are `uncovered`; compiler/transform
failures are `compile_error`; command timeouts are `timeout`. Compilation errors
and timeouts have their own text columns and persisted counters, are excluded
from the killed/survived score, and make the CLI exit 2. Only surviving mutants
produce exit 3. For unrecognized test-runner summaries, fail closed on nonzero
exits; a silent successful custom command cannot prove how many tests ran.

Always run from the monorepo root with `--root .`, then scope the package's test
command. Snapshot version 2 discards cached outcomes from older tools, whose
stored killed outcomes predate these checks. The isolated
[Stryker pilot](stryker/README.md) records a reproducible comparison and guards
Stryker's incremental cache against helper/config/dependency/environment changes.
