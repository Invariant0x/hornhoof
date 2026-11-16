---
id: dev-test-environment
title: { en: "Product test environments", ru: "Тестовая среда продукта" }
description: { en: "Use when a product repository arrives or its dependencies, services, migrations or test runner change.", ru: "Используй при появлении репозитория продукта или изменении зависимостей, служб, миграций и запуска тестов." }
kind: procedure
sources: []
---
You can describe and verify the isolated environment needed for a project's checks.

**The first rule: we test our program, not the operating system and not other programs.** The environment exists so our tests run our code with the same result on any machine. It provides the services our code runs on, gives tests ports only from the project's narrow test port range, leaves nothing to machine speed or the clock, and never brings in another program only so a test can check or wait for its work.

**The second rule: time in a test is virtual only.** No test waits for or measures real time: not one deadline, wait or pause on the real clock, and no check of elapsed time. A test drives time with a controlled clock (fake timers or the code's injected clock), calls the step directly, or waits for an event or a state with no deadline; the runner's limit on a whole test is the only limit. A test gives the same verdict on any machine at any load.

Hornhoof brings a product's test harness up by itself: all a test needs before it starts, read from the repository's lock and build files, built once per architecture and kept on every machine, so any machine can test and no run installs or builds anything first. When one of its inputs changes, only what that input touches is built again. A failed update leaves the last good version in use, and the run on the broken commit says why. `test_harness` shows where it stands. A repository may hold several programs, in one language or many: each gets its own part of the harness and its own suite, so a changed lock file rebuilds that one.

A repository whose files do not say enough gets one versioned `.hornhoof/test-environment.json`, based on repository evidence. A proposed description, a schema-valid description and a working environment are three different results. Report which one was proved.

## Ownership

The task and employee assignment identify who owns the environment description, language choices, runtime provisioning and readiness proof. Skill selection does not fix those owners by role. The authorized product owner and assigned environment owner choose the product's languages from its requirements and repository evidence. Several programs may need different runtimes. Use the actual repository language/version declarations, including `.tool-versions` where present, and verify pinned runtime fingerprints on the machine that will run the check.

Approved preparation fetches tools once for each product and declared runtime fingerprint, then reuses its verified immutable artifacts for that scope. A changed version or preparation input invalidates that prepared version. Never infer that another product's runtime or a machine-global installation proves this environment ready.

Provision runtimes and services through the approved image or integration path. Keep immutable prepared artifacts separate from each attempt's private writable state, verify readiness and recovery after interrupted preparation, and route shared machine changes through their authorized owner. Do not patch running containers, mount host sockets or expose node credentials in product test code. A missing owner is an explicit task boundary, not permission to invent a new grant.

## Discover before describing

Read the repository, not just its README. Build a table of each finding, source paths, proposed commands and unproved capabilities:

| Evidence to inspect | What to establish |
| --- | --- |
| Build manifests, lockfiles, workspaces and install scripts | Language/runtime, dependency installation, all cache inputs and declared outputs. Inspect package/lock files, pyproject/requirements, go.mod/go.sum, Cargo manifests/locks or the project's equivalents. |
| CI workflows, compose.yaml and service configuration | Which profiles need which service, version, readiness check and isolated state. Compose is discovery evidence translated into an approved service driver, not permission to run a production stack. |
| Migration directories, journals, seeds and preparation scripts | Commands and complete input paths; whether they target a fresh database or support upgrading existing data. Record missing rollback support honestly. |
| Runner configuration, tests, imports and scoped fixtures | Test inventory, literal file selection or honest unshardable suites, timeouts, per-test/file reset and paths the import graph cannot see. |
| Environment-variable reads | Required variable names and their source. Keep secrets, credentials and production endpoints out of the file and evidence; service endpoints are generated per attempt. |

## Record the contract

Use the canonical `TestEnvironmentV1` parser and examples supplied by the runtime. Do not create a second schema. If that parser is unavailable, keep a source-backed proposal and report validation as pending.

Record `version: 1`, runtimes, explicit `defaultProfile` referring to a top-level `profiles[].id`, and these sections:

- `dependencies`: one object with adapter, inputs, install commands, paths and cache policy. Include locks, workspace manifests and every install/generation input. `cache: "link"` gives every part read-only links to one stored tree, which suits a tree its tests never write into; `cache: "copy"` gives each part its own. With no frozen lock, incomplete inputs or an unverified relocation adapter, use `cache: "none"`; blindly copying a virtual environment is not prepared dependencies.
- `services`: a required array of profile-scoped service definitions. `services: []` is valid for a product without services and requests none. Missing services is not equivalent to an empty array.
- `prepare`: units with id, profiles, serviceIds, inputs, commands and artifacts. Include migrations, scripts, journals, seeds and configuration. Share immutable prepared versions, with a private writable state per attempt; publish only after readiness, successful preparation and stopped writers.
- `reset`: null or a nonempty array of suite-scoped entries with scope, command and inputs. When the runner fixture performs reset, record an entry with its test/file scope, `command: null` and that fixture's path in inputs; the lack of a standalone reset command does not mean there is no reset. Use `reset: null` only when no reset is needed; an empty array is invalid. The node isolates parts. Prove the fixture's behavior instead of assuming that truncate undoes schema, role or background-process changes.
- `suites`: root, tracked file globs, run command and profile eligibility. The profile's requiredSuiteIds must reference eligible suites. Record `split` as `{kind: "argv-files"}`, `{kind: "json-file"}` or `{kind: "whole-package"}`, replacing the earlier selection field. Inventory paths are repository-relative; argv and JSON file entries are passed relative to run.cwd. JSON-file mode receives its file path in `HH_TEST_FILES`; prevent filenames from becoming command-line flags. Prove disjoint parts whose union equals the required inventory. Each suite's `finalChecks` are commands run at the assigned full-validation stage after its required parts on that same commit. They are not a second list of required suites or another planner.
- `impact`: map migrations, schema, runner/CI/service configuration and other paths outside reliable import edges to their full affected suites. Unknown mappings select the package, not an empty set.
- `execution.fullRun`: `{replaces, profile}` turns on reusing green results. A test file whose fingerprint (the file, the code it reaches, what `impact` takes whole for its package, the environment) has a green result does not run again; a run that asks for `profile` by name reuses nothing, and every release runs one on its exact commit. Keep an `everyTurns` number a manifest already has: servers before 0.24.0 require it, and nothing runs by it. `replaces` and `profile` take a result only from the repository's main branch or the turn's, or from a commit the main branch holds now, as a job writes its own report; other profiles take what any branch proved. Without it everything always runs, as nothing would check what was reused. `profile` must hold every suite of `replaces`. A result holds across the profiles of its suite, so tests that read a service belong in a suite of only the profiles that open it. `finalChecks` run whatever was reused, as no test file proves them.
- Per-file results: a suite's runner may write `{"files": [{"file", "status": "passed" | "failed", "ms"?, "note"?}]}` to the file `HH_TEST_REPORT` names, each file absolute or from the repository root, so the passing files of a failed part stay green and a one-line `note` stays with the result. A runner that writes none is judged by its exit, and a failed suite that names no failed file proves nothing of its files.
- `suite.scenarioSources`: for a suite of scenarios that drive screens, the folder of those screens. A scenario opens the app and may pass any screen on the way, so it follows all of them: a change of any screen runs every scenario again. Give a source every scenario passes through to the suite through `impact`, and keep languages, themes and widths in a suite only the full profile runs.
- `suite.keep`: paths under the checkout a suite leaves for its next run, as an incremental tool's memory. They hold text, stay under the size limit, are restored before anything of the part runs and never reach a full run. Only a run of the main branch or the turn's leaves them. Parts of a run merge by file, so a file a suite removes comes back: a tool overwrites what it no longer wants.
- `mutation`: use `status: "supported"`, language, tool and the explicit plan below, or only `{status: "unsupported", language, reason}` with a nonempty honest reason when that language has no configured tool. Do not fabricate commands for the unsupported branch. A configured tool missing from a machine is a runtime capability gap, not unsupported language support.

Commands are `{program, args, cwd}`; cwd and input/output paths stay within the checkout's declared boundaries. Pass selected files as literal arguments or JSON, without shell interpolation. Do not invent nested contract shapes or claim validation against an unpublished parser.

## Mutation scope

Describe mutation work here when the task requires it; only its assigned check owner executes it. Select risky **pure logic modules** and their **fast unit tests**, requiring no database, browser, network or external service. Inspect imports and fixture scope before calling a test pure.

For Python, JavaScript/TypeScript, Go, Rust, Java and Clojure, read the installed mutation tool's documentation and source to establish the adapter command. For other languages, ask the assigned project owner for the configured tool or record unsupported with its reason. A test runner alone is not a mutation tool.

To run mutation in the final check without a person starting it, add a suite whose `files` equal `sourcePaths`, with a runner that writes the per-file report above, says killed and survived in a `note`, fails a file only when the tool cannot judge it and keeps the tool's memory through `suite.keep`. A tool's memory may skip its check of the tests, so run them first and judge a file whole when its tests changed. Such a unit's fingerprint reads the file's own text and the fast tests that reach it, so a file nobody changed keeps its last result.

Record `sourcePaths`, `fastTestPaths`, `coverageCommands`, `coverageFiles` and the mutation `command`. Both coverage generation and baseline/mutant execution must use the **same selected pure test scope**, never the full database/browser/network suite. A test-command flag alone may leave an automatic coverage phase running the full suite: verify the tool's coverage behavior too. Generate fresh successful coverage reports bound to the candidate commit and exact source/test selection, then require their reuse or an explicitly narrowed coverage command. Stale or missing reports fail preparation. Keep coverage enabled and required fixtures intact; neither disabling coverage nor removing a fixture to make a test look pure is valid.

For example, after inspecting a Python project, a literal `python3 -m pytest tests/unit/test_totals.py` selection can keep DB-scoped fixtures outside collection. Its coverage command must select that same file and its chosen source module; `python3 -m pytest tests` is a different scope. Confirm this from the project's actual collection and the installed tool, rather than copying the example as a default.

## Validate, execute and maintain

1. Check IDs/profile references, paths, command arguments and source evidence with the canonical parser. List missing runtime, adapter, lock, reset or schema capabilities; do not mark the environment ready while required capabilities are missing.
2. On an eligible machine for an assigned environment-readiness or release-assembly check, run preparation and readiness, the required full/profile checks and literal subsets (contributors on individual feature, bug or turnkey task branches check only named test files locally without calling `run_tests`, while full-suite `run_tests` runs once per release candidate on the combined release branch before main). Check partition counts and reset contamination using the real service. A project without services keeps the same test command and requests no service. Record the exact commit, commands, exit codes, counts and artifacts; a skipped or zero-test required lane is a gap.
3. Update the description when dependencies, service/runtime versions, schema/migrations/seeds, preparation/reset inputs or the test runner change. Such inputs invalidate the relevant prepared version; ordinary source/test-only changes do not rebuild it. Never allow a consumer's writable copy to change a shared prepared artifact.
4. Submit the evidence table and readiness gaps to the head. Operations verifies image/service readiness through approved provisioning, without host sockets or node credentials in product test code. Recheck the description when a new repository or product arrives; existing staffing defaults do not establish ownership by themselves.
