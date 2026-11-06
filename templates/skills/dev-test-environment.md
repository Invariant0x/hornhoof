---
id: dev-test-environment
title: { en: "Product test environments", ru: "Тестовая среда продукта" }
description: { en: "Use when a product repository arrives or its dependencies, services, migrations or test runner change.", ru: "Используй при появлении репозитория продукта или изменении зависимостей, служб, миграций и запуска тестов." }
kind: procedure
sources: []
---
Own one versioned `.hornhoof/test-environment.json` per product, based on repository evidence. A proposed description, a schema-valid description and a working environment are three different results. Report which one was proved.

## Ownership

- **DEV-TEST** owns discovery and maintenance. When no DEV-TEST is assigned, **DEV-QA** owns them. **DEV-HEAD** assigns one owner on the first turn of every new product or repository, including a new company; when neither role exists, the head creates the first task to establish ownership. The head also arranges a mutation command for a language without the default tool.
- **OPS-INTEG** provisions pinned runtimes and services through the approved image or integration path. **OPS-FIX** verifies readiness, private mutable state and recovery after interrupted preparation. **OPS-HEAD** owns machine readiness, capacity, storage and recovery. Request shared changes through the head, without hand-editing running containers.

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

- `dependencies`: one object with adapter, inputs, install commands, paths and cache policy. Include locks, workspace manifests and every install/generation input. With no frozen lock, incomplete inputs or an unverified relocation adapter, use `cache: "none"`; blindly copying a virtual environment is not prepared dependencies.
- `services`: a required array of profile-scoped service definitions. `services: []` is valid for a product without services and requests none. Missing services is not equivalent to an empty array.
- `prepare`: units with id, profiles, serviceIds, inputs, commands and artifacts. Include migrations, scripts, journals, seeds and configuration. Share immutable prepared versions, with a private writable state per attempt; publish only after readiness, successful preparation and stopped writers.
- `reset`: null or a nonempty array of suite-scoped entries with scope, command and inputs. When the runner fixture performs reset, record an entry with its test/file scope, `command: null` and that fixture's path in inputs; the lack of a standalone reset command does not mean there is no reset. Use `reset: null` only when no reset is needed; an empty array is invalid. The node isolates parts. Prove the fixture's behavior instead of assuming that truncate undoes schema, role or background-process changes.
- `suites`: root, tracked file globs, run command and profile eligibility. The profile's requiredSuiteIds must reference eligible suites. Record `split` as `{kind: "argv-files"}`, `{kind: "json-file"}` or `{kind: "whole-package"}`, replacing the earlier selection field. Inventory paths are repository-relative; argv and JSON file entries are passed relative to run.cwd. JSON-file mode receives its file path in `HH_TEST_FILES`; prevent filenames from becoming command-line flags. Prove disjoint parts whose union equals the required inventory. Each suite's `finalChecks` are commands run once, only on the final turn candidate, after all its parts on that same commit. They are not a second list of required suites or another planner.
- `impact`: map migrations, schema, runner/CI/service configuration and other paths outside reliable import edges to their full affected suites. Unknown mappings select the package, not an empty set.
- `mutation`: use `status: "supported"`, language, tool and the explicit plan below, or only `{status: "unsupported", language, reason}` with a nonempty honest reason when that language has no configured tool. Do not fabricate commands for the unsupported branch. A configured tool missing from a machine is a runtime capability gap, not unsupported language support.

Commands are `{program, args, cwd}`; cwd and input/output paths stay within the checkout's declared boundaries. Pass selected files as literal arguments or JSON, without shell interpolation. Do not invent nested contract shapes or claim validation against an unpublished parser.

## Mutation scope

Describe mutation work here; the testing gate alone executes it. Select risky **pure logic modules** and their **fast unit tests**, requiring no database, browser, network or external service. Inspect imports and fixture scope before calling a test pure.

For Python, JavaScript/TypeScript, Go, Rust, Java and Clojure, read the installed mutation tool's documentation and source to establish the adapter command. For other languages, ask DEV-HEAD for the configured tool or record unsupported with its reason. A test runner alone is not a mutation tool.

Record `sourcePaths`, `fastTestPaths`, `coverageCommands`, `coverageFiles` and the mutation `command`. Both coverage generation and baseline/mutant execution must use the **same selected pure test scope**, never the full database/browser/network suite. A test-command flag alone may leave an automatic coverage phase running the full suite: verify the tool's coverage behavior too. Generate fresh successful coverage reports bound to the candidate commit and exact source/test selection, then require their reuse or an explicitly narrowed coverage command. Stale or missing reports fail preparation. Keep coverage enabled and required fixtures intact; neither disabling coverage nor removing a fixture to make a test look pure is valid.

For example, after inspecting a Python project, a literal `python3 -m pytest tests/unit/test_totals.py` selection can keep DB-scoped fixtures outside collection. Its coverage command must select that same file and its chosen source module; `python3 -m pytest tests` is a different scope. Confirm this from the project's actual collection and the installed tool, rather than copying the example as a default.

## Validate, execute and maintain

1. Check IDs/profile references, paths, command arguments and source evidence with the canonical parser. List missing runtime, adapter, lock, reset or schema capabilities; do not mark the environment ready while required capabilities are missing.
2. On an eligible machine, run preparation and readiness, the required full/profile checks and literal subsets. Check partition counts and reset contamination using the real service. A project without services keeps the same test command and requests no service. Record the exact commit, commands, exit codes, counts and artifacts; a skipped or zero-test required lane is a gap.
3. Update the description when dependencies, service/runtime versions, schema/migrations/seeds, preparation/reset inputs or the test runner change. Such inputs invalidate the relevant prepared version; ordinary source/test-only changes do not rebuild it. Never allow a consumer's writable copy to change a shared prepared artifact.
4. Submit the evidence table and readiness gaps to the head. Operations verifies image/service readiness through approved provisioning, without host sockets or node credentials in product test code. Recheck the description when a new repository or product arrives; existing staffing defaults do not establish ownership by themselves.
