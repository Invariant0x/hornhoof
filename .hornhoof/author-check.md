# The author's check of this repository

One command checks what an author hands in, at an exact commit against its base. It is the `check:author` script in the root `package.json`, beside the test environment in `test-environment.json`. It uses that file's fast profile, suites and final checks. Task 325 owns it; `docs/author-check-port.md` describes the consumer of its result.

```sh
npm run -s check:author -- --sha <40 hex> --base <40 hex>
```

It checks only inside `run_tests`, which sets `HH_TEST_PART`, so no check uses the CPU of an agent's container. The clone of a run holds one commit and has no token, so a run cannot read the base. Run the command above outside `run_tests` first. It reads `git diff` and the complexity of the changed files at the base, runs nothing else, and prints the line to give `run_tests`, with `--plan <text>` added. The line has to fit the 4000 characters of a command, so a change too large for that is refused with `plan_too_long`. When the base can be read in the clone, the plan is not needed.

## What each stage does

| Stage | Command | Unavailable when |
| --- | --- | --- |
| `format` | `npm run -s format:check` | `repo_has_no_formatter`: this repository has no formatter today |
| `lint` | `eslint` on the changed files | `nothing_to_lint` |
| `types` | `finalChecks` of the touched suites, and `typecheck:tests` when TypeScript changed | `nothing_to_typecheck` |
| `tests` | the selection of `apps/node/src/test-impact.ts`, once per suite, with coverage of the changed sources in that same run | `nothing_selected`, `selection_is_whole_suite`, a problem of the selection |
| `crapper` | `crapper --use-existing-coverage` on the changed sources, so tests never run twice | `no_source_changed`, `no_coverage_adapter`, `no_coverage_measured`, `crapper_missing`, `crapper_failed` |
| `dryer` | `dryer` on the changed code | `no_source_changed`, `dryer_missing`, `dryer_failed` |

A suite run by neither Vitest nor `node --test` has no adapter: its whole package runs by its own one command from `test-environment.json`, its counts and CRAP stay unknown, and the record's scope says `package`.

A change the selector answers with the whole fast suite does not run it: `tests` says `selection_is_whole_suite`. Add `--allow-whole` only when you were asked to run everything. Documents outside `templates/` select nothing.

## What decides

- A function fails when its CRAP is 10 or more and it is new or its complexity grew over the base: a `FAILS` line shows its numbers.
- A function at 10 or more whose complexity did not grow does not fail: a `TOUCHED` line shows its numbers, and it stays out of `worstCrap`.
- Dryer never fails the check. Its findings are in `dryerFlags`.

Exit code 0 means nothing failed, 1 a stage failed, 2 it could not be judged: a wrong commit, no base and no plan, or a tool that did not run. Exit 0 with an unavailable stage is not a full pass: the consumer reads it as `partial`.

## What it prints

The tools write to the log as they run, with `STAGE <name> <status> exit=<n|null> secs=<n> reason=<code>` after each stage. The last line is `AUTHOR_CHECK <json>`: exactly `AuthorCheckInput` of `apps/server/src/modules/tasks/review-quality.ts` except what a command cannot know. It has no `runId` and each stage has `partId: null`; the backend adds them from its own records before it calls `recordAuthorCheck`. Null in `numbers` means unknown, never zero.
