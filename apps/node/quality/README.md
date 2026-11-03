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
