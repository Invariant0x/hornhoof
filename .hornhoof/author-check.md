# The author's check of this repository

One command checks what an author hands in, at an exact commit against its base. It is the `check:author` script in the root `package.json`, beside the test environment in `test-environment.json`. It uses that file's fast profile, suites and final checks. Task 325 owns it; `docs/author-check-port.md` describes the consumer of its result.

```sh
npm run -s check:author -- --sha <40 hex> --base <40 hex>
```

It checks only inside `run_tests`, which sets `HH_TEST_PART`, so no check uses the CPU of an agent's container. The clone of a run holds one commit and has no token, so a run cannot read the base. Run the command above outside `run_tests` first. It reads `git diff` and the complexity of the changed files at both commits, runs nothing else, and prints the line to give `run_tests`, with `--plan '<text>'` added: the changed paths and lines, and each function that is new or grew. The line has to fit the 4000 characters of a command, so a larger change goes without its lines, which leaves `changedLines` unknown, and one still too large is refused with `plan_too_long`. A plan not copied exactly is refused with `plan_invalid`: copy the printed line again. The plan comes from the author, and the run reads it only as far as its digest and commits; it stands in the run's command for anyone to compare. When the base can be read in the clone, the plan is not needed.

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
- A function of a changed file at 10 or more whose complexity did not grow does not fail: a `TOUCHED` line shows its numbers, and it stays out of `worstCrap`.
- Dryer never fails the check. Its findings are in `dryerFlags`.

Exit code 0 means nothing failed, 1 a stage failed, 2 it could not be judged: a wrong commit, no base and no plan, or a tool that did not run. Exit 0 with an unavailable stage is not a full pass: the consumer reads it as `partial`.

## What it prints

The tools write to the log as they run, with `STAGE <name> <status> exit=<n|null> secs=<n> reason=<code>` after each stage. The last line is `AUTHOR_CHECK <json>`: exactly `AuthorCheckInput` of `apps/server/src/modules/tasks/review-quality.ts` except what a command cannot know. It has no `runId` and each stage has `partId: null`; the backend adds them from its own records before it calls `recordAuthorCheck`. Null in `numbers` means unknown, never zero.

## Running when an author submits

Set `AUTHOR_CHECK=1` only when the head decides that submissions of this installation must run the check. It is off by default. A submit with `review.baseCommit` and `review.authorCheckPlan` then queues one `check:author` run on the exact branch commit captured by the server. The plan is the plain text printed by the command above, not a result or a trusted claim. A submit without that input keeps the old behavior, so projects without the adapter do not break.

The server puts the whole command on a machine chosen by the test-run pool. It runs no lint, types, tests, coverage, CRAP or dryer in the author's container. A branch moving before the run is pinned rejects the submission. Repeats and concurrent submits of the same task, commit and command reuse the run instead of creating another one.

The backend reads `AUTHOR_CHECK` from the completed part, supplies the run and part IDs from its own records and stores the result through `recordAuthorCheck`. `passed` and a nonfailed `partial` continue the existing submit with those exact statuses visible; neither is called a full pass. A failed or malformed result returns its output to the author. The first two failures return to the author, and the third goes to the head. Repeating a recorded outcome does not add an attempt or another run.

Until the setting is enabled, three real submissions and their elapsed time are not measured and remain `NOT_RUN`.
