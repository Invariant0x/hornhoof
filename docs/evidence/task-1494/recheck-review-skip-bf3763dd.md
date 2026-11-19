# Re-check of the Review-skip switch-off on bf3763dd

Task #1494, by Cypher. Checked commit: turn-39 at `bf3763dd63558f9ae74f436f0fcd795ee8c7f503` (#1484, Link).

## Verdict: PASS. Nothing blocks turn 39 on this point.

No path skips Review on this commit. The switch is one constant, `REVIEW_SKIP_ENABLED = false` (`apps/server/src/modules/tasks/author-check.ts:18`). Nothing reads it from the environment or from config, and nothing in the product sets it.

One note, not blocking: a route that still carries the old skip gives its Review to the wrong checker after a repair (path 7). No such route can exist on a server running this code, because no released server ever ran the skip. It matters when the skip is rebuilt.

## Probes from sec-1445-probes, run on bf3763dd

The probes were cherry-picked onto bf3763dd as scratch branch `sec-1494-probes`. The run output is attached as `security-1494-probe-run.txt`.

| Probe | Result on bf3763dd | Blocking? |
|---|---|---|
| `security-1445-echelons.test.ts` "after a Security repair" | Fails at its setup: Review is no longer skipped (`expected { stage: 'review', reason: null ... } to match { status: 'skipped' ... }`). The hole it tests cannot be reached on a new route. | No |
| `security-1445-echelons.test.ts` "after a Tests repair" | Same as above. | No |
| `security-1445-author-check.test.ts` "refuses a receipt when no test ran" | Still fails. It tests the node's receipt reader, which no decision reads now. | No |
| `security-1445-author-check.test.ts` "never turns a missing CRAP into 0" | Still fails, for the same reason. | No |
| `security-1445-author-check.test.ts` "F3: a whitespace change" | Still fails. Cherry-pick matching on the node is unchanged, but no decision reads it now. | No |
| `security-1445-author-check.test.ts` "F4: re-adding removed code" | Still fails, for the same reason. | No |
| `security-1445-stages.test.mjs` "F2: no test ran, CRAP 156" | Still fails. The check script's record and the node reader are unchanged, but no decision reads them now. | No |

The six evidence probes stay as regression tests for a future trusted skip. They must pass before any skip is turned back on.

## Paths that could skip Review

| # | Path | On bf3763dd | Blocking? |
|---|------|-------------|-----------|
| 1 | Handoff after Development | `reviewSkip` returns null while the switch is off (`author-check.ts:148`), so `submittedHandoff` takes the normal route to Review (`echelons-handoff.ts:44,52`). | No |
| 2 | Node receipt | A new request is refused (`author-check.ts:70`) before anything is sent to a node. A late `author_check.done` is ignored (`author-check.ts:101`, called from `nodes/messages.ts:334`). | No |
| 3 | Task tool | `check_author` stays registered (`tools.ts:742`). Its help says "Disabled", and a call is refused at `author-check.ts:70`. The `create_task` help no longer offers a skip. | No |
| 4 | Tests return | A return resets a skipped Review to pending (`echelons-tests.ts:100`). A Tests repair or a take of main at Tests routes through Review (`echelons-main.ts:109`). | No |
| 5 | Passing Tests report and acceptance | A route with the old skip reopens Review instead of going ready or done (`echelons-tests.ts:144`, `echelons-accept.ts:110`). | No |
| 6 | Completed-stage check | An old skip counts only for a route already done (`echelons-accept.ts:29`). That keeps accepted records readable. The other callers, documents and child acceptance of a parent (`echelons-document.ts:37,56`, `echelons-report.ts:119`), accept no new code through it. | No |
| 7 | A stale route with the old skip, after a Security or Tests repair | It goes back to Review (`echelons-handoff.ts:62`), but the Review owner is chosen by excluding only the repairer (`echelons-handoff.ts:95`, `echelons-candidates.ts:35-38`, `echelons-assign.ts:90`). An author who also holds the review skill can get it. New probe `security-1494-stale-route.test.ts` shows this. | No (see below) |
| 8 | Environment or config flag | None. The switch is a `const`, and no `process.env` value in the tasks module touches Review or the skip. | No |

**Why path 7 is not blocking.** A route can carry `author_check_passed` only if a server ran the #1217 code between d877a6a4 and bf3763dd. That code was only ever on the unreleased turn-39 branch. The live Hornhoof server this company runs has no `check_author` tool, and its `submit` help lacks the #1217 sentence, so it never ran that code. When turn 39 ships, it ships with the switch already off. This is an observation of the live server, not a database query.

**Fix for later**, when the skip is rebuilt: when a repair goes back to Review, exclude every producer in the candidate's chain, the Development author included, not only the repairer.

## Node and script evidence code

- The node's author check (`apps/node/src/author-check.ts`, `author-patch.ts`, the `authorComparison` part of `test-mirror.ts`) runs only on an `author_check.run` message (`apps/node/src/main.ts:479`). The server never sends one now (path 2). So it is dead from any decision, and its known weaknesses no longer matter for Review.
- `scripts/author-check.mjs` remains the author's own local check (T2 in AGENTS.md). Its record is advice to the author. No decision reads it.

## Commands

All of these ran on bf3763dd plus the probe files, on this machine. The full output is in the attached run file.

- `npm run -s build -w @hornhoof/protocol` and `npm run -s build -w @hornhoof/node`: exit 0.
- `npx vitest run --maxWorkers=1 apps/node/test/security-1445-author-check.test.ts apps/server/test/security-1445-echelons.test.ts apps/server/test/security-1494-stale-route.test.ts`: 3 files, 7 failed as described above, exit 1.
- `node --test scripts/test/security-1445-stages.test.mjs`: 1 failed, as described above, exit 1.
- `git grep` for `REVIEW_SKIP_ENABLED`, `AUTHOR_CHECK_PASSED`, `skippedAuthorReview`, `reviewSkip`, `requireAuthorReviewSkip`, `requestAuthorCheck`, `recordAuthorCheck` and `process.env` in `apps/server/src`, `apps/node/src` and `packages`: every decision use is listed in the table above.
