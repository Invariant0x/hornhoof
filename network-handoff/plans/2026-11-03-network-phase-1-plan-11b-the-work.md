# Network Phase 1, Plan 11b: Splits, the Work, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents are never cut off mid-step when their machine is. A machine with no internet answers read tools and
tells write tools to wrap up; its nodes save every work folder without touching it and push it as a branch once they
can; the CEO can press "Go on here without Mac", which waits for that saving. While a machine works apart, a push that
would not fast-forward lands on `<branch>@<machine>`, never forced. Each side does only its own work: free tasks from
before a split stay with the side of the last normal leader, and a task in progress stays with the side whose agent has
it. The side that leads keeps the jobs of a machine it cannot reach, tells their heads, and after 30 minutes lets them
restart the task elsewhere; the old agent, if it comes back, is told where its task went.

**Architecture:** One migration, `0060_go_on_here`, lets a handover's `reason` say `here`. The app in `read` lets `POST
/mcp` and node sockets through: read tools run, write tools answer one fixed text when the machine has no internet, and
a node says hello for status only, so the app knows what runs and nothing is written or confirmed. The app tells each
node, in a new `net.state` message, when to save and whether its machine works apart. The node saves through
`GIT_INDEX_FILE` (`saved-work.ts`), pushes saved work when a leading app hands it the repository (`work.push`), and
keeps a `git` wrapper first on the agents' `PATH` (`hh-git.cjs`). "Go on here" is a new answer of plan 10's recovery
API, which the keeper takes as plan 11's split take. The queue gives out work by one rule while the app leads apart
(`modules/network/split-side.ts`), and a job on a machine the leader cannot reach waits, then may be superseded by its
head (`modules/tasks/away.ts`).

**Tech Stack:** TypeScript on Node 22 (`node:child_process`, `node:fs`); git 2.39 or later (the node image's, Debian
12); Postgres 17.11; Fastify 5 with `@fastify/websocket`; `@modelcontextprotocol/sdk` as today; drizzle-orm 0.45.4;
React for the web app; vitest; Docker for `npm run test:lab`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.6 "No internet" (saving work folders), "No double work",
"Workers"; 3.9 "Modes" (`read`'s read tools and nodes for status), "Jobs" and "Work on a machine with no internet" (the
write tools' text, the 30-minute wait, superseded jobs and the move message); section 2 "Cut off, with no internet" (the
saving list and "Go on here without Mac"); section 4's row "Leader loses internet, copy elsewhere"; section 5 step 8
(the merge task lists every branch); section 12's bullets "Node and front" (a superseded job's agent gets the move
message; a saved work folder leaves files and index untouched and holds untracked files) and "Git". Overview
`notes/plans/2026-11-03-network-phase-1-overview.md`, plan 11's entry; plan 11's ruling 1, which gives this plan its
part.

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see them
fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only the
task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a test of
an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in the series' worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network` on its branch `network`, after plan 11's last task is
committed there. Nothing of the series ships until it merges into main, once, at its end.

**Handed over** (done on the `network` branch before this plan starts; none of it is shipped):
- Today's code: `toolsFor` and `mcpRoutes` (`apps/server/src/modules/tools/mcp.ts`), `jobOf` (`tools/job.ts`), the tool
  modules it registers, `registerDatabaseTool(server, ctx, job, 'read' | 'write')`; `NodeHub` (`nodes/hub.ts`:
  `awaySince`, `isOnline`, `greet`), `handleNodeMessage` (`nodes/messages.ts`), `failOpenJobs`; the queue
  (`conversation/queue.ts`: `sendNext`, `placement`, `pump`, `STOPPED_ON_PURPOSE`); `reconcile.ts` (`failAwayTurns`,
  `MACHINE_AWAY_MS`); the task engine (`tasks/engine.ts`: `updateTask`, `move`, `giver`, `Wake`, `WakeWhy`,
  `TASK_EVENT_KINDS`), `wakePrompt`, `afterJob`, `taskDetail`; `repoFor` (`departments/repository.ts`); `minuteRound`
  (`modules/agents/timers.ts`); `controlTools`' `view` and `pool` (`tools/control.ts`, GET through `app.inject`); the
  node's `runJob`, `workDirFor` (`<dir>/work/agents/<workspace.key>`, the key the agent's id), `prepareRepo` (the clone
  at `repoFolder(url)` inside it), `gitEnv`, `Git`, `ASKPASS`, `childEnv` (`<dir>/tools/bin` first on `PATH`, as the
  Dockerfile's `PATH` and `/etc/profile.d/hornhoof-tools.sh` put it), the hello it sends in `onOpen`
  (`apps/node/src/main.ts`); `repoFolder`, `NodeMessage`, `ServerMessage` (`packages/protocol`).
- Plan 2: `AppMode`, `modeGate`, `whileLeading`, `keeper.json` (`readKeeperState`, `writeKeeperState`, `KeeperState`);
  leaving `lead` closes every WebSocket.
- Plan 4: numbered node messages and `ack { upto }` under the upgrade header `Hornhoof-Acks: 1`; `guardTools`,
  `invocationOf`, `tool_calls`; `front`'s `/mcp` path and its retries of passing refusals.
- Plan 8: the merge task (`modules/merge/task.ts`: `bodyOf`, its code part from `net.merges.code`).
- Plan 9c: `builtinOf`, `jobs.builtin_machine`, `identityOf` per machine.
- Plan 10: `Recovery`, `RecoveryWord`, `RECOVERY_FILE`, `recoveryRoutes` (`GET /api/recovery`, `POST
  /api/recovery/go-on`, `/wait`), `RecoveryQuestion`, `question.warning`, `CEO_KEEP_MS`; `mergePending`, `park`
  (`modules/nodes/parked.ts`); `jobOf`'s `merge_pending`; `frontCalls`, `CALL_HOLD_MS`, `CALL_WAITING`
  (`net/front-calls.ts`); `recordHandover` with `kind` and `reason`; `net.handovers` and its `reason` check
  (`disk_full`).
- Plan 11, all of it, above all: `InternetCheck`, `KeeperState.split`, the handover of kind `split` with `from`, `at`,
  `behind`, `reach`, `lost`, `members`; `Alone` and `AloneView` (`alone.ts`); the leading keeper's entry row and the
  `Watcher`'s row that take a split term when `alone` holds, the `Taking` of kind `split` with `behind`, `lost` and
  `members`, leading apart; `SplitView`, the stance's and `Hello`'s `apart` and `split`; the switch word's `noInternet`
  and `lost`; `mergePending` while split, `cancelUnknown`; the lab's `homes`, `heal`, `relayCut`, `internet`,
  `internetStub`, `playRelay`.
- Where the branch's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`; in Russian a plan is «тариф», and a hostname as
  the subject takes «Машина» before it, so the feminine verbs agree.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`, `.superpowers/`,
  `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh config
  or certificate file, no company's link name. Tests use `127.0.0.1`, hosts under `hornhoof.test`, local bare
  repositories by path, and keys and passwords made at run time.
- No new npm dependency. One new migration, `0060_go_on_here`: `npx drizzle-kit generate --custom --name go_on_here`
  from `apps/server`, filled by hand (Task 5); never an edit of an older one. Its journal `when` stays above plan 11's
  `0059` (the series renumbers at its merge, every migration above main's newest).
- Agents are never interrupted (spec 3.9, the house rule): no stop, no Escape, no closed program for a machine cut off,
  a job superseded or a task moved; they hear it in a tool's answer and end their turn themselves.
- `read` writes nothing (spec 3.9): no row, no `applied` or `tool_calls` entry, no `ack` to a node, no `last_seen_at`.
- Git: a push is never forced by Hornhoof, and outside a split or a cut-off machine git behaves exactly as today. The
  agent's files, index and branches are never touched by a save.
- Messages between nodes and the app change only by additions (spec section 9): a node without the new fields is treated
  as one that saves nothing, and an app without them sends no `net.state`.
- Ivan's rules: only a machine's owner opens computer access to it; no step of this plan asks Ivan to type a command.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/node` and
  `apps/web` the same with their files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm
  test -- --testTimeout=90000`; `npm run test:lab` needs Docker. Types, from the worktree root: `npx tsc -p
  apps/server/tsconfig.json --noEmit`, and `apps/node`, `apps/web` and `packages/protocol` likewise when touched, each
  printing nothing. Never run prettier.
- Before a lab run on the team lead's Mac: `df -h /` and `docker system df`; clean only build cache and `hornhoof-lab/*`
  images, never a volume.

## Rulings made while planning

1. **What this plan takes** (plan 11's ruling 1). The work's half of the overview's plan 11: `read` mode's read tools
   and nodes for status, the write tools' answer on a cut-off machine, saved work folders and their branches, "Go on
   here without Mac", the `git` wrapper, no double work, the prompt of a behind side, jobs on a machine that cannot be
   reached, and section 4's row "Leader loses internet, copy elsewhere". Plan 11 decides who leads; this plan decides
   what agents and nodes do meanwhile.
2. **Read tools in `read`** (spec 3.9 "Modes": "serves pages, reads, read tools"). `modeGate` lets `POST /mcp` through
   in `read`, never in `maintenance`. An agent sees the same tools in every mode, so its program's tool list never
   changes under it. The read tools, whose handlers only read: `company`, `staffing_options`, `tasks`, `task`, `turns`,
   `agents`, `failures`, `test_run`, `work_run`, `notebook`, `improvements`, `database` (registered `read` for the
   orchestrator too, while in `read`), `computer_result`, `view` and `pool` (`READ_TOOLS`; Task 1's first step proves
   each writes nothing, and a tool that writes leaves the list). Plan 4's `guardTools` runs as for a call with no
   invocation, so no `tool_calls` row is written. Every other tool is a write tool.
3. **Write tools on a cut-off machine** (spec 3.9 "Work on a machine with no internet"). In `read` with `keeper.json`'s
   `internet` false, a write tool answers `CUT_OFF`, the spec's text, as a tool error, so the agent finishes its step
   and ends its turn itself. In `read` with internet (a countdown, or a copy waiting on the CEO's question), the route
   answers 503 `read_only` before the MCP transport, which plan 4's `frontCalls` now tries again as it tries `starting`
   (change to plan 4), and when its 50 s run out the agent gets `CALL_PAUSED`: "Hornhoof cannot take changes on this
   machine for a moment, so this call did not run. Try it again in a minute; if it keeps failing, end your turn with
   what you have done." (text for the team lead).
4. **Nodes for status** (spec 3.9: "Nodes may connect for status only, so it knows which turns still run; their messages
   stay in the nodes' outboxes"). In `read` the node socket passes the gate. Its hello is handled in memory only: which
   jobs run, whether the node saves; nothing is written, not even `last_seen_at`. No `ack` goes back, though the upgrade
   still says `Hornhoof-Acks: 1`, so every numbered message stays in the node's outbox; every other message is dropped
   unread except `saving`. When the app enters `lead`, it closes these sockets with 1012, so each node says hello again
   to a leader that writes.
5. **Saving work folders** (spec 3.6 "No internet"). The app tells each node in `net.state` whether to save: `save`
   while its mode is `read` and `keeper.json` says no internet. A node saves every clone in its agents' folders
   (`<dir>/work/agents/<key>/<one level down>/.git`) at once, then every 10 minutes while `save` holds: a copy of the
   index in `.git/hornhoof-index-<pid>`, and with `GIT_INDEX_FILE` set to it `git add -A`, `git write-tree`, `git
   commit-tree -p HEAD` (no parent with no `HEAD`), `git update-ref refs/hornhoof/saved/<task>/<time>`; the copy
   removed. It runs as the folder's owner, at most 5 minutes a folder, and skips a folder whose tree and parent match
   its last save. The agent's files, index, `HEAD` and branches are never touched. `<task>` is the task number of the
   agent's running task job (`net.state.tasks`), else `a` and the first 8 hex digits of the agent's id; `<time>` is
   `YYYYMMDD-HHMM` UTC. A worker machine has no app to tell its nodes, so they do not save (deviation: spec 3.6 ties
   saving to a machine that fences; its agents' folders stay as they are and come back with it).
6. **Pushing saved work** (spec 3.6: "When the internet is back the node pushes the last as a branch"). A node lists in
   its hello each saved folder not pushed yet, newest per task. A leading app answers each with `work.push { key, repo
   }` (`repoFor` of that agent), and the node runs `git push <url> <commit>:refs/heads/saved/<task>@<slug>-<time>` with
   `gitEnv(repo)`, never forced, then marks it `refs/hornhoof/pushed/<task>/<time>` and sends `work.pushed`. The app
   writes a task event of the new kind `saved` on that task: "Work saved on <host> at <time> is on the branch <branch>."
   `<slug>` is `machineSlug`: the hostname in lowercase, each run of other characters a `-`, trimmed, at most 32
   characters (`machine` when empty), then `-` and the first 4 hex digits of the machine's id, such as `mac-3f2a`.
7. **The `git` wrapper** (spec 3.6 "Git settles code"). The node writes `<dir>/tools/bin/git`, first on the agents'
   `PATH`, a shell script that runs the real `git` at once unless `<dir>/tools/apart` holds a slug. The node writes that
   file while `net.state.apart` names one and removes it when not. `apart` is the slug while the app is in `read`, or
   leads with `keeper.json`'s `split`. While apart, `hh-git.cjs` takes a `push` (not a dry run, a delete or a mirror),
   strips every force flag and `+`, pushes with `--porcelain`, and pushes each ref refused as non-fast-forward or "fetch
   first" again to `<dst>@<slug>`, unforced. It then tells the agent on stderr: "Hornhoof: this machine works apart, so
   <dst> did not move; your commits are on <dst>@<slug>, and are merged when the sides meet." (text for the team lead).
   `/usr/bin/git`, `gh api` and GitHub's MCP tools bypass it (the spec's known limit).
8. **"Go on here without Mac"** (section 2 "Cut off, with no internet"; spec 3.6: "Go on here" takes a term "by the
   CEO"). It is plan 10's recovery API with one more answer. The keeper offers it (`keeper.json` `here`) while it is a
   data keeper with no lease, no beat within 5 s says `lead`, the internet check says no, and it is the leading keeper
   or its copy is `ready`. The owner may press it while saving runs. The app keeps the press in memory and writes
   `recovery.json { here: true }` once saving is done: no node that saves reports a folder `saving`, and each has
   finished a round since `save` turned on, or 5 minutes have passed. The keeper then takes plan 11's split take at
   once, with no countdown and no side check, and records its handover with `reason` `here`, which marks it as the CEO's
   (migration `0060_go_on_here`; deviation in form: a `split` handover marked by its reason, not plan 10's kind `ceo`,
   since it meets others as a split does). The press expires once it is taken, a leader is followed, the relay answers,
   or after `CEO_KEEP_MS`.
9. **No double work** (spec 3.6). While the app leads under a split term of kind `split`, the queue gives out work by
   one rule (`mayRun`). On the side whose handover's `from` is not itself (it did not hold the last normal term's
   leader), a task's turn runs only if the task belongs to this side: it was created at or after the split's `at` S, or
   a job of it finished, or an agent event of one came, at or after S (rows after S are this side's own). A turn of no
   task runs only if it was queued at or after S. On every apart side, a task's turn waits while another job of that
   task runs on a node this side does not reach, since a task in progress stays with the side whose agent has it.
   Orchestrator turns follow the same rule. An agent on a behind side whose first turn since S starts gets one line
   before its prompt: "This side of the company works apart from <lost> since <S> and has <lost>'s changes up to <reach>
   only: what was done there after that is not here yet and comes back when the sides meet." (text for the team lead).
10. **Jobs on a machine that cannot be reached** (spec 3.9). While a merge is pending (plan 10's, which plan 11 made
    true while split), `failAwayTurns` fails nothing. Otherwise it no longer fails a task's turn: on a leader that is
    not apart, a task's turn whose node has been away 60 s wakes the task's giver (`away`) once, and once 30 minutes
    have passed (`AWAY_WAIT_MS`) wakes it again (`away_long`); a turn of no task is failed as today, after 5 minutes.
    `update_task`, giving such a task to another executor: refused on an apart side; before the 30 minutes, only with
    `from_branch` (the branch the agent pushed, which the new executor goes on from); after them, always. The old job is
    then marked failed with the error `superseded` and `MOVED` as its result, which the queue's `STOPPED_ON_PURPOSE`
    treats as stopped on purpose. A hello that lists a superseded job does not cancel it. Each tool call with that job's
    token answers `MOVED` as a tool error: "This task moved to {agent}{ on host}. Commit and push your work to your
    branch's name followed by @{slug} (such as task-41@{slug}), then end your turn." (the spec's text, with the branch
    named the way the job knows it). The wake texts are the team lead's to rule on (Task 7).
11. **What the head and the merge see** (spec 3.9, section 5 step 8). A task whose executor's job is away shows "Work
    saved on {machine} at {at}, not sent yet" on its card, `at` the job's last agent event. The merge task (plan 8's
    `bodyOf`) lists, under "Code:", each `saved` branch pushed since the merge's `from`, and says: "Pushes that did not
    fast-forward while apart are on branches named <branch>@<machine>; list them with git ls-remote origin
    'refs/heads/*@*' and bring each through its task's gates." The server runs no git itself.

## Review Focus

1. An agent's work lost: a save that touches the agent's index, files or branches (a save racing a `git add` of the
   agent's, an untracked file left out, a repository with no commit yet), a push that forces, a wrapper that drops a
   ref. Tests in Task 3 (`leaves the folder as it was`, `saves a repository with no commit`, `never forces`) and Task 4
   (`sends a refused push to the @ branch`, `never forces`).
2. Double work: a free task from before the split run on the side that did not lead, a task in progress run on both
   sides, a superseded job's agent still writing through its token. Tests in Task 6 (`gives out only this side's work`,
   `waits for a task whose agent is elsewhere`) and Task 7 (`answers a moved job's every call`).
3. `read` writing or confirming: a node's hello in `read` writing `last_seen_at` or an `ack`, a write tool's call
   leaving a `tool_calls` row, a read tool that writes. Tests in Task 1 (`writes nothing in read`, `answers read tools
   only`) and Task 2 (`hears nodes for status only`).
4. "Go on here" too soon or never: the press acted on before saving ends, a node that never reports holding it forever,
   a press kept after the old leader is back. Tests in Task 5 (`waits for the saving`, `goes on after five minutes`,
   `forgets the press when a leader answers`).
5. An agent cut off mid-step with no word: a write tool hanging for minutes, a cut-off answer during a countdown that
   ends in a minute, a superseded job cancelled at hello. Tests in Task 1 (`cuts off without internet, waits with it`)
   and Task 7 (`keeps a superseded job at hello`).

---

### Task 1: Read tools in `read`, and the cut-off answer

**Repo:** the `network` worktree, branch `network`. **Starts from:** plan 11's last task committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/read-tools.test.ts test/app-mode.test.ts
test/front-calls.test.ts` passes (the existing files of those modules where a name differs), then the whole server
suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/tools/read-tools.ts`
- Modify: `apps/server/src/modules/tools/mcp.ts` (`toolsFor`, `mcpRoutes`), plan 2's `modeGate`, plan 2's
  `apps/server/src/modules/keeper/state.ts` (`KeeperState.internet`, `here`), plan 4's `guardTools`, plan 4's
  `apps/server/src/net/front-calls.ts` (`read_only`, `CALL_PAUSED`)
- Test: `apps/server/test/read-tools.test.ts` (new), and the existing tests of the modified modules

**Interfaces:**
- Consumes: plan 2's `AppMode`, `modeGate`, `readKeeperState`; plan 4's `guardTools`, `frontCalls`, `CALL_HOLD_MS`; plan
  10's `CALL_WAITING` and its `merge_pending` retry; today's `toolsFor`, `jobOf`, `registerDatabaseTool`.
- Produces:
  ```ts
  // modules/tools/read-tools.ts
  export const READ_TOOLS: ReadonlySet<string>;   // ruling 2's names, exactly
  export const CUT_OFF = 'This machine is cut off and does not take changes now. Finish your current step, commit '
    + 'your work on your task branch, push if you can, and end your turn.';
  export function cutOff(server: McpServer, o?: { text?: string; keep?: ReadonlySet<string> }): McpServer;
  //   wraps server.registerTool: a tool not in keep (READ_TOOLS when left out) is registered with its own name,
  //   description and schema, and a handler that answers text (CUT_OFF when left out) with isError true
  export function callName(body: unknown): string | null;
  //   the params.name of a JSON-RPC body whose method is 'tools/call', else null
  // modules/keeper/state.ts: KeeperState gains internet?: boolean (true when left out; plan 11's keepers write it
  //   from their check) and here?: { lost: string } | null (null when left out; Task 5 writes it)
  // net/front-calls.ts
  export const CALL_PAUSED = 'Hornhoof cannot take changes on this machine for a moment, so this call did not run. '
    + 'Try it again in a minute; if it keeps failing, end your turn with what you have done.';
  ```
- `modeGate`: in `read`, `POST /mcp` passes; `maintenance` and `off` as before.
- `mcpRoutes`, in `read` (the app's mode when the request comes): when `callName(req.body)` names a tool not in
  `READ_TOOLS` and `readKeeperState()`'s `internet` is true, throw `new ApiError(503, 'unavailable', <plan 2's read_only
  message>, 'read_only')` before the transport; else `toolsFor` as today with `cutOff(server)` in place of `server` when
  `internet` is false, and the orchestrator's `registerDatabaseTool` in mode `read`.
- `guardTools` (plan 4) in `read`: runs the handler as for a call with no invocation, so it writes no `tool_calls` row
  and keeps no answer.
- `frontCalls`: a 503 whose reason is `read_only` on a `tools/call` is tried again as `starting` is; when `holdMs` runs
  out with that 503 last, the agent gets `CALL_PAUSED`.

- [ ] **Step 1: Prove the read tools read.** For each name of `READ_TOOLS`, read its handler (and, for `view` and
  `pool`, the GET routes they inject) and note in the commit message that it writes nothing; one that writes (an insert,
  update, delete, `appendEvent`, a bus publish that changes state, a job queued) leaves `READ_TOOLS`, and the agent says
  so in its report.
- [ ] **Step 2: Write failing tests.**
  - `read-tools.test.ts`, the app on `createTestSql` with a running job and its token, the mode `read`:
    - `answers read tools only`: `tools/list` in `read` lists the same names as in `lead`; `tools/call` of `tasks`
      answers the tasks.
    - `cuts off without internet, waits with it`: `keeper.json` `internet` false: `tools/call` of `update_task` answers
      200 with `CUT_OFF` and `isError` true; `internet` true: 503 with reason `read_only`, and the transport never ran
      (no MCP answer body).
    - `writes nothing in read`: a call of `tasks` and one of `update_task` with an invocation id: no `tool_calls` row,
      no `applied` row, no change to the job's row.
    - `lets the orchestrator read the database`: the orchestrator's `database` with a `SELECT`: rows; an `UPDATE`:
      refused as plan 4's read role refuses it.
    - `keeps maintenance shut`: `POST /mcp` in `maintenance`: 503 `maintenance`.
    - `reads the call's name`: `callName` of a `tools/call` body: its name; of `tools/list`, of an array, of a string:
      null.
  - `app-mode.test.ts`, `lets tool calls through in read`: `POST /mcp` in `read` passes the gate; `POST /api/tasks` does
    not.
  - `front-calls.test.ts`, `holds a call the machine cannot take yet`: a keeper answering 503 `read_only` twice and then
    200: the agent gets the 200; always 503 `read_only` with `holdMs` 1500: `CALL_PAUSED` with the request's id.
- [ ] **Step 3: Run** Done when. Expected: FAIL.
- [ ] **Step 4: Implement** in the files above.
- [ ] **Step 5: Run Done when.** Expected: PASS.
- [ ] **Step 6: Commit** "Answer read tools in read mode, and tell agents on a cut-off machine to wrap up".

### Task 2: Nodes say hello for status, and the app says when to save

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/status-nodes.test.ts test/net-state.test.ts
test/node-messages.test.ts` passes (the existing files of those modules where a name differs), then the whole server
suite; from `packages/protocol` its tests; the `tsc` commands print nothing.

**Files:**
- Create: `apps/server/src/modules/nodes/status.ts`, `apps/server/src/modules/nodes/net-state.ts`
- Modify: `packages/protocol/src/index.ts` (the hello's `saves` and `saved`; `saving`, `work.pushed`, `net.state`,
  `work.push`), `apps/server/src/modules/nodes/socket.ts` and `hub.ts` (status sockets in `read`),
  `apps/server/src/modules/nodes/messages.ts` (`work.pushed`, `work.push` at hello), `apps/server/src/db/schema.ts`
  (`TASK_EVENT_KINDS` gains `saved`), plan 2's `modeGate` (the node socket in `read`)
- Test: `apps/server/test/status-nodes.test.ts` (new), `apps/server/test/net-state.test.ts` (new), and the existing
  tests of the modified modules

**Interfaces:**
- Consumes: Task 1's `KeeperState.internet`; plan 2's `AppMode`, `whenLead`; plan 4's numbered messages, `ack`,
  `Hornhoof-Acks: 1`; plan 11's `KeeperState.split`; today's `NodeHub`, `handleNodeMessage`, `repoFor`, task events.
- Produces:
  ```ts
  // packages/protocol: NodeMessage hello gains saves?: boolean (it saves work folders) and
  //   saved?: { key: string; task: string; time: string }[] (max 100; saved, not pushed, the newest per task)
  //   new node messages: { type: 'saving'; folders: { key: string; task: string; state: 'saving' | 'saved' |
  //   'failed'; at: string }[]; done: boolean }   // not numbered; done: a round over every folder ended
  //   { type: 'work.pushed'; key: string; task: string; branch: string; time: string }   // numbered
  //   new server messages: { type: 'net.state'; save: boolean; apart: string | null; tasks: Record<string, number> }
  //   { type: 'work.push'; key: string; repo: Repo; slug: string }   // slug: machineSlug of the node's machine
  //   exported types: Hello, Saving, SavingFolder, NetStateMessage, WorkPush (z.infer of each)
  // modules/nodes/net-state.ts
  export function machineSlug(hostname: string, machineId: string): string;   // ruling 6
  export type NetState = { save: boolean; apart: string | null; tasks: Record<string, number> };
  export function netStateOf(ctx: Ctx): Promise<NetState>;
  //   save: read and keeper.json internet false; apart: this machine's slug while read, or lead with keeper.json
  //   split, else null; tasks: each agent with a running task job, by agent id, its task number
  export class NetStates {   // sends net.state to each greeted node that said saves, at hello and on a change
    constructor(opts: { ctx: Ctx; everyMs?: number });   // reads keeper.json and the mode each everyMs (1000)
    start(): void; stop(): void;
  }
  // modules/nodes/status.ts
  export type NodeStatus = { running: string[]; saves: boolean; folders: SavingFolder[]; done: boolean;
    since: number };   // since: monotonic ms of the hello
  export class StatusNodes {   // the nodes connected to an app in read
    hello(id: NodeIdentity, msg: Hello): void; saving(id: NodeIdentity, msg: Saving): void;
    all(): ReadonlyMap<string, NodeStatus>; close(code: number): void;
  }
  ```
- In `read`, `modeGate` lets the node socket's upgrade through. The socket is accepted as today (key check by reading
  `nodes`), with `Hornhoof-Acks: 1`, but its messages go to `StatusNodes`: `hello` and `saving` are kept in memory, the
  rest are dropped unread, and no `ack` is sent. Nothing is written: no `last_seen_at`, no job row, no `applied`. On the
  app's entry into `lead` (`whenLead`), `StatusNodes.close(1012)`.
- In `lead`, at hello: for each entry of `saved`, `work.push { key, repo: <repoFor of the agent whose id is key>, slug:
  <machineSlug of the node's machine> }`, none when it has no repository; `work.pushed`: a task event of kind `saved` on
  the task numbered `task` (when it is a number) of the node's company, with the text of ruling 6, `<host>` the node's
  machine's hostname, `<time>` from `time`; then handled as a numbered message (`applied`, `ack`).
- `NetStates` sends `net.state` to a node only when its hello said `saves`, so a node of an older build gets nothing.

- [ ] **Step 1: Write failing tests.**
  - `net-state.test.ts`:
    - `names the machine`: `machineSlug('Ivan’s MacBook Pro', '3f2a9c…')` is `ivan-s-macbook-pro-3f2a`; `'---'` gives
      `machine-3f2a`; a 40-character name is cut to 32 before the suffix.
    - `says when to save`: `read` with `internet` false: `save` true and `apart` the slug; `read` with internet: `save`
      false, `apart` the slug; `lead` with `split`: `save` false, `apart` the slug; `lead`: `apart` null. `tasks` names
      the agent of a running task job with its number.
    - `tells only nodes that save`: two nodes greet, one with `saves`: one `net.state`; `keeper.json` changes: a second
      to that node within 2 s.
  - `status-nodes.test.ts`, the app in `read` on `createTestSql`:
    - `hears nodes for status only`: a node connects and says hello with a running job and a `job.done` with a number:
      `StatusNodes.all()` lists the job; no `ack`; the job's row, `nodes.last_seen_at` and `applied` unchanged.
    - `keeps the saving`: a `saving` message: kept; `done` true kept.
    - `closes them for the leader`: the mode turns `lead`: the socket closes with 1012.
  - `nodes.test.ts`:
    - `asks for saved work`: in `lead`, a hello with `saved` for an agent with a repository: one `work.push` with that
      repository; for an agent without: none.
    - `notes the branch`: `work.pushed` for task 41: one task event `saved` with the text, and an `ack`; again with the
      same number: no second event.
  - `packages/protocol`'s test: the new messages parse; a hello without `saves` and `saved` parses as before.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let nodes report to a read-only app, and tell them when to save their work and where it goes".

### Task 3: Nodes save work folders and push them back

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 2 committed. **Done when:** from `apps/node`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/saved-work.test.ts test/main.test.ts` passes, then the whole node
suite; `npx tsc -p apps/node/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/node/src/saved-work.ts`
- Modify: `apps/node/src/main.ts` (`net.state`, `work.push`, the hello's `saves` and `saved`, `saving`), `apps/node/src/
  workspace.ts` (export `realGit`)
- Test: `apps/node/test/saved-work.test.ts` (new), `apps/node/test/main.test.ts`

**Interfaces:**
- Consumes: Task 2's messages; today's `Git`, `gitEnv`, `JobUser`, the agents' folders (`<dir>/work/agents/<key>`).
- Produces:
  ```ts
  // apps/node/src/saved-work.ts
  export const SAVE_EVERY_MS = 600_000;
  export const SAVE_CAP_MS = 300_000;     // one folder's save at most
  export function savedTime(at: Date): string;   // YYYYMMDD-HHMM, UTC
  export function taskLabel(key: string, tasks: Record<string, number>): string;   // the number, else a<8 hex of key>
  export type Saved = { key: string; task: string; time: string; commit: string; repo: string };   // repo: the clone
  export function clonesOf(dir: string): { key: string; repo: string }[];
  //   each <dir>/work/agents/<key>/<name> with a .git folder
  export function saveFolder(repo: string, o: { task: string; machine: string; at: Date; git: Git;
    user: JobUser | null }): Promise<'saved' | 'unchanged'>;
  export function savedFolders(repo: string, git: Git, user: JobUser | null): Promise<{ task: string; time: string;
    commit: string; pushed: boolean }[]>;   // refs/hornhoof/saved/* and whether refs/hornhoof/pushed/* has each
  export function pushSaved(repo: string, s: { task: string; time: string; commit: string }, o: { url: string;
    env: Record<string, string>; slug: string; git: Git; user: JobUser | null }): Promise<string>;   // the branch
  export class Saver {
    constructor(opts: { dir: string; git?: Git; machine: () => string; emit: (m: NodeMessage) => void;
      now?: () => Date; log: (line: string) => void });
    state(s: NetStateMessage): void;   // save turned on: a round at once, then every SAVE_EVERY_MS; off: none
    push(m: WorkPush): Promise<void>;  // the newest saved commit per task of that key not pushed yet
    hello(): { saves: true; saved: { key: string; task: string; time: string }[] };
  }
  ```
- `saveFolder`, ruling 5: `user` is the clone's owner (`stat` of the folder) when the node runs as root, else null;
  every git command gets `cwd` the clone, `GIT_INDEX_FILE` `.git/hornhoof-index-<pid>` (copied from `.git/index` when it
  exists, else absent), `GIT_TERMINAL_PROMPT=0`, a timeout of what is left of `SAVE_CAP_MS`; `commit-tree` with `-m
  "Saved by Hornhoof on <machine> at <time>"`, the author and committer `Hornhoof <hornhoof@hornhoof.org>` by
  environment, `-p HEAD` only when `rev-parse --verify -q HEAD` answers; `update-ref refs/hornhoof/saved/<task>/<time>
  <commit>`; the index copy removed in a `finally`. `unchanged` when the tree and parent equal those of the newest
  `refs/hornhoof/saved/<task>/*`.
- `Saver.state`: each round runs `saveFolder` on every `clonesOf` folder in turn and sends `saving` with each folder's
  state as it changes, `done` true when the round ends; a failed folder is one log line and `failed`, never a stop.
  `<machine>` is the machine's hostname; the task label from `net.state.tasks`.
- `Saver.push`: per task of that key, the newest saved commit with no `pushed` ref: `pushSaved` with `gitEnv(m.repo)`'s
  environment and `m.slug`, `git push <url> <commit>:refs/heads/saved/<task>@<slug>-<time>` (no `--force`, no `+`), then
  `update-ref refs/hornhoof/pushed/<task>/<time> <commit>` and `work.pushed` (numbered, as plan 4's outbox keeps it). A
  refused push is one log line; it is tried again at the next `work.push`.
- The hello carries `Saver.hello()`.

- [ ] **Step 1: Write failing tests.** `saved-work.test.ts`, with real git in temporary folders and a bare repository by
  path:
  - `leaves the folder as it was`: a clone with a staged change, an unstaged change and an untracked file: after
    `saveFolder`, `git status --porcelain`, `git diff --cached`, the index file's bytes, `HEAD` and every branch are as
    before; the saved commit's tree holds all three changes and its parent is `HEAD`.
  - `saves a repository with no commit`: `git init` with one untracked file: saved with no parent.
  - `skips what did not change`: a second `saveFolder` with nothing new: `unchanged` and one saved ref.
  - `leaves the index alone while git holds it`: `.git/index.lock` present (the agent's `git add` running): the save
    still runs on its copy, and the lock and the index are untouched.
  - `never forces`: the branch `saved/41@mac-3f2a-20261102-1405` already on the bare repository at another commit: the
    push fails, the bare repository's branch is unchanged, no `pushed` ref; a fresh name: pushed, the branch at the
    saved commit, the `pushed` ref set.
  - `names the time and the task`: `savedTime` of 2026-11-02T14:05:59Z is `20261102-1405`; `taskLabel` of a key with
    task 41 is `41`, without it `a` and the key's first 8 hex digits.
  - `saves every clone, round by round`: two agents' folders, `state({ save: true, ... })`: two `saving` messages per
    folder (`saving`, `saved`) and one with `done` true; 10 fake minutes later another round; `save` false: no more.
- `main.test.ts`, `says it saves`: the hello has `saves` true and lists a saved, unpushed folder; `work.push` for that
  key pushes and emits `work.pushed`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Save every work folder without touching it while cut off, and push it as a branch once back".

### Task 4: The `git` wrapper while apart

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 3 committed. **Done when:** from `apps/node`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/hh-git.test.ts test/image.test.ts test/main.test.ts` passes, then
the whole node suite; `npx tsc -p apps/node/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/node/hh-git.cjs`, `apps/node/src/git-wrapper.ts`
- Modify: `apps/node/Dockerfile` (copies `hh-git.cjs` to `/app/apps/node/hh-git.cjs`), `apps/node/src/main.ts` (writes
  the wrapper at start, the flag on `net.state`)
- Test: `apps/node/test/hh-git.test.ts` (new), `apps/node/test/image.test.ts`, `apps/node/test/main.test.ts`

**Interfaces:**
- Consumes: Task 2's `net.state.apart`; today's `<dir>/tools/bin` first on the agents' `PATH`.
- Produces:
  ```ts
  // apps/node/src/git-wrapper.ts
  export function realGitPath(path: string, tools: string): string | null;
  //   the first executable git on path whose folder is not <tools>/bin
  export function writeWrapper(tools: string, o: { git: string; node: string; script: string }): void;
  //   <tools>/bin/git, 0755, written whole and then moved
  export function setApart(tools: string, slug: string | null): void;   // <tools>/apart, 0644; null removes it
  ```
  ```sh
  #!/bin/sh
  [ -s <tools>/apart ] || exec <git> "$@"
  HH_REAL_GIT=<git> HH_APART=<tools>/apart exec <node> <script> "$@"
  ```
- `hh-git.cjs <args>` (plain Node, no dependency): reads the slug from the file `HH_APART` names and the real git from
  `HH_REAL_GIT`, both set by the wrapper's last line; skips the global options (`-C`, `-c`, `--git-dir`, `--work-tree`,
  `--namespace`, `--config-env`, `--super-prefix` with their values, the rest alone) to find the subcommand; anything
  but `push`, and a `push` with `-n`, `--dry-run`, `-d`, `--delete` or `--mirror`, runs the real git with the same
  arguments. A `push`: drops `-f`, `--force`, `--force-with-lease[=...]`, `--force-if-includes` and a leading `+` of
  each refspec; runs it with `--porcelain`; for each output line starting `!` whose summary says `non-fast-forward` or
  `fetch first`, pushes `<src>:<dst>@<slug>` to the `To <url>` of that block, unforced, with the same options; writes
  ruling 7's note per moved ref to stderr; passes the rest of the output on; exits 0 when every refused ref went to its
  `@` branch, else the first failing code.
- At start the node writes the wrapper with `realGitPath(process.env.PATH, <dir>/tools)`, `process.execPath` and
  `/app/apps/node/hh-git.cjs`; with no real git found, no wrapper (one log line). On each `net.state`, `setApart(<dir>/
  tools, m.apart)`; at start, `setApart(<dir>/tools, null)`.

- [ ] **Step 1: Write failing tests.** `hh-git.test.ts`, the wrapper written into a temporary tools folder, real git and
  two bare repositories by path:
  - `stays out of the way`: no `apart` file: `git push` that is not a fast-forward fails as the real git does, with the
    same output and code; `git status` and `git -C <repo> log` as the real git.
  - `sends a refused push to the @ branch`: `apart` holding `mac-3f2a`, `task-41` diverged from the bare repository's:
    `git push origin task-41` exits 0, the bare repository has `task-41` unchanged and `task-41@mac-3f2a` at the local
    commit, and stderr has the note.
  - `never forces`: `git push --force origin task-41` and `git push origin +task-41`: the same as above, `task-41`
    unchanged.
  - `pushes a fast-forward as usual`: a fast-forward: `task-41` moved, no `@` branch.
  - `leaves dry runs and deletes alone`: `--dry-run` and `--delete` reach the real git with the same arguments.
  - `finds the real git`: `realGitPath` with `<tools>/bin` first on the path: the next one.
- `image.test.ts`: the Dockerfile copies `hh-git.cjs`.
- `main.test.ts`, `marks the machine apart`: `net.state` with `apart` `mac-3f2a`: `<tools>/apart` holds it; with null:
  gone.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Send a push that would not fast-forward to its @ branch while the machine works apart".

### Task 5: "Go on here without Mac"

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 4 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/go-on-here.test.ts test/recovery.test.ts
test/keeper.test.ts test/watch.test.ts test/migrations.test.ts` passes (the existing files of those modules where a name
differs), then the whole server suite; from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run
test/GoOnHere.test.tsx test/i18n.test.tsx` passes; the `tsc` commands print nothing.

**Files:**
- Create: `apps/server/drizzle/0060_go_on_here.sql` (with its `meta/` snapshot and journal entry, as drizzle-kit writes
  them), `apps/server/src/modules/recovery/here.ts`, `apps/web/src/ui/GoOnHere.tsx`
- Modify: plan 10's `apps/server/src/modules/keeper/question.ts` (`RecoveryWord`, `Recovery.here`), plan 10's
  `apps/server/src/modules/recovery/routes.ts` (`POST /api/recovery/here`, `GET /api/recovery`'s `here`), plan 2's
  `modeGate` (that path in `read`), `apps/server/src/modules/keeper/keeper.ts` and `watch.ts` (`KeeperState.here`, the
  take), plan 9c's `taking.ts` (`Taking.here`), plan 9c's `promote.ts` (`recordHandover`'s `reason`), the layout
  (`apps/web/src/screens/Shell.tsx`, where plan 10 shows `RecoveryQuestion`), `apps/web/src/types.ts`,
  `apps/web/src/i18n/en.ts`, `ru.ts`
- Test: `apps/server/test/go-on-here.test.ts` (new), `apps/web/test/GoOnHere.test.tsx` (new), and the existing tests of
  the modified modules

**Interfaces:**
- Consumes: Task 2's `StatusNodes`, `NetStates`; Task 1's `KeeperState.here`; plan 10's `Recovery`, `RecoveryWord`,
  `recoveryRoutes`, `CEO_KEEP_MS`, `question.warning`, `RecoveryQuestion`; plan 11's `Alone.view()` (`lost`), the
  leading keeper's entry `alone`, `WatchSample.alone`, the split take and its handover.
- Produces:
  ```ts
  // question.ts: RecoveryWord's union gains { here: true }; Recovery gains
  //   here(): number | null    // monotonic ms of the CEO's word to go on here, kept CEO_KEEP_MS
  //   clearHere(): void
  // modules/recovery/here.ts
  export const HERE_WAIT_MS = 300_000;
  export type HereView = { lost: string; saving: { agent: string; task: number | null }[]; done: boolean;
    pressed: boolean };
  export class GoOnHere {   // the app's, in memory
    constructor(opts: { ctx: Ctx; status: StatusNodes; states: NetStates; now?: () => number; everyMs?: number });
    press(by: string): void;     // kept; recovery.json written once done(), or HERE_WAIT_MS after the press
    view(): Promise<HereView | null>;   // null unless keeper.json says here
    start(): void; stop(): void;
  }
  // taking.ts: Taking gains here?: boolean; promote.ts: recordHandover's reason gains 'here'
  ```
- `0060_go_on_here`: `net.handovers`' `reason` check dropped by its name and made again with `disk_full` and `here`; raw
  SQL in the hand-written part.
- `KeeperState.here` (ruling 8), written by each data keeper with the mode: `{ lost: <the hostname of Alone.view()'s
  lost, else its last normal term's leader> }` while it holds no lease, no beat within `NEAR_MS` says `lead`, its check
  says no internet, and it is the leading keeper or its copy is `ready`; else null.
- `Recovery.tick`: `recovery.json` `{ here: true }` sets `here()` now, with one log line "The CEO chose to go on here.".
  The keeper calls `clearHere()` on its take, on a beat saying `lead`, when the check says internet, and on a relay
  answer.
- The leading keeper: plan 11's entry `alone` is also the split term when `here()` is set and `KeeperState.here` holds,
  and its handover then has `reason` `here`. The `Watcher`: `WatchSample.alone` is also true then, and its `Taking` has
  `here` true, which the `Promoter` records as `reason` `here`. No countdown and no side check: the CEO chose this
  machine.
- `done()`: every `StatusNodes` entry whose hello said `saves` has sent `saving` with `done` true since `NetStates`
  first sent it `save` true, and none of its newest folders is `saving`; a node that never said `saves` counts as done.
- The routes, owner only as plan 10's: `POST /api/recovery/here`: 409 `conflict` 'This machine cannot go on by itself
  now.' (reason `cannot_go_on_here`) unless `keeper.json` has `here`; else `press`, 202. `GET /api/recovery` gains
  `here: HereView | null`: `saving` each folder of a node not done, by its agent's name and its task number from
  `net.state`'s `tasks`, read without writing. `modeGate` lets `POST /api/recovery/here` through in `read`.
- `GoOnHere`, shown by the layout while `GET /api/recovery` has `here` (polled as plan 10's question):
  `split.noInternet` of plan 11 is the banner above it; `here.saving` with the list while it is not empty; the button
  `here.button` with `question.warning` under it for the owner (`canAnswer`), `question.ceoOnly` without; `here.pressed`
  once `pressed`.
- The strings, EN / RU:
  - `here.saving` (plural on `{n}`): "Saving the work of {n} agent: {list}." / "Saving the work of {n} agents: {list}."
    / «Сохраняем работу {n} агента: {list}.» / «Сохраняем работу {n} агентов: {list}.» (one, and few and many alike);
    each item `here.item` "{agent} on task #{task}" / «{agent} над задачей #{task}», or the agent's name alone.
  - `here.button`: "Go on here without {lost}" / «Продолжить здесь без машины {lost}».
  - `here.pressed`: "Going on here once the work is saved." / «Продолжим здесь, как только работа сохранится.»

- [ ] **Step 1: Write failing tests.**
  - `migrations.test.ts`: the count of migrations grows by one; a handover with `reason` `here` inserts, `other` fails.
  - `go-on-here.test.ts`, the app in `read` with `keeper.json` `here { lost: 'Mac' }`, `StatusNodes` and `NetStates` on
    fakes:
    - `waits for the saving`: two nodes that save, one done since `save` turned on and one still `saving`: `press`, no
      `recovery.json`; the second sends `done`: `recovery.json` `{ here: true, by, at }` within 2 s.
    - `goes on after five minutes`: a node that never sends `done`: `recovery.json` at 300 s.
    - `counts an older node as done`: a node whose hello has no `saves`: `press` writes at once.
    - `lists the saving`: `GET /api/recovery`'s `here.saving` names dev-3 on task 41.
    - `refuses when it cannot go on`: `keeper.json` without `here`: 409 `cannot_go_on_here`; a person who is not the
      owner: 403.
  - `recovery.test.ts`: `takes the word to go on here`: `recovery.json` `{ here: true }`: `here()` set and the file
    removed; `clearHere()` clears it; `CEO_KEEP_MS` later: null.
  - `keeper.test.ts`, the leading keeper with no internet and no lease:
    - `offers to go on here`: `keeper.json` `here` with `lost` its sync copy's hostname; with a beat saying `lead`:
      null.
    - `goes on here when told`: `here()` set: a split take at once, with no countdown, its handover `reason` `here`.
    - `forgets the press when a leader answers`: `here()` set and a beat saying `lead` the same tick: it follows, and
      `here()` is cleared.
  - `watch.test.ts`, `goes on here when told`: copy B with no internet, `ready`, `here()` set: a `Taking` of kind
    `split` with `here` true; the `Promoter` records `reason` `here`.
  - `GoOnHere.test.tsx`: the list "Saving the work of 2 agents: dev-3 on task #41, ops-1."; the button "Go on here
    without Mac" with the warning for the owner, none without; after the press "Going on here once the work is saved."
  - `i18n.test.tsx`: every `here.*` key in both languages, and `here.saving`'s forms.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `schema.ts` needs nothing; `npx drizzle-kit generate --custom --name go_on_here`, then the
  hand-written part and the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let the owner go on with a machine that has no internet, once its work is saved".

### Task 6: Each side does only its own work

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/split-side.test.ts test/queue.test.ts` passes (the
existing file of the queue where its name differs), then the whole server suite; `npx tsc -p apps/server/tsconfig.json
--noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/network/split-side.ts`
- Modify: `apps/server/src/modules/conversation/queue.ts` (`sendNext` takes the oldest job `mayRun` allows; the behind
  line), the app's mode watch where `KeeperState.split` is read (`pumpWaiting` when it turns false)
- Test: `apps/server/test/split-side.test.ts` (new), `apps/server/test/queue.test.ts`

**Interfaces:**
- Consumes: plan 11's handover of kind `split` (`from`, `to`, `at`, `behind`, `reach`, `lost`, `normal_at`),
  `KeeperState.split`; today's `sendNext`, `pumpWaiting`, `NodeHub.awaySince`, `identityOf`, `agent_events`.
- Produces:
  ```ts
  // modules/network/split-side.ts
  export type SplitSide = { at: Date; restricted: boolean; behind: boolean; lost: string; reach: Date | null };
  //   lost: the lost machine's hostname
  export function splitSide(ctx: Ctx): Promise<SplitSide | null>;
  //   keeper.json split, and the newest net.handovers row naming this machine to is of kind split with normal_at
  //   null: restricted when its from is not this machine; else null; read at most once a second, cached
  export function taskHere(db: Db, taskId: string, at: Date): Promise<boolean>;
  //   the task created at or after at, or a job of it finished at or after at, or an agent_events row of a job of it
  //   at or after at
  export function mayRun(ctx: Ctx, job: Job, side: SplitSide | null): Promise<boolean>;
  export const BEHIND_LINE: string;   // ruling 9's text with {lost}, {at} and {reach}
  ```
- `mayRun`, ruling 9: true with no `side`. A task's turn: false when `side.restricted` and not `taskHere`; false while
  another job of that task is `running` on a node whose `awaySince` is set; else true. A turn of no task: false when
  `side.restricted` and it was queued before `side.at`; else true.
- `sendNext`: reads the agent's queued jobs oldest first (at most 50) and takes the first `mayRun` allows; with none, it
  sends nothing. When `side.behind`, the job's prompt is not empty, and the agent has no job started at or after
  `side.at`, `BEHIND_LINE` (times as `YYYY-MM-DD HH:MM UTC`) and a blank line go before the prompt.
- When `KeeperState.split` turns from true to false, `pumpWaiting` runs once, so the turns that waited go out.

- [ ] **Step 1: Write failing tests.**
  - `split-side.test.ts`, on `createTestSql` with a `split` handover at S from B to this machine A:
    - `knows its side`: `keeper.json` `split` true: `restricted` true, `lost` B's hostname; from A to A: `restricted`
      false; `normal_at` set or `split` false: null.
    - `gives out only this side's work`, restricted: a task created before S with a queued turn: not allowed; created
      after S: allowed; created before S with a job that finished after S: allowed; with an agent event after S:
      allowed; a turn of no task queued before S: not allowed, after S: allowed. Not restricted: all allowed.
    - `waits for a task whose agent is elsewhere`: a task with a job `running` on a node away and a queued review turn:
      not allowed, on either side; the node back: allowed.
  - `queue.test.ts`:
    - `sends the oldest turn it may`: an agent with a turn from before S (not allowed) and one from after (allowed),
      restricted: the second goes out, the first stays queued; `split` turns false: the first goes out.
    - `tells a behind side`: `behind` with `reach` 23:40: the agent's first turn since S starts with the line; its
      second does not.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Give out on each split side only the work that belongs to it, and tell a behind side so".

### Task 7: Jobs on a machine that cannot be reached

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 6 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/away.test.ts test/reconcile.test.ts
test/task-tools.test.ts test/nodes.test.ts test/merge-task.test.ts` passes (the existing files of those modules where a
name differs), then the whole server suite; from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run
test/TaskDetail.test.tsx test/i18n.test.tsx` passes; the `tsc` commands print nothing.

**Files:**
- Create: `apps/server/src/modules/tasks/away.ts`
- Modify: `apps/server/src/modules/tasks/reconcile.ts` (`failAwayTurns`), `apps/server/src/modules/tasks/engine.ts`
  (`WakeWhy`, `updateTask`'s executor change), `apps/server/src/modules/tasks/tools.ts` (`update_task`'s `from_branch`),
  the wake prompts (`wakePrompt`), `apps/server/src/db/schema.ts` (`TASK_EVENT_KINDS` gains `away`),
  `apps/server/src/modules/tools/job.ts` (`jobOf`), `apps/server/src/modules/tools/mcp.ts` (a moved job's calls),
  `apps/server/src/modules/nodes/messages.ts` (the hello keeps a superseded job),
  `apps/server/src/modules/conversation/queue.ts` (`STOPPED_ON_PURPOSE`), `apps/server/src/modules/tasks/views.ts`
  (`taskDetail`'s `away`), plan 8's `apps/server/src/modules/merge/task.ts` (`bodyOf`), the minute round
  (`apps/server/src/modules/agents/timers.ts`: `awayTick`), the task's page in `apps/web` (where the task detail shows
  its executor), `apps/web/src/types.ts`, `apps/web/src/i18n/en.ts`, `ru.ts`
- Test: `apps/server/test/away.test.ts` (new), and the existing tests of the modified modules

**Interfaces:**
- Consumes: Task 6's `splitSide`; Task 1's `cutOff`; Task 2's `machineSlug`; plan 10's `mergePending`; today's
  `failAwayTurns`, `failOpenJobs`, `giver`, `Wake`, `updateTask`, `jobOf`, `taskDetail`; plan 8's `bodyOf`.
- Produces:
  ```ts
  // modules/tasks/away.ts
  export const AWAY_NOTE_MS = 60_000;
  export const AWAY_WAIT_MS = 1_800_000;
  export function awayJobs(ctx: Ctx): Promise<{ job: Job; taskId: string; host: string; since: number }[]>;
  //   running conversation jobs with a task whose node's awaySince is set, since that awaySince
  export function awayTick(ctx: Ctx, now?: number): Promise<void>;
  export function movedText(o: { agent: string; host: string | null; slug: string }): string;   // ruling 10's MOVED
  // engine.ts: WakeWhy gains 'away' and 'away_long'; TaskChange gains fromBranch?: string (a Branch)
  // views.ts: TaskDetail gains away: { machine: string; at: string; until: string } | null
  ```
- `failAwayTurns`: nothing while `mergePending`; a job with a task is never failed by awayness; a job of no task as
  today.
- `awayTick`, each minute, only while the app leads and `splitSide` is null: for each of `awayJobs` away at least
  `AWAY_NOTE_MS`, the task's giver woken `away`, and at least `AWAY_WAIT_MS`, woken `away_long`, each once per job: a
  task event of kind `away` with `data { job, stage }` marks it.
- `updateTask`, changing the executor of a task whose executor has a job among `awayJobs`: on an apart side (`splitSide`
  set) refused 409 `task_invalid` "#{n} stays with {host} until the sides meet."; away under `AWAY_WAIT_MS` and no
  `fromBranch`: refused 409 `task_invalid` "#{n}'s agent works on {host}, which Hornhoof cannot reach since {time}. Name
  the branch it pushed with from_branch, or wait until {until}."; else the old job `failed` with `error` `superseded`,
  `result` `movedText` (the new executor's name, its machine's hostname when it has one, the old machine's
  `machineSlug`), `finished_at` now, and the change goes on; the new executor's wake note says "Go on from the branch
  {fromBranch}." or, with none, "Go on from what was last pushed for this task; what {host} saved comes back as a branch
  when it returns." `update_task` gains `from_branch` (optional, a branch name).
- `STOPPED_ON_PURPOSE` gains `superseded`.
- `jobOf`: a token of a job `failed` with `error` `superseded` gives the job with `moved` its `result`; `mcpRoutes` then
  answers every tool with it through `cutOff(server, { text: <moved>, keep: new Set() })`; other routes that take a
  job's token answer 409 `conflict` with it (reason `moved`).
- The hello: a listed job `failed` with `error` `superseded` gets no `job.cancel`; its `job.done` later is handled as
  today's for a job that ended, with its `job.ack`.
- `taskDetail`'s `away`: the task's executor job among `awayJobs`: its machine's hostname, `at` its newest agent event's
  time (else `started_at`), `until` `since + AWAY_WAIT_MS`; else null. The page shows `task.away`: "Work saved on
  {machine} at {at}, not sent yet" / «Работа сохранена на машине {machine} в {at}, еще не отправлена», `{at}` as
  `HH:MM`.
- The wake texts, by `wakePrompt`:
  - `away`: "{agent}'s turn on #{n} runs on {host}, which Hornhoof cannot reach since {time}. Its work is kept there. If
    its branch was pushed since, you may give the task to another agent now with update_task and from_branch naming that
    branch; else it waits for {host} up to 30 minutes."
  - `away_long`: "#{n} has waited 30 minutes for {host}. You may give it to another agent with update_task; it goes on
    from what was last pushed, and what {host} saved comes back as a branch when it returns."
- `bodyOf` (plan 8), under "Code:": one line per task event `saved` since the merge's `from_at`, "Saved work of #{n} is
  on {branch}.", then ruling 11's line about `@` branches.

- [ ] **Step 1: Write failing tests.**
  - `away.test.ts`, on `createTestSql` with a hub fake, a task with its executor's job `running` on node N:
    - `tells the head once, then again at 30 minutes`: N away 30 s: nothing; 61 s: one wake `away` to the giver; again
      at 5 minutes: none more; 30 minutes: one `away_long`; never a `job.cancel` or a failed job.
    - `waits while apart`: `splitSide` set: no wake.
    - `moves the task only with the branch before 30 minutes`: `update_task` with a new executor at 10 minutes: 409;
      with `from_branch` `task-41`: the old job `failed` `superseded` with the moved text naming the new executor and
      its machine, the new executor woken with "Go on from the branch task-41."; at 31 minutes without it: allowed, the
      other note.
    - `keeps the task on an apart side`: `splitSide` set: 409 "stays with".
    - `answers a moved job's every call`: the old job's token: `tools/call` of `tasks` and of `update_task` both answer
      the moved text with `isError`; `hh-attach`'s route: 409 `moved`.
  - `reconcile.test.ts`: `keeps a task's turn on a machine that is away`: N away 10 minutes: the task's job still
    `running`; a turn of no task: `failed` `machine_offline` as today; `mergePending` true: neither fails.
  - `task-tools.test.ts`: `update_task` takes `from_branch`; a bad branch name is refused as `Branch` refuses it.
  - `nodes.test.ts`, `keeps a superseded job at hello`: a hello listing it: no `job.cancel`; its `job.done`: acked, the
    row unchanged.
  - `merge-task.test.ts`: `lists the saved branches`: a merge with a `saved` event since its `from`: the line and the
    `@` line under "Code:".
  - `TaskDetail.test.tsx`: `says the work waits`: `away` set: "Work saved on Debian at 14:05, not sent yet".
  - `i18n.test.tsx`: the new key in both languages.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep the turns of a machine that cannot be reached, tell their heads, and move a task after 30
  minutes".

### Task 8: The lab: a leader that loses the internet

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 7 committed. **Done when:** from the worktree
root `npm run test:lab` passes with Docker running, after the disk check; `npx tsc -p apps/server/tsconfig.json
--noEmit` prints nothing.

**Files:**
- Create: `apps/server/test/lab/cut-off.test.ts`
- Test: the scenario itself

**Interfaces:**
- Consumes: plan 11's `homes`, `heal`, `relayCut`, `internet`, `internetStub`, `playRelay`, `relay()`'s `down` and `up`;
  plan 10's `leaderOf`, `confirmedOf`, `lateConfirms`, the read cookie's sign-in; plan 9's `startWriter`, `checkRows`;
  plan 9c's built-in node per machine.
- `cut-off.test.ts`, one scenario, 45 minutes at most, the disk check first:
  1. m1 a server with the lab's relay, edge and `playRelay`; m2 number 2 named sync, `ready`. In m1's built-in node
     container, as its node's user, a clone in `/data/work/agents/<an agent's id>/repo` of a repository made there, with
     one commit, a staged change, an unstaged change and an untracked file; its `git status --porcelain` and the bytes
     of `.git/index` noted. A writer with `leaderOf([m1, m2])`.
  2. "Leader loses internet, copy elsewhere": `homes([[m1], [m2]])`, `relayCut(m1, true)` and `internet(m1, false)` at
     t0. Within 15 s m1's `/api/keeper` says `read`, and its `GET /api/network/switch` says `noInternet`; within 90 s m2
     leads under plan 10's takeover, its handover from m1. Within 60 s of m1's `read`, the clone has a ref under
     `refs/hornhoof/saved/`, its status and index bytes as noted, and m1's node container has `/data/tools/apart`
     holding m1's slug. m1 never leads in the next 3 minutes.
  3. "Go on here": the owner, signed in on m1's own address with the read cookie: `GET /api/recovery` has `here` with
     `lost` m2's hostname; `POST /api/recovery/here`: 202. Within 30 s m1 leads under a split term whose handover is of
     kind `split` with `reason` `here`, and its switch word says `apart`. A writer on m1 for 60 s beside m2's.
  4. "Coming back": `heal()`, `relayCut(m1, false)`, `internet(m1, true)`. Within 10 s m1 steps down (two beats of m2's
     takeover term, above m1's last normal term) and follows m2; within 15 minutes m1's led merge is `merged` or `done`.
     `/data/tools/apart` is gone from m1's node container once m1 follows.
  5. The writers stopped. Once m1's copy is `ready` (2 minutes at most), `checkRows` of m1 and m2 for every id the
     writers kept is empty, and `lateConfirms(await confirmedOf(m2, <every kept write>))` is empty.

- [ ] **Step 1: Write the failing test**; `npm run test:lab` fails at step 2.
- [ ] **Step 2: Fix** what it finds in Tasks 1 to 7, each fix with its failing test first in that task's test file.
- [ ] **Step 3: Check the disk, then run Done when,** as plan 7's Task 10 Step 3. Expected: PASS.
- [ ] **Step 4: Commit** "Test in the lab a leader that loses the internet: saved work, Go on here and the merge".

### Task 9: Run everything and review

**Repo:** the `network` worktree, branch `network`. **Starts from:** Tasks 1 to 8 committed and reviewed. **Done when:**
Steps 1 and 2 pass for the agent; Step 3 is the team lead's, never an agent's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` and `npm run
  test:lab` (after the disk check) → pass; the `tsc` commands → no output.
- [ ] **Step 2: Check the public-repo rule.** As plan 7's Task 11 Step 2.
- [ ] **Step 3: Review.** The team lead reads the branch against the spec sections this plan names, plan 11's entry and
  this plan's rulings, with Review Focus first; the CLI agent that did not write a task reviews it too; one fix pass,
  each fix with its failing test first.

The rehearsal, the merge into main, Ivan's Updates and the worktree's close are done once, for the whole series, at its
end. This plan's part of that rehearsal is Task 8's scenario and, on the rehearsal's company, Ivan's Mac with its Wi-Fi
off while an agent works.
