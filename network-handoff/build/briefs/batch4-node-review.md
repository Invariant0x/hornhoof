# Build rulings (they override the plan)

1. One branch for everything. A plan's "Repo" line that names its own worktree or branch (relay-contract, backups, ...)
   means the Hornhoof clone `/home/altera/hornhoof-network/hornhoof` on its local branch `network`. "Starts from: main
   with plan N merged and shipped" and "Handed over" mean "plan N's tasks are complete on this branch". The relay repo
   is `/home/altera/hornhoof-network/hornhoof-edge`, local only: no remote, no push. Mac paths in a plan
   (`/Users/0x/Projects/...`) mean those two folders; `notes/specs/` means `/home/altera/hornhoof-network/specs/`,
   `notes/plans/` means `/home/altera/hornhoof-network/plans/`; `notes/ops/` is not on this machine.
2. Never deploy, ship or rehearse. Skip every step a plan marks as the team lead's or Ivan's: deploying the relay to the
   droplet, hornhoof.org, or any ssh; a rehearsal on a stand; `install.sh` against a real company; an Update; a
   `request.json` on a company; a merge into main; a push; anything on GitHub.
3. Code that a plan says depends on plan 1 being deployed is written and tested against the local relay the tests and
   the lab start. Never against the real one.
4. `~/.hornhoof-edge/` is not on this machine and is not created: no private-words file, no keys, no ssh config. Any
   plan step that writes or reads there is the lead's to rule on; report it, do not do it.
5. Migration numbers: the number is what `drizzle-kit generate` gives: the plan's number plus 11 (`0053_session_handover` to
   `0071_go_on_here`), and a plan's text and tests read so. Main's newest is `0052_dismissed_command_blocks`. One migration lane at a
   time, in the order 1b T1, 1b T3, 1b T7, 3 T2, 4 T1: a lane that was overtaken deletes its own migration, snapshot and journal
   entry and generates again after `lane.sh refresh`.
6. Docker is not used in this build. Do not run, build, pull, exec or inspect anything in Docker, on this machine it
   runs a live company. A plan's step or test that needs Docker is reported to the lead; write the test so that it is
   skipped when Docker is not there only if the plan's own command (`npm run test:real`) already keeps it apart, and go
   on with the rest.

# The machine's rules (from CLAUDE.md, they bind you)

- Files, code, commits, ledger lines, briefs: English. Comments are plain sentences that say why. Never use em dashes,
  in code, docs, commits or messages. In Russian UI strings write "е", never "ё".
- TDD for everything: the failing test first, watch it fail for the right reason, then the code, then watch it pass. A
  bug is fixed only after a test reproduces it.
- Uncle Bob's clean code: small functions, names that say what things are, no duplicated logic.
- Hornhoof's own rules: `hornhoof/AGENTS.md` and `hornhoof/templates/skills/dev-engineering-rules.md`.
- You commit only on your own lane's task branch, through `network-build/lane.sh commit`; the lead lands batches. Never push. No new remote, no branch on GitHub.
  Never rewrite history. Never commit or create `notes/`, `.superpowers/`, `.claude/`, `node_modules/`, `archive/`,
  `companies/`, `deploy.env`, `.metrics/`.
- Never print a secret value: keys, tokens, passwords, generated visitor keys. A generated key lives only in its one
  response; tests compare it with booleans and fixed messages.
- Never put Ivan's email or any personal data into a request to an outside service. Never read or copy credentials: not
  `~/.claude` credentials, not `~/.gemini`, not `~/.ssh`, not any Docker volume.
- Nothing on the relay droplet: no ssh to it, no deploy. GitHub: reading is fine, public release downloads with their
  checksum checked are fine, nothing is sent to GitHub. Tests never reach hornhoof.org or a real company.
- This machine is a-host. It runs Ivan's company Hornhoof in Docker (containers named `hornhoof-*`) and belongs to his
  family. Never touch Docker that is not yours. No sudo. Work only inside `~/hornhoof-network`; other folders in the home
  belong to the machine's owner, do not read or change them. Temporary files go in
  `/home/altera/hornhoof-network/network-build/tmp` or the temporary folders tests make for themselves.
- Keep the load moderate, the company runs here: vitest with `--maxWorkers=2`, at most two heavy runs at once across the
  whole team. About 7 GB of memory is free. Every test or gate run goes through one of two wrappers, which also keep real
  Docker out of reach: `/home/altera/hornhoof-network/network-build/light.sh <command>` for a focused run of a few tests,
  and `/home/altera/hornhoof-network/network-build/heavy.sh <command>` for a full suite or coverage run (it waits for a
  free slot, so it may wait some minutes).
- Skills, in `/home/altera/hornhoof-network/plugins/superpowers/skills/<name>/SKILL.md`; read and follow them:
  `test-driven-development`, `systematic-debugging` for any failure, `verification-before-completion` before you claim
  anything is done.
- An irreversible, destructive or security-sensitive step, or a side effect outside this folder: do not do it, report it.


# You are the reviewer (read-only)

Another agent wrote the task below. You review it; you do not fix it. Two reviewers work at once, independently.

- Do NOT edit, create, move or delete any file in either repository. Do not commit, stage, push, run prettier or any
  formatter. Temporary files only under `/home/altera/hornhoof-network/network-build/tmp/<your own new folder>`.
- Read the change (the review package named below), compare it line by line with the brief: the plan's top part, its
  Review Focus, its Global Constraints, the build rulings and the build lead's rulings, and the task's Files, Interfaces
  and Steps. Spec: `/home/altera/hornhoof-network/specs/2026-11-02-single-network-design.md`. Ledger of earlier rulings,
  all of which stand: `/home/altera/hornhoof-network/network-build/progress.md`.
- Use `git diff`, `git show --format=%s`, or the package; do not print full `git log` output, it carries an author's
  email address, and nothing of the kind goes in your report.
- Tests (Ivan's word): do not ask for a test only to cover a line, pin a condition or raise a number. Report a missing or weak test as Important only when a named harm to a person could reach production unseen, and say which. Do not ask for old tests to be rewritten. A test that passes with the code wrong, on what the task promises, is still a finding.
- Judge every finding by what a person using Hornhoof would get. Critical: a person loses data or access, a company is
  exposed or cut off, or the task's promise is false. Important: a real gap against the brief, or a test that would
  pass with the code wrong. Minor: anything else.
- Look hardest at: behavior that differs from the Interfaces; tests that would pass even if the code were wrong (weak
  asserts, sleeps instead of waits, skipped checks); any secret value that could reach a log, a test message or a
  report; anything private or any em dash in a tracked file; fail-open reads; processes or ports left behind; Python
  syntax newer than 3.12 in relay files; facts in docs that are not true at this commit.
- Check the build's rules as findings too: was each new test seen failing first, is any changed function over CRAP 10, any
  duplicate pair at 0.8; small functions, names that say what things are, comments that say why. Mutator is not part of a task's or a plan's review; it runs once, at the end of phase 1.
- Reproduce before you claim: for a Critical or Important say how you checked it (the command or the reasoning from
  named lines). Run a focused test only when it settles a doubt; the lead already ran the full suite and gives you its
  result. At most `nice -n 10`, one run at a time. You do not dispatch subagents.
- Report, as your final message, a list of findings, each: severity, `file:line`, what is wrong, what a person would
  get, what would make it right. Say so if you find nothing at a severity. Keep it short and concrete. Never print a
  key or token value.

# This review: conveyor v4, one review per batch

- You read batch 4, slice node, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-4, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch4-node.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# Your slice: node messages that survive a restart (4 T4's protocol part, T5)

A node's numbered messages kept in its volume until the server confirms: what a person loses if a message is lost, doubled or reordered across a restart. The server part of T4 comes later and is not here. `runNode`'s CRAP over 10 is ruled on in the ledger; do not raise it. Old nodes must keep working for one version.

# The tasks

## 2026-11-03-network-phase-1-plan-4-work-survives-restart, Task 4

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys made at run time.
- No new dependency.
- Two new migrations, never an edit of an older one: `0047_steps` by `npx drizzle-kit generate --name steps` and
  `0048_calls` by `npx drizzle-kit generate --custom --name calls`, both from `apps/server`; in `0048_calls.sql` each
  statement is its own chunk, separated by `--> statement-breakpoint`.
- Messages stay readable across one version (spec section 9): a node of plan 3's build works with this server as it
  did, and a node of this build works with plan 3's server as it did. Every field this plan adds to a message is
  optional, and every message it adds is one an older side drops (`parseNodeMessage` and `parseServerMessage` answer
  `null` for an unknown type, and zod drops unknown keys).
- Fail toward a change applied once: a source `applied` lists is never applied again but where ruling 5 says; when
  its answer is lost, the caller is told so (`already_done`, `ALREADY_RAN`, `PENDING`), never given a second run.
- Plan 3's rules hold: nothing in `apps/server/src` opens a pool or client outside the three files that own them, and
  the fence lint passes.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/node`,
  `apps/web` and `packages/protocol` the same with their test file. After a change to `packages/protocol`, run `npm run
  build -w @hornhoof/protocol` from the worktree root before the server's or the node's tests. The whole suite from
  the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`; the real tests: `npm run
  test:real`, which needs Docker. Types, from the worktree root, for each part a task touched: `npx tsc -p
  apps/server/tsconfig.json --noEmit`, `npx tsc -p apps/node/tsconfig.json --noEmit`, `npx tsc -p
  apps/web/tsconfig.json --noEmit`, `npx tsc -p packages/protocol/tsconfig.json --noEmit`, each printing nothing.
  Never run prettier.


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


## 2026-11-03-network-phase-1-plan-4-work-survives-restart, Task 5

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys made at run time.
- No new dependency.
- Two new migrations, never an edit of an older one: `0047_steps` by `npx drizzle-kit generate --name steps` and
  `0048_calls` by `npx drizzle-kit generate --custom --name calls`, both from `apps/server`; in `0048_calls.sql` each
  statement is its own chunk, separated by `--> statement-breakpoint`.
- Messages stay readable across one version (spec section 9): a node of plan 3's build works with this server as it
  did, and a node of this build works with plan 3's server as it did. Every field this plan adds to a message is
  optional, and every message it adds is one an older side drops (`parseNodeMessage` and `parseServerMessage` answer
  `null` for an unknown type, and zod drops unknown keys).
- Fail toward a change applied once: a source `applied` lists is never applied again but where ruling 5 says; when
  its answer is lost, the caller is told so (`already_done`, `ALREADY_RAN`, `PENDING`), never given a second run.
- Plan 3's rules hold: nothing in `apps/server/src` opens a pool or client outside the three files that own them, and
  the fence lint passes.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/node`,
  `apps/web` and `packages/protocol` the same with their test file. After a change to `packages/protocol`, run `npm run
  build -w @hornhoof/protocol` from the worktree root before the server's or the node's tests. The whole suite from
  the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`; the real tests: `npm run
  test:real`, which needs Docker. Types, from the worktree root, for each part a task touched: `npx tsc -p
  apps/server/tsconfig.json --noEmit`, `npx tsc -p apps/node/tsconfig.json --noEmit`, `npx tsc -p
  apps/web/tsconfig.json --noEmit`, `npx tsc -p packages/protocol/tsconfig.json --noEmit`, each printing nothing.
  Never run prettier.


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


