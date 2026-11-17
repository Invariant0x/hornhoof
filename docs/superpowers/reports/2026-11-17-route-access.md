# Task 1196: route declarations and agent views

Base: `9fe737f21ee6f4caf2c0cad80c086cfe791fdb79` on `turn-31`.
Final integration base: `359c2efaa27e9afb8842d0113dd5d6804aca467c`, merged cleanly.
Checked implementation: `3b51c49fdc0f7a29580de6ffe87550511a886a63`.
Bug fix with fixture optimization authorized by the head, access risk. No handler or production access policy changes.

The route audit must recognize `attachmentJobOf` on the upload route instead of
requiring the older `jobOf` call. The attachment permission remains tied to the
live job, agent, node and task. An own-task upload returns 201; using the same
permission for another task or a task in another company returns 403.

The current base has eleven missing routes, including the contacts route added
after the original list of ten. The head confirmed all eleven are in scope.

1. `GET /api/phones`: company phone inventory, without agent identities or task
   content; the connection address is visible only to the phone owner. List category.
2. `GET /api/phones/:id`: company-scoped phone metadata; another company gets
   403, and the connection address is visible only to the phone owner. Elsewhere,
   under the phone tests.
3. `POST /api/phones/probe`: a human or the orchestrator probes a machine of their
   company; a head acting through a person is refused. No agent or task data
   category.
4. `POST /api/phones`: a human or the orchestrator registers a phone on a machine
   of their company; a head acting through a person is refused. No agent or task
   data category.
5. `POST /api/phones/:id/stop`: the signed-in phone owner or the orchestrator
   acting for the CEO stops lending;
   this returns phone state, without agent identities. No agent or task data
   category.
6. `POST /api/phones/:id/resume`: the signed-in phone owner or the orchestrator
   acting for the CEO resumes lending, under the same company boundary. No agent
   or task data category.
7. `GET /api/phones/:id/live`: the signed-in phone owner or the orchestrator
   acting for the CEO reads the latest frame metadata. Elsewhere, under the phone
   and recording tests; not a public phone list.
8. `GET /api/phones/:id/live/image`: the same phone-owner or orchestrator check
   protects the live image. Elsewhere, under the phone and recording tests.
9. `GET /api/tasks/:id/phone-recordings`: a visible task of this company, with
   recordings filtered to agents the viewer can open. Elsewhere, under the
   recording tests.
10. `GET /api/phone-sessions/:id/frames/:sequence/image`: the recording belongs
    to this company, its task is visible and its agent is reachable. Elsewhere,
    under the recording tests.
11. `GET /api/outbound/contacts`: addresses belong only to the selected department
    of this company, for its owner, the CEO or delegate, or the orchestrator acting
    for the CEO. Its head may act on the
    word of an authorized person inside its own department. Another department's
    owner gets 403; a head acting outside its department gets 404. Elsewhere,
    under `outbound-department-access.test.ts` and `outbound-department.test.ts`.
    This entry grants no access beyond `manageDepartment` and `requireRunner`.

Requirement checks: `route-access.test.ts` covers complete access declarations;
`agent-view-table.test.ts` covers complete route placement and the phone list;
`attachment-token.test.ts` covers own-task uploads and the 403 task/company
boundaries. Neighboring attachment and task-file tests preserve existing upload
and download behavior.

The two requested baseline checks failed for the expected reasons on the original
base: the table listed these eleven missing routes, and the route audit reported
`POST /api/attachments` without an access declaration. The targeted run exited 1
after executing both checks. Its other cases were excluded by the name selector.
An earlier broad baseline run was stopped without a result. The original-base
server build passed. Final checks must use the merged candidate.

## First checks before fixture optimization

Historical status: the first candidate was blocked on the required green result of the whole agent-view table file.
This records the first checked version. The head subsequently expanded task 1196
to diagnose and reduce fixture cost while preserving every access case.
Checked code: `8e77035fe905f9860440bcbb91059b53d707e5ea`.
That first candidate stayed on `task-1196`; it was not pushed to `turn-31`.

Executed checks on that code:

- `npm run build -w @hornhoof/server`: exit 0.
- `npm run -s check:author -- --sha 8e77035fe905f9860440bcbb91059b53d707e5ea --base 734fe6637056b022d506c8049a7d1c6e07dd8afe`:
  lint passed, server types including tests passed, dryer passed with no duplicate
  candidates. The selected tests executed: route-access passed 4 of 4;
  attachment-token passed 9 of 9, including own-task upload and foreign-task and
  foreign-company 403 responses. Agent-view-table passed 55 of 58, with three
  20-second timeouts: table completeness, GET agent and PATCH agent. Thus the
  author's check exited 1; it is not an overall PASS.
- `npx --no-install vitest run test/agent-view-table.test.ts --maxWorkers=1`,
  alone after the other own checks ended: exit 1, 43 passed, 15 failed, all
  20-second timeouts. Table completeness passed in 10.606 seconds and the new
  phone list passed in 10.193 seconds. The failures were twelve existing agent
  detail/actions and the turns, current-turn and subscriptions lists. Start:
  2026-11-17 02:38:53 UTC, shared machine load averages 16.09 / 19.76 / 27.68;
  total runner duration 882.41 seconds. Full output: task attachment
  `table-alone.log`.
- `git diff --exit-code 734fe6637056b022d506c8049a7d1c6e07dd8afe 8e77035fe905f9860440bcbb91059b53d707e5ea -- apps/server/src apps/server/test/task-files.test.ts apps/server/test/request-media.test.ts apps/server/test/program-operator-attachments.test.ts apps/server/test/helpers-db.ts`:
  exit 0, empty output. The neighboring runtime and tests match the base.

## Neighboring checks

Command: `npx --no-install vitest run test/task-files.test.ts test/request-media.test.ts test/program-operator-attachments.test.ts --maxWorkers=1`.
Exit 1 on the checked code, 21 passed and 14 failed. Every test failure was
`Test timed out in 20000ms`; there was no content assertion or server error.
Full output and stacks are attached to task 1196 as `neighbors-merged.log`.

`task-files.test.ts`, one timeout:

- `downloads a file of several megabytes whole`: 26.329 seconds, limit 20
  seconds, at line 100. This is a base failure unrelated to the declaration
  change. Its stack is also attached as `task-files-timeout.log`.

`program-operator-attachments.test.ts`, six timeouts:

- `downloads the case PNG for its assigned operator, actual report recipient and current orchestrator after resolution`
- `refuses the target, workers outside the program operator and the head of Operations, and foreign jobs with the same generic 404`
- `checks the operator current role, Operations department and enabled state, and lets Operations read a case given to another`
- `checks the report recipient is still the target department head and rejects removed or switched off readers`
- `accepts only the exact case and PNG attachment identity with bounded bytes`
- `shows pictures of a program on an API key and refuses those of login and test turns`

`request-media.test.ts`, seven timeouts:

- `takes a picture from a running turn and refuses anything else`
- `refuses a picture a person sent the agent: it stays in that conversation`
- `shows the pictures of a question to the people who reach its task, and to nobody else`
- `refuses another agent's picture and one already shown`
- `never shows a file put on a task as a picture`
- `lets a person pick one of a few ways, and wakes the agent with the pick`
- `refuses a choice with one way, or with a commit`

The first request-media case also had a 10-second `onTestFinished` hook timeout
in `helpers-db.ts`, line 280. That file is a fixture helper, not another test
file. None of these fourteen base failures is caused by this change.

## Historical check limits

The head accepted the fourteen baseline timeouts with the unchanged runtime and
neighbor tests on `8e77035fe905f9860440bcbb91059b53d707e5ea`, but the table's
single-file failures prevented integration. The head expanded this task to fix
fixture cost; the following sections describe that authorized work. No limits
were raised and no access checks were removed or weakened.

The original selector had no import graph. The final selector keeps named near
readers and leaves the remaining inventory to the release owner's full run. No
full suite or `run_tests` is started by this task. There is no configured formatter;
CRAP and mutation of production code do not apply because none changed.
`codex review` could not run because bwrap could not create a namespace. Manual
diff and security review are performed; there is no automated review PASS.

## Fixture profile and implementation plan

The existing JSON test metadata attributed 33.565 of 37.360 seconds and 23.580 of
25.649 seconds to database/application setup in two selected slow cases. A
temporary diagnostic split of that existing setup timer measured a cold case at
4.394 seconds: database opening 3.553 seconds, application construction 0.755
seconds. The next case used 0.071 seconds for database reset/opening and 0.147
seconds for application construction; its remaining 2.302 seconds included the
ACL company setup and twelve access requests. The diagnostic fields were removed
after the profile; no test asserted on elapsed time.

The database is already shared within a file and starts from the run's migrated
dump. Migrations do not run for every test. A timeout discards the shared database,
so later cases can pay the cold opening cost again. The ACL company additionally
repeats five invitation/password operations and its department, plan and crew rows
in every case. Each list repeats the tasks, approvals, notes, jobs and runs of all
eight crew members. The existing row-fixture mechanism currently caches only the
initial company setup underneath these repeated operations.

Keep the current per-test app, database cleanup, fencing, schema checks and late
write protection. Separate the ACL company's serializable rows from functions
bound to the current app; restore those rows through the existing `appFixture`
mechanism. Cache the busy company's serializable task map by that same mechanism.
Rebind `work` and `get` to each fresh app. The row cache stores no app, connection or function; each case keeps its own app,
guarded database handle and mutable descriptors, and it changes no production handler, access
assertion, actor combination or timeout. This first fixture version left shared
`helpers-db.ts` unchanged.

Verification required by the head: each of agent-view-table and route-access
alone three consecutive times, with a shuffled table run proving case isolation;
record load 1m, build, server/test types and ESLint. The original protected checks
stay in place. If shared database helpers need a further change, also execute the
three named neighboring test files and repair only failures with the same cause.

The integration base advanced to `a27bc368b1e027af70883d06d1da9ba2b07985ab`.
It changes the protocol, lockfile and server code, so the required final series
will be run again on the merged candidate after dependency preparation. Earlier
shuffled table runs on `78eb832fa28d65b96589723039fd94b13eb5eebe` all passed
58 of 58 at seeds 1196, 1197 and 1198, with start load 1m 11.91, 10.29 and 13.05.
Their runner durations were 50.41, 25.27 and 74.14 seconds. The test inventory and
all assertion bodies are byte-for-byte unchanged from the first checked code.

## Cold database preparation

On the merged `153730a14d4ea4413ee60f01c25bc10a5efd54a7` at start load 1m
37.41, the shuffled table passed 57 of 58. The first busy-company case timed out
at 30.018 seconds: 17.768 seconds were database/application setup, with the
remaining 12.250 seconds including first fixture construction and requests.
The completed row cache removes repeated work, but that first case still paid
for both the immutable database description and the busy dataset.

Prepare the immutable catalog fingerprint, planner baseline, foreign-key map and
binary seed description alongside the migrated dump in global setup. A worker
validates the description's version and dump hash before opening a database and
uses that exact description for its copy. The original catalog SQL, row reset,
planner reset, schema-change check, per-test closed handle and failure cleanup
are retained. The new description is generated per run, not accepted as an
unversioned persistent cache. No test or hook timeout changes.

The existing global-setup boundary tests first failed because only the dump path
was provided, without its description. They now execute three green cases:
validated template, standalone fallback, and publishing neither path after a
description failure. Three pure codec checks preserve binary seed bytes and
large sequence values, and reject a foreign dump or unsupported version. The
42 existing shared-database cases remain unchanged and green, including their
two intentional expected-failure cases. They still detect lost rights, changed
schema/statistics, stale rows and late writes. An omitted import during the
extraction was caught by these checks and fixed before the candidate was sent.

Because this change touches shared `helpers-db.ts`, the final checks also include
task-files, program-operator-attachments and request-media by name, as required by
the expanded brief. The full release suite remains with the release owner.

## Final verification

The required final six runs executed on the checked implementation, with one
worker and no other own checks running. All 58 table cases and all assertion
bodies are unchanged; only the fixture setup and the eleven route placements
changed. All six JSON reports have `success: true` and zero failed tests. Full
outputs, start times, commit and machine load are attached as `six-runs.log`.

- `agent-view-table.test.ts`: 58 passed, runner 24.23s, start 2026-11-17T04:16:39.329006+00:00, load 1m 9.61, shuffled seed 1196.
- `agent-view-table.test.ts`: 58 passed, runner 21.99s, start 2026-11-17T04:17:21.634255+00:00, load 1m 9.12, shuffled seed 1197.
- `agent-view-table.test.ts`: 58 passed, runner 22.17s, start 2026-11-17T04:17:52.869140+00:00, load 1m 8.57, shuffled seed 1198.
- `route-access.test.ts`: 4 passed, runner 9.58s, start 2026-11-17T04:18:24.978024+00:00, load 1m 8.50.
- `route-access.test.ts`: 4 passed, runner 8.66s, start 2026-11-17T04:18:39.862924+00:00, load 1m 8.11.
- `route-access.test.ts`: 4 passed, runner 7.71s, start 2026-11-17T04:18:57.855256+00:00, load 1m 7.73.

Commands: `npx --no-install vitest run test/agent-view-table.test.ts --maxWorkers=1
--sequence.shuffle --sequence.seed=1196` (then seeds 1197 and 1198, separate runs),
and `npx --no-install vitest run test/route-access.test.ts --maxWorkers=1` three
separate times. Default and JSON reporters were recorded for every run.

Author command: `HH_VITEST_MAX_WORKERS=1 npm run -s check:author -- --sha
3b51c49fdc0f7a29580de6ffe87550511a886a63 --base
359c2efaa27e9afb8842d0113dd5d6804aca467c`. Actual exit: 1. Lint, server and
node types including tests, and dryer passed; dryer found no duplicate candidates.
The selected inventory was one named node file and 49 named server files, not a
whole suite. The remaining 664 reached files were explicitly left to the release
owner. Node passed 59 of 59. Server passed 481 cases plus its two existing expected
failures, and failed one case. The author's aggregate is 542 passed / 1 failed;
it is not an overall PASS. Full output and selection are attached in
`author-final.log`.

The only assertion failure is `migrations-0050-0062.test.ts`, migration 0059,
`starts empty on the previous release's database, keeps its nodes, and grants no
one anything`, line 386. Its old whole-row comparison omits the later migration
0135's `update_wait_since: null`. The exact same named case was executed on a
clean detached `359c2efaa27e9afb8842d0113dd5d6804aca467c` and failed with the same
extra field, exit 1, 1 failed and 16 excluded by the name selector. This comparison
is not a full pass of that file. Its full stack is attached as
`migration-baseline.log`. The baseline shares the same lockfile dependencies and
built protocol inputs; production and migration/test files are unchanged by this
task. No fixture cost or timeouts cause this assertion. A question to the head
asks whether to accept the baseline failure or assign its repair; integration
waits for that answer.

Further named checks on the checked implementation:

- `npx --no-install vitest run test/machine-away.test.ts test/agent-view.test.ts test/assistants-rights.test.ts test/agent-view-stream.test.ts test/agent-view-company.test.ts test/agent-view-waits.test.ts test/assistants-files.test.ts test/assistants-people.test.ts test/wait-views.test.ts test/agent-view-lists.test.ts test/wait-policy-routes.test.ts test/phones.test.ts test/phone-recording.test.ts test/outbound-department-access.test.ts test/outbound-department.test.ts --maxWorkers=1`:
  exit 0, 15 files and 176 cases passed, runner 63.25 seconds. These include all
  eleven other ACL consumers and four dedicated phone/contacts files.
- `npx --no-install vitest run test/program-operator-attachments.test.ts --maxWorkers=1`:
  exit 0, 16 passed, runner 12.04 seconds. Run separately with no other own check.
- `npx --no-install vitest run test/request-media.test.ts --maxWorkers=1`:
  exit 0, 8 passed, runner 7.51 seconds. Run separately with no other own check.
- `task-files.test.ts` executed by name in the author's sequential one-worker run:
  11 passed, including the several-megabyte download. It includes the upstream
  `prepareSharedDatabase` preparation from the final base. These three neighbors
  still have the head's requested one-at-a-time repeat after fast-forward.
- `npm run build -w @hornhoof/protocol`, `npm run build -w @hornhoof/node`, and
  `npm run build -w @hornhoof/server`: exit 0. Dependencies were prepared from the
  lockfile when it changed; the final merge keeps that lockfile unchanged.
- `git diff --check`: exit 0. The production server, protocol and three neighboring
  test files match the final integration base exactly. Only the declared task's
  test declarations, fixture setup, helper metadata and their boundary tests
  differ from it.

The shuffled table files finish in 21.99 to 24.23 seconds. The slowest individual
case in the required final runs is GET task at 2.672 seconds; the two first list
fixture cases take 2.018 and 2.151 seconds. These still exceed the preferred
one-second case budget, but all keep the original 20-second limit. This is timing
evidence under the recorded load, not a guarantee about another machine.

Manual diff and security review found no access expansion. `attachmentJobOf`
is recognized only at `/api/attachments`; no exemption or handler change was
added. The new foreign-company test retains every existing rejection and checks
that rejected requests store no attachment. Contacts remains behind
`manageDepartment` / `requireRunner`; the table grants agents no wider address
access. Row fixtures cache serializable rows only and bind each function to the
current app. All reset, rights/schema/statistics checks and closed-handle/late
write protections remain in place and pass their existing 42 tests. Metadata
is created from the exact run dump, is versioned and hash-bound to it, and its
failure publishes neither artifact path. The three codec tests pass.

No test case, protected access assertion, test/hook limit or production handler
was removed or weakened. No full suite or `run_tests` was executed. The release
owner retains final combined-candidate validation. There is no release to main.

Status before integration: NEEDS_CONTEXT only for the independently reproduced
baseline migration assertion; all required checks of this change are green.
