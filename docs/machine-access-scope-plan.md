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
4. Only the machine's owner opens, as today. `all_agents` needs `confirm: true` in the request; without it, 400.
5. The orchestrator's request ("Asks for access") carries its reason, as today (`asked: { reason, at }`), for the card with
   "Open for ..." and "Not now" (`decline`).
6. With `all_agents`, any worker or head of the company runs `computer` on that machine until `until`; no agent of
   another company, and no personal assistant (`kind = assistant`): assistants get no computer tools at all, and
   `Computers.start` refuses them too.

## API contract (for #1115)

`GET /api/machines/access` answers `{ views: AccessView[], durations: ['1h', '8h', '24h'] }`. The first duration is
the default.

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
  openedBy: { id: string; name: string } | null; // new; the person who opened it, null when closed
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
  - `start(job, machineId, command, timeout)` takes the job's agent kind and, in the same transaction that reads the
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
- `apps/server/src/app.ts`: in lead mode, `expireAccess` every 60 s (`EXPIRE_EVERY_MS`), cleared on close, like
  `holdersTimer`. Tests never wait for it: they build `Computers` with their own `now` and call `expireAccess` directly.
- `apps/server/src/modules/computer/routes.ts`: the open body above with `confirm`; the opened line carries `scope`
  and `until`; `durations` in `GET /api/machines/access`.
- `apps/server/src/modules/computer/tools.ts`:
  - `registerComputerTools(server, ctx, job)` registers `machines`, `ask_computer_access`, `computer`,
    `computer_result` for the orchestrator, as today.
  - New `registerAgentComputerTools` for workers and heads: `machines`, `computer` and `computer_result` only. Their
    `computer` says, when the machine is not open to all agents, that only its owner opens it to all agents and that the
    agent asks the orchestrator (no `ask_computer_access` for them).
  - The rule of whose last words may direct a command (`machinePrincipal`: the owner, the CEO, the CEO delegate, or no
    person) holds for every agent, unchanged.
- `apps/server/src/modules/tools/mcp.ts`: registers the agents' computer tools in the non-orchestrator branch. Assistants
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

## Migration number

turn-31 ends at `0129_builtin_node_connections`. Planned before this one: #1076 `0130_vault`, #1079 `0131` and `0132`,
#1113 `0133`. This task plans `0134_machine_access_scope`; the number is whatever comes next in turn-31's journal at
hand-in, generated with drizzle-kit on that journal.
