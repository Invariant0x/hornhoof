# Machine access: whole company scope, chosen duration, who opened (#1119)

Server side of #1103, after Design's decision in #1102 (sketch B with two changes from A). The web side is #1115 (Neo),
built in parallel on the contract below; the contract changes only with Neo's consent.

## Acceptance

1. An open access has a `scope`: `orchestrator` (as today) or `all_agents` (full access for every agent of the company).
   People's rights do not change.
2. The opener picks a duration: `1h`, `8h` or `24h`, `1h` when left out. The answer carries `until`. When it passes,
   the access closes by itself and the orchestrator's window gets a line (`state: expired`). Tests use virtual time only.
3. The answer carries `openedBy` (the person) and `openedAt`. The owner, the CEO and the CEO delegate close it with one
   call, as today.
4. Among people, only the machine's owner opens, as today. The orchestrator retains its owner-API exception under Ivan's rule `df92a23e`, as confirmed by the Head during Security. `all_agents` needs `confirm: true`; without it, 400. Through the owner API this confirmation is the agent's, not a person's.
5. The orchestrator's request ("Asks for access") carries its reason, as today (`asked: { reason, at }`), for the card with
   "Open for ..." and "Not now" (`decline`).
6. With `all_agents`, any worker or head of the company runs `computer` on that machine until `until`; no agent of
   another company, and no personal assistant (`kind = assistant`): assistants get no computer tools at all, and
   `Computers.start` refuses them too.

## API contract (for #1115)

`GET /api/machines/access` answers `{ views: AccessView[] }`. There is no durations field: the web already owns the three choices. The same view is returned in `GET /api/machines` and is covered in `computer-machines.test.ts`.

```ts
type AccessScope = 'orchestrator' | 'all_agents';
type AccessDuration = '1h' | '8h' | '24h';
type AccessView = {
  machine: { id; networkId; name; hostname; personId; role; os; data }; // as today
  reachable: boolean;                          // as today
  key: 'not_needed' | 'held' | 'not_held';     // as today
  asked: { reason: string; at: string } | null; // as today: the orchestrator's request
  until: string | null;                        // ISO; null when closed or expired
  scope: AccessScope | null;                   // new; null exactly when until is null
  openedBy: { id: string; name: string } | null; // person who opened it; null when closed or opened by the orchestrator
  openedAt: string | null;                     // new; ISO, null when closed
  canOpen: boolean;                            // as today: the owner on their own screen
  canClose: boolean;                           // as today: owner, CEO, CEO delegate
};
```

`POST /api/machines/:id/access/open`, body:

```ts
{ scope?: AccessScope; duration?: AccessDuration; confirm?: true; grant?: { payload: string; signature: string } }
```

- `scope` defaults to `orchestrator`, `duration` to `1h`.
- `scope: 'all_agents'` without `confirm: true`: 400, reason `confirm_needed`. `confirm` with `orchestrator` is
  allowed and ignored.
- A grant must span exactly the chosen duration: `until - at` of its signed payload equals 3600, 28800 or 86400. Any
  other span: 400 `bad_grant`. The browser signs `until = at + duration` (today it signs 24 h in
  `apps/web/src/ui/PasswordPrompt.tsx`; #1115 changes that).
- The server's own machine with no key opens for `now + duration`, not for a day.
- Opening again while open replaces scope, duration, `openedBy` and `openedAt`.
- Errors otherwise as today: 403 `not_machine_owner`, 409 `machine_unreachable`, `key_not_held`, `no_key`, 400
  `grant_needed`.
- Answer: the `AccessView` of that machine.

`POST /api/machines/:id/access/close` and `/decline`: unchanged, answer the `AccessView`. After close, `scope`,
`openedBy`, `openedAt` and `until` are null.

The same `AccessView` already goes into `GET /api/requests` (`machineAccess[].view`), so the decisions card gets the new
fields with no change there. The bus event stays `{ type: 'computer' }`; it is also published when an access expires.

The routes from before access was per machine (`/api/computer/*`) keep their answers; their `open` takes the same body,
with the same defaults.

## Server

- `apps/server/src/db/schema.ts`: `machine_access.scope text NOT NULL DEFAULT 'orchestrator'`, check
  `scope IN ('orchestrator', 'all_agents')`. A migration with the next free number of turn-31 at hand-in (see below).
  The view shows `scope` only while open.
- `apps/server/src/modules/computer/access.ts`:
  - `ACCESS_DURATIONS = { '1h': 3600, '8h': 28800, '24h': 86400 }`; `ACCESS_MS` goes.
  - `untilOf` takes the duration: keyless own machine `now + duration`; with a grant, `facts.until - facts.at` must equal
    it. `readGrant` and the signed payload stay as they are (v 1), so the keeper on each machine needs no change.
  - `open(me, machineId, { grant, scope, duration })` writes `scope` with `until`, `openedBy`, `openedAt`.
  - `states` and `views` add `scope`, `openedBy` (joined name from `people`) and `openedAt`, all null when closed.
  - `start(job, machineId, command, timeout)` reads the actual job and agent kind from the database and, in the same transaction that reads the
    access row: an assistant gets `'closed'` always; any kind but the orchestrator gets `'closed'` unless
    `scope = 'all_agents'`. The machine is looked up under `job.companyId` as today, so another company's agent never
    reaches it.
  - `wait(runId, companyId, agentId)`: a run is read only by the agent that started it. Today only the orchestrator
    runs commands, so nothing else was needed; with every agent it is.
  - `expire()`: in one transaction, every row with `until <= now`: `until`, `grant` null, the commands nobody took end
    (`endRuns`, as on close). Returns `{ companyId, machine }[]`.
- `apps/server/src/modules/computer/expiry.ts` (new): `expireAccess(ctx)` calls `ctx.computer.expire()`, writes for
  each a line in the orchestrator's window (`kind: 'computer'`, `{ state: 'expired', machine }`, no person) and
  publishes `{ type: 'computer' }`. The line helper moves here from `routes.ts`, so both share it.
- `apps/server/src/app.ts`: in lead mode, `expireAccess` every 60 s , cleared on close, like
  `holdersTimer`. Tests never wait for it: they build `Computers` with their own `now` and call `expireAccess` directly.
- `apps/server/src/modules/computer/routes.ts`: the open body above with `confirm`; the opened line carries `scope`
  and `until`, and `confirm: true` for company access; no durations field is added.
- `apps/server/src/modules/computer/tools.ts`:
  - `registerComputerTools(server, ctx, job)` registers `machines`, `ask_computer_access`, `computer`,
    `computer_result` for the orchestrator, as today.
  - The same registration gives workers and heads: `machines`, `computer` and `computer_result` only. Their
    `computer` says, when the machine is not open to all agents, that only its owner opens it to all agents and that the
    agent asks the orchestrator (no `ask_computer_access` for them).
  - The rule of whose last words may direct a command (`machinePrincipal`: the owner, the CEO, the CEO delegate, or no
    person) holds for every agent. Only the machine path admits a worker, and only for an active all_agents machine in the same company; decisionPrincipal and standingPrincipal keep ANSWERS_PEOPLE.
- `apps/server/src/modules/tools/mcp.ts`: uses the shared computer registration in the non-orchestrator branch, preserving the integrated iv-orchestrator-all shelf. Assistants
  use `assistantAgentTools` and get none.
- `apps/server/src/modules/backups/restore.ts`: a restore resets `scope` to `orchestrator` with the other fields.
- `apps/server/src/errors.ts`: reason `confirm_needed`.

Not in this task: a switch that lets a personal assistant into `all_agents` (item 6 says "no without an explicit
decision"; that decision is a later task); scope in the owner's signed grant (the keeper cannot tell which agent sent a
command, so it could not enforce it; the owner's confirmation lives in the request and in the log line).

## Threats

- An agent of another company: the machine is found under the job's company only (`held(tx, job.companyId, ...)`).
- An assistant: no tools, and `start` refuses its kind.
- A person without rights steering an agent: `machinePrincipal` unchanged for every agent.
- An agent reading another agent's command output: `wait` checks the run's agent.
- A stale open after the time: `start` and `take` already treat `until <= now` as closed; `expire` only clears the row
  and writes the line.
- A grant signed for a day used as "1 hour" or the other way: the span must equal the chosen duration.

## Checks

Server tests, written first and red on origin/turn-31:

- `apps/server/test/computer-scope.test.ts` (new): open with each duration (keyless own machine and with a grant); grant
  span not equal to the duration 400; `all_agents` without `confirm` 400; not the owner 403; `openedBy` and `openedAt`
  in the answer; a worker of the company runs a command with `all_agents` and not with `orchestrator`; an agent of
  another company and an assistant never; a run read by another agent refused; expiry on virtual time closes the access,
  writes the `expired` line and publishes; close by the owner, the CEO and the CEO delegate clears scope.
- Named neighbours: `computer`, `computer-machines`, `orchestrator-control`, `decisions`, `network-tables`,
  `migrations`; `tsc` of the server with tests; `eslint` of the changed files. No `run_tests`.

## Migration number and repeated openings

The current turn-31 base ends at `0136_outbound_contact_log`. The head reserved 0137 for task 1077 and confirmed
`0138_machine_access_scope.sql` and `meta/0138_snapshot.json` here. Generate with Drizzle, preserve existing snapshots,
and recheck the journal before hand-in. At integration, its `when` must exceed the latest applied entry, and the snapshot
must follow the already integrated 0137. If 0139 enters first, ask the head to renumber before integration.

Every opening starts a new window. As the head confirmed, end the previous waiting queue with exit 126 in the same
transaction before the new grant is written, also after an expired window. Never touch or claim to have stopped commands
already taken by the keeper. RED/GREEN covers both downgrade from all_agents to orchestrator and an expired old window.

The plan's executable changes remain in task-1119. Task 1220 is a separate turn-32 document and is not part of this branch.

## Development evidence

The observed RED is in `task-1119-red-ready.log`: missing opener/scope fields, unchanged daily default, absent confirmation,
unchecked grant span, employee admission under orchestrator access and another employee reading a run. The new expiry
module was not present on that base. `task-1119-reopen-red-fresh.log` separately proves both old waiting queues cross into
a new window before the fix. The expired test queues its command one second before expiry so the unrelated ten-minute
stale-command rule cannot make it pass.

The named local run in `task-1119-green-covered.log` passed 237 tests in ten files: computer-scope,
computer-scope-migration, computer, computer-machines, orchestrator-control, decision-context, decisions, network-tables,
migrations and restore. After extracting the access-request registration, its four caller files passed 120 tests again
in `task-1119-green-tools-refactor.log`. Nine other source fingerprints remained identical; their measured coverage was
reused, replacing only computer/tools coverage from that final run. No full suite or run_tests ran.

Server test types passed. The unchanged repository judge found no new or grown function at CRAP 10 or above, with
worst counted CRAP 9.648. registerComputerTools is now CC 7 and registerAccessRequest CC 6. Dryer found no duplicates.
Final exact-commit author-check output, lint and build records accompany the Development hand-in. An unavailable
formatter or a selector requiring the release suite must stay explicitly unavailable. Review, independent Security and
Tests have not been performed by this author. No integration is authorized by these local checks.

## Worker terminal input follow-up

A further RED on published candidate `36df758abf4ead6dd6bd3c4904e3f314f46dc3d4` found that a worker's terminal Enter
was never recorded by answersFromNow. machinePrincipal then kept the owner's fallback after another person typed.
The head explicitly extended scope to record typed input for workers, including an unknown speaker (`personId: null`).
ANSWERS_PEOPLE, decisionPrincipal and standingPrincipal retain their prior eligibility filter.

`computer-scope-input.test.ts` exercises the real MCP command boundary: another plan owner's Enter denies root without
creating a command, an Enter crossing into a new turn records null and also denies root, and the named machine owner's
input restores machine access. Ordinary management decisions remain unavailable to a worker in every case. Together
with computer-scope, decision-context and decisions, this passed 72 checks. Source fingerprints preserve the earlier
237-check evidence for unchanged code, with fresh measured coverage for decision-context after this repair.

The author-check run on 36df758ab was interrupted by its author for this repair, after checking the owned process and
workspace. It is not a passed result. The final author wrapper checks the follow-up delta against that published candidate;
the hand-in also carries the earlier named checks and unchanged-file fingerprints for the complete change against turn-31.


## Security repair and evidence, 17 November 2026

Input candidate: `4bbfd4961517e3802b9b014cfcc305ec60ce24c7`, immutable candidate `a002f02d-cb17-4dff-8415-9dd92eac5f29`. Task base: `887fa6540bad796c30ed907fb14a2b48d3f7994c`. Security repair: `db740c505bf0fa10a19c5bf8c13bc48a9e732afb`.

The Head explicitly retained the orchestrator's ability to open `all_agents` with its own `confirm: true`. This is agent confirmation, not human approval. Requiring a person is a separate policy decision, outside this repair. The same signature, company, duration and expiry checks remain in place.

Two remaining attribution defects were reproduced and repaired within `computer/routes.ts` and `computer-scope.test.ts`:

- A pending access request caused self-opening to send `computer_access` from the CEO, say “The CEO opened access”, and create a turn with the CEO as `createdBy` and `answersCeo: true`. The new real-MCP test first failed because its envelope named a person rather than the orchestrator. The notification now uses `actorOf(me)`, names the orchestrator in its text, and its new turn has no human creator and no `answersCeo` flag. The existing human path is preserved.
- `closed` and `declined` used `me.id` in the computer event. After the Head explicitly included them, a second real-MCP test observed both events attributed to the CEO. They now use `personOf(me)` and retain the orchestrator's agent identity. No access right or API response shape changed.

The regression also checks a default one-hour self-opening and its `openedBy: null`. Existing scope tests cover all three durations, signed spans, confirmation, human close rights, expiry, company/assistant rejection and private run results. Tests use the controlled Date and recorded fixtures, not a live machine.

Affected local checks on the repair working tree, committed without subsequent executable edits:

- From `apps/server`: `npx --no-install vitest run test/computer-scope.test.ts test/computer.test.ts test/computer-machines.test.ts test/request-sources.test.ts test/decision-context.test.ts test/computer-scope-input.test.ts --maxWorkers=1 --no-file-parallelism`: 6 files, 113 passed, exit 0.
- After adding explicit event ordering to the new test, `npx --no-install vitest run test/computer-scope.test.ts --maxWorkers=1 --no-file-parallelism`: 18 passed, exit 0. This supersedes those 18 cases in the preceding receipt; it is not 18 additional unique tests.
- `NODE_OPTIONS=--max-old-space-size=2048 npm run -s build -w @hornhoof/server`: exit 0.
- `NODE_OPTIONS=--max-old-space-size=2048 npx --no-install tsc -p apps/server/tsconfig.eslint.json --noEmit`: exit 0.
- `NODE_OPTIONS=--max-old-space-size=2048 npx --no-install eslint apps/server/src/modules/computer/routes.ts apps/server/test/computer-scope.test.ts`: exit 0.
- `git diff --check`: exit 0.

Raw receipts and actual exit files are attached as `security-1119-raw-logs.tar.gz`, SHA-256 `9b922467ec8c9e4fcbe04f4a5c2a929ef9a4f4fe822a10e24936d0f312b6f81e`, with `security-1119-manifest.json`. The manifest records commands, input state, the repair commit, final source hashes and all 16 raw-file hashes/sizes. The downloaded archive and every raw hash were verified. Do not hash a formatted presentation instead of the raw bytes.

Earlier evidence was read without rerunning unchanged author checks: all 35 author log hashes matched the archive manifest; the recorded 239-test named run completed with exit 0 and no failure markers. Review's 121 assertions on its candidate passed; these old receipts are not relabelled as execution of the Security repair. The unchanged migration's upgrade receipt passed. Recomputed snapshot differences are only `machine_access.scope` and its check constraint, with `prevId` pointing to 0136 in this pinned branch. Integration must still re-link the migration behind the actual preceding migration, assign a later journal time and check the resulting new candidate.

Concerns and route: the six-file run took 167.73 s. `computer-machines` reported 37.782 s of tests, beyond the 30 s file budget; the final standalone scope run took 33.48 s overall, with 8.364 s of tests. These timing defects are recorded, not called a passed time budget; the Head restricted this repair to attribution. No limits or assertions were weakened, and no full suite or `run_tests` ran. Native `codex review --base review-1119-base` failed before reading code because bwrap could not create a namespace; its shell exit 0 is NOT_RUN, not approval. Manual Security inspection was performed.

This is Security's own repair, not an independent PASS on it. The Head will assign an independent check after submission. No shared branch, main, live machine or production data was changed. Web rendering remains owned by #1115; this server change preserves its response contract.
