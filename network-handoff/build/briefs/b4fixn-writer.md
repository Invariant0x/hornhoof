# How this build works now: conveyor v4, Ivan's word

Rules that bind you, not optional: `/home/altera/hornhoof-network/CLAUDE.md`, the build rulings below, and
`/home/altera/hornhoof-network/FROM-DAVID-conveyor-v4.md`, sections 2 to 4. You are a fresh writer for one task, in your own lane, your own clone of
the repository, on the branch `task-<lane>`. Other writers work beside you in theirs. Do not touch the real repositories or another lane.

**Skills.** Before you write a line, read and follow, and name in your hand-in: `test-driven-development`, `systematic-debugging` for any failure, `verification-before-completion`, in `/home/altera/hornhoof-network/plugins/superpowers/skills/<name>/SKILL.md`. For Hornhoof also `hornhoof/AGENTS.md` and `hornhoof/templates/skills/dev-engineering-rules.md`.

**The task's kind** is in your notes. Known behaviour, nearly every task, since plans give exact tests: test-first, as the plan says. A bug: a failing test that reproduces it, then the fix. An unknown way (a library or protocol not used here yet): one acceptance test from the plan first, then make it work, split into pure functions, cut what is extra, then direct fast tests on the pure functions. Old code with no tests: characterization tests first, then structural commits apart from behaviour commits.

**How to write tests.** Uncle Bob's way, without chasing coverage. Logic in a pure function, tested directly, with no database and no process. One or two integration tests per route or seam, for what only they can show, not one per branch. A test checks what a person of the code would see; if it would pass with the code wrong, throw it out. No test only to cover a line or raise a number. To get a function under CRAP 10, split it first. Tests are deterministic: nothing depends on the date, the time zone, the order of tests, randomness or ids; a flaky test is fixed at its cause, never retried. Old tests are not rewritten. Never a secret in a test's message: compare with booleans.

**While you work,** run a few tests at a time from your lane with `/home/altera/hornhoof-network/network-build/light.sh <command>`, with at most `--maxWorkers=2`. You do not run a repository's whole suite, and you do not run mutator.

**Hand-in, one command, once, on your final commit:**

1. Commit your work on your branch: write the message to a file (English, a subject as the plan's Commit step names it, then why; no trailers; no em dashes), then `/home/altera/hornhoof-network/network-build/lane.sh commit <lane> <file>`.
2. The author check, on that commit. Hornhoof: `REMOTE_HORNHOOF_TREE=/home/altera/hornhoof-network/wt/<lane> /home/altera/hornhoof-network/network-build/remote.sh run <lane>-check 'cd /home/altera/hornhoof-network/hornhoof && /home/altera/hornhoof-network/network-build/author-check.sh lanebase'`. Relay: `REMOTE_EDGE_TREE=/home/altera/hornhoof-network/wt/<lane> /home/altera/hornhoof-network/network-build/remote.sh run <lane>-check 'cd /home/altera/hornhoof-network/hornhoof-edge && /home/altera/hornhoof-network/network-build/author-check-relay.sh lanebase "<the unittest modules your change reaches>"'`. It may queue. Start it in the background and wait with `/home/altera/hornhoof-network/network-build/remote-wait.sh <lane>-check` in the foreground, calling it again while it says WAITING. Never end your turn while it is pending.
3. Red: at most two tries to fix your own red, each commit followed by the check. Still red: stop and tell the lead.

**Reply to the lead:** the status (DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT), the commit, and the log path `network-build/runs/remote-<lane>-check-*.log`, in at most five lines. That log on that commit is the evidence, and nobody reruns it. There is no review agent per task; tasks land in batches, and the batch gets one review and one fix round. A deviation from the plan, and every place where the plan proved wrong, goes in your commit message's body and your reply, as a line `Ruling: <what> - why: <why> - cost if wrong: <cost>`. Never push. No subagents.

# Your task: batch 4 fix round: node messages

Lane `/home/altera/hornhoof-network/wt/b4fixn`, from batch-4, branch `task-b4fixn`. Kind: bugs. Your whole list: `/home/altera/hornhoof-network/network-build/runs/batch4-node-merged.md`, the review beside it. Commit subject: "Keep a removed node from revoking its own new key, and lose no node message on a reconnect or a full disk". A protocol change makes the author check run server, node and web whole, once. `runNode`'s CRAP over 10 is ruled on in the ledger; do not raise it, and do not split it now.

# How you work (writer)

The top of your notes says how; a task's "Commit" step is your hand-in's commit. Change only the task's files. No `npm install`/`npm ci` unless the task names a dependency to add. Never run prettier or any formatter. Shell is bash on Debian Linux, x86_64, GNU tools. Python for the relay: standard library only, runnable on Python 3.12 (`/home/altera/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12`; 3.14 at `/home/altera/hornhoof-network/quality/python/cpython-3.14-linux-x86_64-gnu/bin/python3.14`). There is no pytest. Stop and report when a fact the task rests on proves wrong in the code.
### Task 4: Node messages, numbered and confirmed by the server

**Repo:** Hornhoof worktree, branch `work-survives`. **Starts from:** Task 3 committed. **Done when:** from
`packages/protocol`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/protocol.test.ts` passes; then `npm run
build -w @hornhoof/protocol` from the worktree root; from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest
run test/node-messages.test.ts test/socket.test.ts test/conversation.test.ts test/hub.test.ts
test/tasks-reconcile.test.ts` passes, then the whole server suite; both `tsc` commands (protocol, server) print
nothing.

**Files:**
- Modify: `packages/protocol/src/index.ts`, `apps/server/src/modules/nodes/hub.ts` (`keyOf` exported),
  `apps/server/src/modules/nodes/messages.ts`, `apps/server/src/modules/nodes/socket.ts` (the header),
  `apps/server/src/app.ts` (`onNumbered`), `apps/server/test/helpers.ts` (`FakeNode` gains `upto: number[]`: each
  `ack`'s `upto` lands there, not in `next()`)
- Test: `packages/protocol/test/protocol.test.ts`, `apps/server/test/node-messages.test.ts` (new),
  `apps/server/test/socket.test.ts`

**Interfaces:**
- Consumes: `withSource`, `nodeSource`, `listed`, `touch` (Task 1); `isLeaseRefused`, `notConfirmed` (plan 3);
  `whileLeading` (plan 2).
- Produces:
  ```ts
  // packages/protocol
  export const NUMBERED = ['job.started', 'job.event', 'job.done', 'tests.started', 'tests.done', 'cred.sealed', 'login.done', 'agent.context', 'removed'] as const;
  //   each of these messages gains n?: number (an integer from 1); hello gains stream?: string (a uuid)
  //   ServerMessage gains { type: 'ack'; upto: number } (an integer from 0)
  export function isNumbered(m: NodeMessage): boolean;   // its type is in NUMBERED
  export const ACKS_HEADER = 'hornhoof-acks';            // '1' on the upgrade answer of a server that sends ack
  // modules/nodes/messages.ts
  export const AGAIN_WHEN_LISTED: ReadonlySet<string>;   // 'job.done' and 'tests.done' (ruling 5)
  export function passing(err: unknown): boolean;
  //   on err or one of its causes: isLeaseRefused, notConfirmed, an ApiError with status 503, or code 40001, 40P01,
  //   55P03, 57P03, 53300, ECONNREFUSED, ECONNRESET, ETIMEDOUT or one starting with 08
  export function handleNumbered(ctx: Ctx, id: NodeIdentity, stream: string, msg: NodeMessage & { n: number }): Promise<boolean>;
  //   base = nodeSource(keyOf(id), stream, msg.n); when listed: a type in AGAIN_WHEN_LISTED runs handleNodeMessage in
  //   withSource(base, ..., listed.steps), any other gets touch; else handleNodeMessage in withSource(base, ...).
  //   Then true; an error that is passing gives false; any other is logged as 'A node message failed.' is today,
  //   then true
  ```
- `socket.ts`: the upgrade answer of `/api/nodes/socket` carries `Hornhoof-Acks: 1` (`app.websocketServer`'s
  `headers` event, for that path only).
- `hub.ts`: `HubOptions` gains `onNumbered(id: NodeIdentity, stream: string, msg: NodeMessage & { n: number }):
  Promise<boolean>`, and `Entry` gains `stream: string | null` (from the socket's first hello that names one; a later
  hello's stream is ignored) and `refused: boolean`. A numbered message with `n` on an entry with a stream takes its
  place in the socket's chain with the stream it had when it came, as `onNumbered`: `true` sends `ack { upto: n }`
  on that message's own socket; `false` sets `refused` and closes that socket with 1013 `Hornhoof could not take this
  now; send it again.` Once `refused` is set, every link of that chain still waiting runs nothing. A message without
  `n`, or on an entry without a stream, runs through `onMessage` as today, with no source and no ack. `stop()` stops
  taking messages, waits up to 5 s for each socket's chain to settle, then closes the sockets with 1001.
- `app.ts`: `onNumbered` runs `handleNumbered` only while `ctx.mode.current()` is `lead`, and gives `false`
  otherwise, so nothing that nothing handled is acked; the `onClose` hook awaits `ctx.hub.stop()` before the
  database closes. `job.ack` and `tests.ack` are sent as today.

- [ ] **Step 1: Check what each numbered message commits.** For each type of `NUMBERED` but `job.done` and
  `tests.done`, read its handler and what it awaits: it must commit at most once, follow-ups included. One that
  commits more than once is put in one `db.transaction` when its writes allow it, else named in the report.
- [ ] **Step 2: Write failing tests.**
  - `protocol.test.ts`, `numbers what changes data and stays readable`: a `job.event` with `n: 3` parses with `n`; one
    without `n` parses; a hello with a `stream` parses; `ack { upto: 4 }` parses as a server message; a `job.event`
    with `n: 0` is `null`; a message with a key no schema names still parses (zod drops it).
  - `node-messages.test.ts`, on `testApp()` listening, a company with an API-key subscription and a plan node, and
    `connectNode`:
    - `says it confirms on the upgrade`: the upgrade answer of `/api/nodes/socket` has `hornhoof-acks: 1`.
    - `applies a numbered message once`: a running turn's `job.event` with `n: 5`, sent twice on one stream, gives one
      `agent_events` row and two `ack { upto: 5 }`; `applied` lists `node:builtin:<stream>:5:0`.
    - `keeps each node's numbers apart`: the built-in node and the plan node, each with a running turn, send a
      `job.event` with the same stream and `n`: both are stored.
    - `handles a job's end again when listed`: `job.done` with `n: 7`, `ok: false` and `error: 'agent_failed'`, sent
      twice, ends the job once with one `failed` event (`afterJob`'s); the base's steps go on from where the first
      left off; both copies get `ack { upto: 7 }`, and `job.ack` comes for each as today.
    - `takes a message again after a passing failure, and nothing after it`: with `setLease(db, { until: '-infinity'
      })`, `job.event`s with `n` 8 and 9 sent together: the socket closes with 1013, no ack comes, no row is added;
      with the lease back, a new socket's hello and the same two messages give two rows and acks 8 and 9 in order.
    - `takes a deadlock as passing`: with `vi.mock` of `src/modules/events/store.js` that keeps its other exports and
      makes `appendEvent` throw an error with code `40P01` once when the test sets a flag, the socket closes with
      1013; the same message on a new socket is stored and acked.
    - `acks a message that failed for good`: the same mock throwing `new Error('broken')` once: that `job.event` is
      acked and the error logged; the next message is handled.
    - `acks on the socket the message came on`: with `appendEvent` held 300 ms by the mock, a second socket of the
      same node that connects meanwhile gets no `ack` of the first socket's message.
    - `lets queued messages finish when the app stops`: with `appendEvent` held 300 ms, `app.close()` right after a
      `job.event` is sent: the event is stored and acked before the socket closes with 1001.
    - `talks to a node of the build before as today`: a hello without a stream and `job.event`s without `n` are
      stored, no `ack` comes, the same event sent twice is stored twice, and `job.done` without `n` gets `job.ack`.
  - `socket.test.ts`: every test as it is.
- [ ] **Step 3: Run** Done when. Expected: FAIL (no `n`, no header).
- [ ] **Step 4: Implement** the interfaces above.
- [ ] **Step 5: Run Done when.** Expected: PASS.
- [ ] **Step 6: Commit** "Number the node messages that change data, and confirm each once it is applied".

### Task 5: The node's outbox

**Repo:** Hornhoof worktree, branch `work-survives`. **Starts from:** Task 4 committed. **Done when:** `npm run build -w
@hornhoof/protocol` from the worktree root; from `apps/node`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run
test/outbox.test.ts test/main.test.ts test/connection.test.ts test/isolation.test.ts test/commands.test.ts` passes,
then the whole node suite; `npx tsc -p apps/node/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/node/src/outbox.ts`
- Modify: `apps/node/src/main.ts`, `apps/node/src/connection.ts`, `apps/node/src/isolation.ts` (`secureNode`)
- Test: `apps/node/test/outbox.test.ts` (new), `apps/node/test/main.test.ts` (its `fakeServer` takes `{ acks }` and
  then sends the header), `apps/node/test/connection.test.ts`, `apps/node/test/isolation.test.ts`

**Interfaces:**
- Consumes: `NUMBERED`, `isNumbered`, `ack`, `ACKS_HEADER` (Task 4).
- Produces:
  ```ts
  // apps/node/src/outbox.ts
  export const OUTBOX_FILE = 'outbox.jsonl';
  export const OUTBOX_MAX = 20_000;
  export type End = Extract<NodeMessage, { type: 'job.done' | 'tests.done' }>;
  export type Entry = { n: number; msg: NodeMessage };
  export class Outbox {
    constructor(dir: string, opts?: { max?: number; flushMs?: number });   // max OUTBOX_MAX, flushMs 1000
    readonly stream: string;     // read from the file, or a new uuid with a new file
    add(msg: NodeMessage): Entry;   // the next n; the message carries it; kept
    hold(end: End): void;           // kept with no n yet: a job's or a part's end before its turn to be sent
    number(id: string): Entry | null;  // gives the held end of that job or part its n; null when none is held
    held(): string[];               // the jobs and parts whose ends are held
    pending(): Entry[];             // the numbered entries, in order of n
    ack(upto: number): void;        // drops every numbered entry up to upto
    ackJob(jobId: string): void;    // drops that job's end (the old job.ack)
    ackPart(partId: string): void;  // drops that part's end (the old tests.ack)
    dropSent(upto: number): void;   // drops every numbered entry up to upto but the ends (an older server)
    doneJobs(): string[];           // the jobs whose ends are held or numbered
    doneParts(): string[];          // the parts whose ends are held or numbered
    close(): void;                  // writes what waits
  }
  //   The file, mode 0600, is appended a line per change; drops are written by rewriting it (to a temp file, then a
  //   rename) at most once per flushMs. On open, a last line without its newline, or not JSON, is cut off the file
  //   before anything is appended, and the next n is above every n the file holds or held (a rewrite keeps it).
  //   Past max, the oldest job.event goes first (the oldest entry that is not an end when none is left); ends are
  //   never dropped by the cap.
  ```
- `main.ts`: numbered messages go through `outbox.add`, but a job's end is held with `hold` where `keep` is today
  (before the job leaves `running`) and numbered with `number` where `emit(done)` is today; a part's end the same
  where `keepTest` and its `emit` are. On open: the hello carries `stream`, `running` adds `doneJobs()` and `tests`
  adds `doneParts()`, as the unconfirmed maps did, which go; every held end is numbered; every pending entry is sent
  in order, then each new one as it is numbered. When the upgrade answer had `hornhoof-acks: 1`, `ack` drops what it
  confirms. When it did not: after sending the pending entries, `dropSent(<the last n sent>)`, and each later
  numbered message is dropped once sent unless it is an end. `job.ack` and `tests.ack` call `ackJob` and `ackPart`
  either way. A `tests.run` for a part whose end the outbox holds is skipped, as `unconfirmedTests.has` does today.
  Unnumbered messages that cannot be sent wait in memory as today. `stop()` calls `close()`.
- `connection.ts`: `onOpen(send, acks)` gets `acks` true when the upgrade answer had `hornhoof-acks: 1`; the default
  backoff stops growing at 10,000 ms; `backoff` gains `refusedMs` (60,000), the wait after a 401 or a close with
  4001, as today's 60 s; the socket gets `handshakeTimeout` `handshakeMs` (20,000). `secureNode`: `outbox.jsonl`
  joins the root-owned files.

- [ ] **Step 1: Write failing tests.**
  - `outbox.test.ts`, on a temp folder:
    - `numbers messages and keeps them across a restart`: three added; a new `Outbox` on the folder has the same
      `stream` and pending `n` 1 to 3, and its next `add` gets 4.
    - `drops what the server confirmed`: `ack(2)` leaves `n` 3, also after reopening.
    - `numbers a held end when its turn comes`: an end held, then a `job.event` added (`n` 1), then the end numbered
      gets `n` 2; `doneJobs()` lists the job from `hold` on; the held end survives a reopen.
    - `keeps a job's end until either ack`: an end stays after `ack` of a lower `n`, and goes on `ackJob` of its job;
      a `tests.done` goes on `ackPart`.
    - `drops live messages when it talks to an older server`: of five entries, `dropSent(3)` keeps the ends among the
      first three, and entries 4 and 5.
    - `writes the file for its owner only`: `outbox.jsonl`'s mode is `0600`.
    - `caps the outbox, but never an end`: with `max` 10, fifteen `job.event`s and 60 ends keep the 60 ends and the
      newest events that fit, none dropped while it is an end.
    - `recovers from a line cut short`: three added, half a line written to the file by hand, a new `Outbox` on it
      adds one more, and another new `Outbox`, with no `close()` before it, has four entries, `n` 1 to 4.
  - `main.test.ts`, with `fakeServer()`:
    - `sends numbered messages again until the server confirms them`: a server with `{ acks: true }` that drops the
      socket after two `job.event`s without an ack gets both again, in order, after the next hello; after it acks
      them and drops the socket again, nothing numbered comes after the hello.
    - `keeps its messages through its own restart`: a `job.event` made while no server listens, `stop()`, and a new
      `runNode` on the same folder: once a server listens, the event arrives after hello, with the same stream and
      `n`.
    - `talks to a server of the build before`: a server without the header gets the pending messages right after
      hello; when it drops the socket, the next connection sends again only the `job.done` it did not `job.ack`.
    - `does not run a part again whose end waits for its ack`: a `tests.run` for a part whose `tests.done` was sent
      and not acked starts nothing.
    - main's tests of `job.done` and `tests.done` sent again until acked, and `commands.test.ts`'s `run --builtin`
      tests, keep passing as they are.
  - `connection.test.ts`, `waits at most 10 s between tries`: with fake timers and nothing listening, the waits are 1,
    2, 4 and 8 s, then 10 s each; after a 401 the next wait is 60 s. `gives up a handshake that gets no answer`: with
    `handshakeMs` 300, a server that takes the TCP connection and answers nothing gets a new try. `knows a server
    that confirms`: `onOpen` gets `acks` true from a server that sends the header, false from one that does not.
  - `isolation.test.ts`, `secureNode` makes `outbox.jsonl` root-owned when it exists.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no outbox).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep the node's messages in its volume until the server confirms them".

