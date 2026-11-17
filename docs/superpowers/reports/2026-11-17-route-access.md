# Task 1196: route declarations and agent views

Base: `9fe737f21ee6f4caf2c0cad80c086cfe791fdb79` on `turn-31`.
Integration base: `734fe6637056b022d506c8049a7d1c6e07dd8afe`, merged cleanly.
Bug fix, small task, access risk. No handler or production access policy changes.

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

Status: BLOCKED on the required green result of the whole agent-view table file.
This records the first checked version. The head subsequently expanded task 1196
to diagnose and reduce fixture cost while preserving every access case.
Checked code: `8e77035fe905f9860440bcbb91059b53d707e5ea`.
The change remains on `task-1196`; it has not been pushed to `turn-31`.

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

## Limits and next step

The head authorized fast-forward only after all three changed test files are
green, accepting the neighboring timeout report because its code is unchanged.
That condition remains unmet after the single-file table check. No limits were
raised and no access checks were removed or weakened. A decision from the head
is needed before further work or integration. The requested one-at-a-time checks
of task-files, program-operator-attachments and request-media remain after the
fast-forward; they have not been run yet.

The selector reported an unavailable import graph and left its remaining
inventory to the release owner's full run; no full suite or `run_tests` was
started here. Format was unavailable because the repository has no formatter;
CRAP was not applicable because no production source changed. The first author
check invocation had a mistyped SHA and was refused before executing checks;
the corrected invocation above checked the actual candidate. `codex review`
could not read the diff because bwrap could not create a namespace. Manual diff
and access review were completed; there is no automated review PASS.

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
Rebind `work` and `get` to each fresh app. This reuses no app, connection, function
or mutable descriptor across tests, and it changes no production handler, access
assertion, actor combination or timeout. Shared `helpers-db.ts` stays unchanged.

Verification required by the head: each of agent-view-table and route-access
alone three consecutive times, with a shuffled table run proving case isolation;
record load 1m, build, server/test types and ESLint. The original protected checks
stay in place. If shared database helpers need a further change, also execute the
three named neighboring test files and repair only failures with the same cause.
