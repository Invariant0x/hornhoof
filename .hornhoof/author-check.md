# The author's check of this repository

One command checks what an author hands in, at an exact commit against its base. It is the `check:author` script in the root `package.json`, beside the test environment in `test-environment.json`. It uses that file's fast profile, suites and final checks.

```sh
npm run -s check:author -- --sha <40 hex> --base <40 hex>
```

It runs where it is called: in the workspace of whoever builds or reviews the change, with `--sha` checked out (`sha_mismatch` otherwise) and `--base` in the local history (`base_unreachable` otherwise: fetch it). It installs from the lockfile when `node_modules` is missing. It builds the protocol and the node again whenever the files they are built from changed since their last build, which `dist/.built-from` records, so a workspace used for another branch never checks with an old build. It reads `git diff` and the complexity of the changed files at both commits, then runs the stages below on what the change touched.

## What each stage does

| Stage | Command | Unavailable when |
| --- | --- | --- |
| `format` | `npm run -s format:check` | `repo_has_no_formatter`: this repository has no formatter today |
| `lint` | `eslint` on the changed files | `nothing_to_lint` |
| `types` | `finalChecks` of the touched suites, and the steps of `typecheck:tests` for the projects TypeScript changed in and those that use them, after its builds; all of it for a typed file outside every project | `nothing_to_typecheck` |
| `tests` | the near tests of the selection of `apps/node/src/test-impact.ts`, once per suite, with coverage of the changed sources in that same run | `nothing_selected`, `selection_is_whole_suite`, a problem of the selection |
| `crapper` | `crapper --use-existing-coverage` on the changed sources, so tests never run twice | `no_source_changed`, `no_coverage_adapter`, `no_coverage_measured`, `crapper_missing`, `crapper_failed` |
| `dryer` | `dryer` on the changed code | `no_source_changed`, `dryer_missing`, `dryer_failed` |

A suite run by neither Vitest nor `node --test` has no adapter: its whole package runs by its own one command from `test-environment.json`, its counts and CRAP stay unknown, and the record's scope says `package`.

A change the selector answers with the whole fast suite does not run it: `tests` says `selection_is_whole_suite`, unless a shared package changed. Add `--allow-whole` only when you were asked to run everything. A document outside `templates/` leads nowhere in the import graph, but a test may read it by its path: the tests of the fast profile that name its path themselves run, found by the graph the fingerprints follow, the rest that reach it through the code they run are left to the full run, and a document no test reads says `document without tests`.

## What a change runs

The selection goes by the paths a change touches, and within a package by the import graph. The author's check runs, with coverage, the tests that import a changed file directly, are named after a changed source, or changed in the commit. The rest of the tests the import graph reaches are listed by file in its record as left to the full run of the release. A package none of whose tests reaches the change directly runs all the graph reaches there. The list is `scope.leftToFullRun` of the record and `leftToFullRun` of `TEST_SELECTION`, so a reviewer sees what the author did not run. A test that imports a file of another group runs when that file changes, and nothing else crosses a group. A commit that mixes code with a file of a rule that takes packages whole takes the packages of that code whole too; a rule that names its tests adds only them. A Vitest suite gets its files as on a node, through `HH_TEST_FILES` and `--shard=1/1`, because its config asks for both.

| Group | Paths | Runs |
| --- | --- | --- |
| Backend | `apps/server` | `server` by the graph; routes, configuration and fixtures take it whole |
| Frontend | `apps/web` without `e2e` | `web` by the graph; strings and configuration take it whole |
| Node and terminals | `apps/node` | `node` by the graph |
| Shared protocol | `packages` | every suite of the fast profile, whole, without `--allow-whole`; its own tests only `protocol`, its fixtures also the one `server` test that reads them |
| Database | `apps/server/drizzle`, `apps/server/src/db/schema.ts` | `server` whole; a test of `server-postgres` runs no suite here: `NOTE runs in the final profile` says so |
| The selection itself | `apps/node/src/test-impact*.ts`, `apps/node/src/test-environment.ts`, `apps/node/src/test-fingerprint.ts` | `node` and `release-scripts`, whole |
| Templates and skills | `templates` | only the tests of `server` and `node` that read them, named by the rule |
| Browser scenarios | `apps/web/e2e`, and the `.tsx` and `.css` files under `apps/web/src` | no suite: `NOTE browser scenario` names a changed scenario and those named after a changed screen, to look at first, and says so when a screen has none; a release runs every scenario again when any screen changed, as a scenario may pass any screen |
| Build and release | `.github/workflows`, `scripts/install.sh`, `scripts/install.ps1`, `apps/updater`, `Dockerfile`, `compose.yaml`, `.dockerignore` | `release-scripts` and `server`, whole |
| Everything | `package.json`, the lockfile, `tsconfig.base.json`, `eslint.config.js`, the test environment, the Vitest configs | `selection_is_whole_suite`, until `--allow-whole`, also beside a change of the protocol |

The rules are `impact.fullPackageGlobs` of `test-environment.json`: a rule names who reads a file that belongs to no one package, in place of the default that takes everyone. A rule names suites, which then run whole, or with `tests` only the test files of those suites that read the file. Templates are text the server and the node read while they run, so their rule names the tests that read them; any other test that depends on them runs in the whole suite of the turn. `scripts/test/test-groups.test.mjs` holds the rules to the real graph, and holds the readers of the templates to the tests the rule names. A check names scenarios and does not run them: a run is not given `PLAYWRIGHT_BROWSERS_PATH`, and not every machine has `/data/browsers`. On a machine that has it, a scenario runs in `apps/web` by `PLAYWRIGHT_BROWSERS_PATH=/data/browsers npx playwright test e2e/<name>.spec.ts`. The `browser` suite runs them at the release. A source that mutation lists keeps its own tests here; only its mutants wait for the release.

## What decides

- A function fails when its CRAP is 10 or more and it is new or its complexity grew over the base: a `FAILS` line shows its numbers.
- A function of a changed file at 10 or more whose complexity did not grow does not fail: a `TOUCHED` line shows its numbers, and it stays out of `worstCrap`.
- Dryer never fails the check. Its findings are in `dryerFlags`.

Exit code 0 means nothing failed, 1 a stage failed, 2 it could not be judged: a wrong commit, no base, or a tool that did not run. Exit 0 with an unavailable stage is not a full pass: the consumer reads it as `partial`.

## What it prints

The tools write to the log as they run, with `STAGE <name> <status> exit=<n|null> secs=<n> reason=<code>` after each stage. The last line is `AUTHOR_CHECK <json>`, the record of the check. It has no `runId` and each stage has `partId: null`: the record is for whoever ran the command, and the server stores none. Null in `numbers` means unknown, never zero.

## Nothing runs on submit

Submitting a task starts no test run. The author runs this command in their own workspace before submitting, and the reviewer runs it in theirs. Every test runs together once per release, through `run_tests` on the turn's branch or a release branch before main, or on main.

## On GitHub

The tests of `.github/workflows/images.yml` use this selection too, for a commit no passed run marked with `hornhoof/tests`. Its first job looks for the nearest commit whose tests passed: from the tip a push moved, the base of a pull request, or the commit a run by hand left main at, up to 20 commits back along the first parents. It then runs only the tests the change since that commit reaches, in as many parts as they fill, up to four, with the lint of the files the change left, the types and the release checks. A change the selection cannot judge, one that takes every suite whole, no such commit, or a choice that fails runs the whole suite in four parts, as before.

Such a run proves the commit as the whole suite does: every test it left out passed on the commit it stood on, on the same files. The `hornhoof/tests` mark it leaves names that commit, so another run of the same commit, the push to main after a run by hand, skips the tests.
