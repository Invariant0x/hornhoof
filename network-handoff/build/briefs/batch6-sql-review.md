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

- You read batch 6, slice sql, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-6, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch6-sql.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# This slice

The `sql-check.ts` part of Plan 3 Task 3, with its dependency `libpg-query` 17.7.3. Security class: two readers at once, each alone. This was split off ahead of the task; `confirm.ts`, `agent-sql.ts`, `client.ts`, `database.ts` and the texts stay for that task's own writer, and nothing calls `checkAgentSql` yet, so do not report those as missing. The writer's rulings are the lines starting `Plan 3 Task 3: Ruling` in `/home/altera/hornhoof-network/network-build/progress.md`; a ruling is a claim to check.

Read the code and the parser's tree as a reviewer: does any statement or function ruling 4 refuses get past the walk, and is any ordinary statement refused that the plan lets through. Use the parser locally if a question needs it. Nothing here goes near a real database or a live service.

# The tasks

## 2026-11-03-network-phase-1-plan-3-fences-and-journal, Task 3

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and passwords made at run time.
- One new dependency, in `apps/server` only: `libpg-query` at exactly `17.7.3` (`npm install libpg-query@17.7.3
  --save-exact -w apps/server`), which brings `@pgsql/types`. Nothing else.
- Two new migrations, never an edit of an older one: `0045_sources` by `npx drizzle-kit generate --name sources` and
  `0046_net` by `npx drizzle-kit generate --custom --name net`, both from `apps/server`. In `0046_net.sql` each
  statement is its own chunk, the chunks separated by `--> statement-breakpoint` as in the generated files.
- Fail closed, toward a company that only reads: a fence function that cannot decide refuses; the keeper leads only
  with a lease it renewed and no fence problem; a write that fails at a fence reaches people as `read_only` or
  `not_confirmed` (503), never as "Something went wrong."
- The fence is the app's own for superusers (ruling 1): the app's pools say `hornhoof.fenced = on` when it runs with a
  keeper, the agent roles are fenced whatever they say, and nothing else in `apps/server/src` opens a pool or client.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web`:
  the same with its test file; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; the real tests from the worktree root: `npm run test:real`, which needs Docker. Types, always
  from the worktree root: `npx tsc -p apps/server/tsconfig.json --noEmit` and, for the task that touches the web app,
  `npx tsc -p apps/web/tsconfig.json --noEmit`, both printing nothing. Never run prettier.


### Task 3: The orchestrator's SQL, the app's commits and their errors

**Repo:** Hornhoof worktree, branch `fences-and-journal`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/sql-check.test.ts test/confirm.test.ts
test/fence-lint.test.ts test/db-pool.test.ts test/errors.test.ts test/orchestrator-control.test.ts
test/journal.test.ts` passes, then the whole server suite; from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx
vitest run test/i18n.test.tsx` passes; from the worktree root `npm run test:real` passes and both `tsc` commands print
nothing; the report has Step 1's list.

**Files:**
- Create: `apps/server/src/db/sql-check.ts`, `apps/server/src/db/confirm.ts`
- Modify: `apps/server/package.json` and `package-lock.json` (`libpg-query`), `apps/server/src/db/agent-sql.ts`,
  `apps/server/src/db/client.ts` (`stripSettings`, `openPool`, `openDb`), `apps/server/src/main.ts`,
  `apps/server/src/cli.ts`, `apps/server/src/modules/tools/database.ts`, `apps/server/src/errors.ts`,
  `apps/server/src/modules/keeper/app-mode.ts` (exports `READ_ONLY_MESSAGE`), `apps/web/src/i18n/en.ts`,
  `apps/web/src/i18n/ru.ts`, `apps/server/test/helpers.ts` (`agentSqlOn`)
- Test: `apps/server/test/sql-check.test.ts`, `apps/server/test/confirm.test.ts`, `apps/server/test/fence-lint.test.ts`
  (all new), `apps/server/test/db-pool.test.ts`, `apps/server/test/errors.test.ts`,
  `apps/server/test/orchestrator-control.test.ts`, `apps/server/test/journal.test.ts`, `apps/web/test/i18n.test.tsx`,
  `apps/server/test/real/agent-sql.test.ts` (new)

**Interfaces:**
- Consumes: `LEASE_REFUSED`, `isLeaseRefused`, `setLease` (Task 2); `realDatabase` (Task 1).
- Produces:
  ```ts
  // db/sql-check.ts
  export class SqlRefused extends Error { readonly kind: 'statement' | 'function' | 'syntax' }
  export const ONLY_STATEMENTS = 'This tool runs only SELECT, INSERT, UPDATE, DELETE and WITH statements; Hornhoof begins and commits the transaction itself.';
  export async function checkAgentSql(text: string): Promise<void>;
  //   libpg-query's parse; a parse error throws SqlRefused('syntax') with the parser's message; a statement that is not
  //   SelectStmt (without intoClause), InsertStmt, UpdateStmt or DeleteStmt throws SqlRefused('statement',
  //   ONLY_STATEMENTS); a FuncCall anywhere in the tree whose name is refused (ruling 4; the last part of funcname,
  //   lo_ as a prefix; any call qualified with net or net_local), or a refused name as a field (the last String of a
  //   ColumnRef with two or more fields, or a String in an A_Indirection's indirection), throws
  //   SqlRefused('function', `This tool does not call ${name}.`)
  // db/confirm.ts
  export class NotConfirmed extends Error {}   // 'The database could not confirm the commit, so the change may or may not be saved.'
  export function confirmCommits(client: pg.ClientBase): void;
  //   watches client.query in every form pg takes (text, text and values, a config object, each with or without a
  //   callback; a Submittable passes unwatched), as ruling 5 says: a call it watches that got a notice fails with
  //   NotConfirmed (cause: the notice) instead of its result; a call that failed keeps its own error. Twice on one
  //   client is once.
  export function keepErrors(client: pg.ClientBase): void;
  //   an 'error' listener for the client's whole life that does nothing, so an error between two queries cannot end
  //   the process; pg-pool still sees it, and the client's next query fails. Twice on one client is once.
  export function notConfirmed(err: unknown): boolean;
  //   on err or one of its causes: NotConfirmed; code 57P01, 25P04, ECONNRESET or EPIPE; a message starting
  //   'Connection terminated' or equal to 'Client has encountered a connection error and is not queryable' (what
  //   drizzle's ROLLBACK on a dead connection throws in place of the first error)
  export const requestRoute: AsyncLocalStorage<string>;   // '<METHOD> <route pattern>' of the request running, as 'GET /api/tasks/:id'
  export function logTimeouts(client: pg.ClientBase, log: (line: string) => void): void;
  //   notes when each BEGIN goes out on the client and requestRoute's store at that moment; the first error with code
  //   25P04 the client gets, as a query's error or between two queries, logs `The 5 s limit ended a transaction of
  //   <route> after <ms> ms.` (ruling 20): <route> that store, or `work outside a request` without one; <ms> the
  //   whole milliseconds since that BEGIN. A COMMIT, END or ROLLBACK that succeeds more than 2000 ms after its BEGIN
  //   logs `A transaction of <route> ran <ms> ms.` the same way. Twice on one client is once.
  // db/client.ts
  export function stripSettings(url: string): string;   // url without its options and application_name parameters (ruling 18)
  export function openPool(url: string, onDropped: (err: Error) => void, name: string, opts?: { statementTimeoutMs?: number; fenced?: boolean }): pg.Pool;
  //   connects to stripSettings(url) and runs keepErrors on each client it connects, for every name; name APP_NAME:
  //   options '-c transaction_timeout=5s -c client_min_messages=warning', plus ' -c hornhoof.fenced=on' when fenced,
  //   and confirmCommits and logTimeouts(client, console.warn) on each client; other names as in plan 2
  // db/agent-sql.ts
  export const PUBLIC_REVOKES: string;   // one DO block: REVOKE EXECUTE ... FROM PUBLIC on every overload in pg_catalog of the names in ruling 4
  export const REFUSED_FUNCTIONS: string[];   // those names, 'lo_*' standing for the prefix
  export const PRE_COMMIT = "SET LOCAL synchronous_commit = on; SET LOCAL statement_timeout = 0; SET LOCAL client_min_messages = warning; SELECT net.assert_lease('2 s', NULL)";
  // errors.ts: ErrorReason gains 'not_confirmed'; export const NOT_CONFIRMED = 'Hornhoof could not confirm this change. It may be saved; look before you try again.'
  ```
- `openAgentSql`: runs `PUBLIC_REVOKES` before the grants. `role()` takes each role's settings: the write role `RESET
  statement_timeout` and `SET transaction_timeout = '5s'`, the read role `statement_timeout = '15s'` as today, both
  `idle_in_transaction_session_timeout = '30s'`. The write role gets `GRANT USAGE ON SCHEMA net` and `GRANT EXECUTE ON
  FUNCTION net.assert_lease(interval, uuid)`; the read role nothing in `net`. Each agent pool's address starts from
  `stripSettings(url)`, and the pool runs `keepErrors` and `confirmCommits` on every client it connects. `run` in mode
  `write` sends `PRE_COMMIT` after the text and before `COMMIT`. `agentSqlOn` in `helpers.ts` applies `PUBLIC_REVOKES`
  with the grants and runs `PRE_COMMIT` under the write role the same way.
- `main.ts` and `cli.ts` open `openDb(url, APP_NAME, { fenced: config.keeper })`.
- The `database` tool runs `checkAgentSql(sql)` before `ctx.agentSql.run`. A `SqlRefused` answers `Hornhoof did not run
  this SQL: <message>`, followed in mode `read` for kind `statement` by a space and `READ_ONLY`. An error for which
  `notConfirmed(err)` is true answers `The database answered: <message> The call may have run; check before repeating
  it.` Everything else as today. In the write description, `Several statements run in one transaction and are undone
  together when one fails; a call may take 15 seconds.` becomes `Only SELECT, INSERT, UPDATE, DELETE and WITH statements
  run, several in one transaction that Hornhoof begins and commits, undone together when one fails; a call may take 5
  seconds.`; in the read one, `Several statements run in one transaction;` becomes `Only SELECT and WITH statements run,
  several in one transaction;`.
- `registerErrorHandling` adds, first, a `preHandler` hook that runs the rest of each request inside ``
  requestRoute.run(`${req.method} ${req.routeOptions.url}`, done) ``, and, before its 500: `isLeaseRefused(err)` answers
  503 `{ code: 'unavailable', message: READ_ONLY_MESSAGE, reason: 'read_only' }`; `notConfirmed(err)` answers 503 `{
  code: 'unavailable', message: NOT_CONFIRMED, reason: 'not_confirmed' }` and logs one warning line with
  `loggable(err)`.
- `en.ts` `errors.not_confirmed`: `NOT_CONFIRMED`'s text; `ru.ts`: `Hornhoof не смог подтвердить это изменение.
  Возможно, оно сохранено: проверьте, прежде чем повторять.`
- The lint (`fence-lint.test.ts`) reads every `.ts` file under `apps/server/src` and fails, naming file and line, on a
  line with `session_replication_role`; `SET CONSTRAINTS` and `IMMEDIATE`; `synchronous_commit` and `off`, `local` or
  `remote_write`, except in `src/modules/keeper/lease-store.ts`; `TRUNCATE`; `DISABLE TRIGGER`; `PREPARE
  TRANSACTION`; `new pg.Pool(`, `new Pool(`, `new pg.Client(` or `new Client(` outside `src/db/client.ts`,
  `src/db/agent-sql.ts` and `src/modules/keeper/lease-store.ts`. All case-insensitive.

- [ ] **Step 1: List the app's transactions that wait on more than the database** (ruling 20). In `apps/server/src`,
  every `.transaction(` (36 in main while planning, plus what plans 1b and 2 added) whose callback, or a function it
  awaits, awaits anything but queries on its own `tx`: a node message, git, fetch, the file system, a timer, ACME, a
  child process, a queue that waits on other work, slow crypto, or a query on the outer `db`. Each one moves out of the
  transaction, or gets a test that keeps it under 1 s, or goes to the team lead before Step 4. The task's report gives
  the list, also when it is empty. While planning none of main's 36 did: the callbacks passed in (`move()`'s `also`,
  `appendEvent`'s `also`, `locked`'s `fn`) use only `tx`, and `hashPassword` and the relay's `bind` run before their
  transactions.
- [ ] **Step 2: Write failing tests.**
  - `sql-check.test.ts`:
    - `lets reads and row changes through`: `SELECT 1`, `WITH x AS (SELECT 1) SELECT * FROM x`, `INSERT ...`,
      `UPDATE ...`, `DELETE ...`, `WITH d AS (DELETE FROM notebook_notes RETURNING id) SELECT count(*) FROM d`, `SELECT
      pg_sleep(1)`, and two of them in one text resolve.
    - `refuses what is not a row change, also after a first statement`: `COMMIT`, `BEGIN`, `SET LOCAL
      synchronous_commit = local`, `RESET transaction_timeout`, `SET CONSTRAINTS ALL IMMEDIATE`, `DO $$ BEGIN END $$`,
      `CALL p()`, `PREPARE TRANSACTION 'x'`, `MERGE INTO ...`, `EXPLAIN SELECT 1`, `SELECT 1 INTO t`, `CREATE TABLE t
      (id int)`, and each of them after `SELECT 1; ` reject with kind `statement` and `ONLY_STATEMENTS`.
    - `refuses the functions that reach other sessions, settings, large objects or hidden queries`:
      `SELECT pg_cancel_backend(1)`, `SELECT pg_catalog.pg_terminate_backend(1)`, `SELECT pg_reload_conf()`, `SELECT
      set_config('transaction_timeout', '0', true)`, `SELECT set_config('search_path', 'public', true)`, `SELECT
      lo_from_bytea(0, '\x00')`, `SELECT loread(0, 1)`, `SELECT query_to_xml('select 1', true, true, '')`, `SELECT *
      FROM ts_stat('select 1')`, `SELECT ts_rewrite('x'::tsquery, $$SELECT 'x'::tsquery, 'y'::tsquery FROM
      net.assert_lease('0s', NULL)$$)`, `SELECT net.assert_lease('0 s', NULL)`, `SELECT 1 FROM agents WHERE id IN
      (SELECT id FROM agents WHERE pg_cancel_backend(1))`, `UPDATE agents SET name = set_config('a.b', 'c', true)`,
      and the field spellings `SELECT (pg_backend_pid()).pg_cancel_backend` and `SELECT a.pg_terminate_backend FROM
      agents a` reject with kind `function`, the message naming the function.
    - `says what the parser says about a typo`: `SELEC 1` rejects with kind `syntax` and a message containing
      `syntax error`.
  - `confirm.test.ts`, on a fake client (an `EventEmitter` with `query` and `getTransactionStatus`, which emits a
    notice while a query runs when the test asks):
    - `fails a commit that got a warning`: `COMMIT` and `end` with a notice reject with `NotConfirmed`, its cause the
      notice; without one they resolve.
    - `fails a statement outside a transaction that got a warning`: status `I`, an `INSERT` with a notice rejects;
      status `T`, the same resolves; `ROLLBACK` and `BEGIN` with a notice resolve.
    - `watches every form of query`: a config object, text with values, and a callback each behave the same.
    - `keeps the database's own error`: a `COMMIT` that fails with `HHF01` and got a notice rejects with that error.
    - `notConfirmed` is true for `NotConfirmed`, `{ code: '57P01' }`, `{ code: '25P04' }`, `{ code: 'ECONNRESET' }`,
      `{ code: 'EPIPE' }`, `new Error('Connection terminated unexpectedly')`, `new Error('Client has encountered a
      connection error and is not queryable')` and a `DrizzleQueryError` whose cause is one of them, and false for `{
      code: '23505' }`.
    - `keeps an error between queries from ending the process`: after `keepErrors` twice, the client has one `error`
      listener, and `emit('error', new Error('gone'))` does not throw.
    - `names the route of a transaction the limit ended`: with `logTimeouts` on the fake client and `Date.now` moved by
      the test, a `begin` sent inside `requestRoute.run('GET /api/org', ...)` and an `error` event with code `25P04`
      120 ms later log `The 5 s limit ended a transaction of GET /api/org after 120 ms.` once, also when the next
      query then fails with `25P04` too; without a store the line says `work outside a request`; code `57P01` logs
      nothing.
    - `warns of a transaction that ran over 2 s`: a `begin` inside `requestRoute.run('POST /api/tasks', ...)` and a
      `commit` that resolves 2100 ms later log `A transaction of POST /api/tasks ran 2100 ms.`; a `commit` 1900 ms
      after its `begin` logs nothing; a `rollback` 2500 ms after a `begin` outside a request logs `A transaction of
      work outside a request ran 2500 ms.`.
  - `fence-lint.test.ts`, `keeps the app's code from getting past a fence`: the rules above hold for `apps/server/src`
    as it is, and each rule fails on a one-line sample (the test runs the rules on the samples too).
  - `db-pool.test.ts`, `fences the app's pool and ends its transactions after 5 s`: `openPool(url, () => {}, APP_NAME,
    { fenced: true }).options.options` is `-c transaction_timeout=5s -c client_min_messages=warning -c
    hornhoof.fenced=on`; without `fenced` it lacks the last part; a `KEEPER_NAME` pool has no `options`.
  - `db-pool.test.ts`, `takes the settings out of the address`:
    `stripSettings('postgres://u:p@h:5432/d?options=-c%20a%3Db&sslmode=disable&application_name=x')` is
    `postgres://u:p@h:5432/d?sslmode=disable`; the same address without parameters comes back as it was; an `APP_NAME`
    pool opened with the first has a `connectionString` without `options=` or `application_name=`.
  - `errors.test.ts`, `runs each route inside requestRoute`: a route `/api/x/:id` that awaits a 10 ms timer and then
    answers `requestRoute.getStore()` answers `GET /api/x/:id` for `GET /api/x/1`.
  - `errors.test.ts`, `answers a refused lease as read_only and a lost commit as not_confirmed`: a route that throws a
    `DrizzleQueryError` caused by `{ code: 'HHF01' }` answers 503 with reason `read_only`; one that throws
    `NotConfirmed`, and one that throws `{ code: '57P01' }`, answer 503 with reason `not_confirmed` and
    `NOT_CONFIRMED`.
  - `journal.test.ts`, `answers read_only to a write when the lease has ended`: on `testApp()` with a company set up,
    after `setLease(db, { until: '-infinity' })`, `GET /api/me` answers 200 and an employee's rename through the API
    answers 503 with reason `read_only`.
  - `orchestrator-control.test.ts`: in `is refused sign-ins, invites, install codes, the public link, passwords and the
    tables themselves`, `/permission denied|must be owner/` also takes `Hornhoof did not run this SQL`; new, `refuses
    SQL that would get past a fence`: `COMMIT`, `SET LOCAL synchronous_commit = local; UPDATE agents SET name = name`,
    `SELECT pg_cancel_backend(1)` and `SELECT 1; SET CONSTRAINTS ALL IMMEDIATE` each answer `isError` with `Hornhoof
    did not run this SQL:`, and no agent's name changed; `answers in five seconds`: the write tool's description
    says `a call may take 5 seconds`.
  - `i18n.test.tsx`, `shows a known reason in the chosen language` gains `not_confirmed` in both.
  - `real/agent-sql.test.ts`, on a `realDatabase()` migrated with `migrateDb`, `state` and an endless `lease` written
    by the admin, and `openAgentSql(url)`:
    - `refuses the agent roles what would undo a fence`: through `run(..., 'write')`: `ALTER TABLE tasks DISABLE
      TRIGGER net_journal` (`must be owner`), `SET session_replication_role = replica`, `SELECT * FROM net_local.lease`,
      `SELECT * FROM net.journal`, `INSERT INTO net.journal (xact, tbl, op, key, cols) VALUES (gen_random_uuid(), 'x',
      'insert', '{}', '{}')`, `SELECT * FROM applied`, `SELECT * FROM tool_calls`, `SELECT net.attach_journal()`,
      `SELECT pg_cancel_backend(1)`, `SELECT lo_from_bytea(0, '\x00')`, `SELECT set_config('transaction_timeout', '0',
      true)`, `SELECT query_to_xml('select 1', true, true, '')` and `SELECT ts_rewrite('x'::tsquery, 'SELECT
      ''x''::tsquery, ''y''::tsquery')` each fail with code `42501`, or `must be owner` for the first; `SELECT
      net.assert_lease('2 s', NULL)` passes in mode `write` and fails with `42501` in mode `read`.
    - `keeps its own settings whatever the address says`: with the address given `options=-c hornhoof.fenced=off -c
      transaction_timeout=0` and `application_name=x` (set with `searchParams`), on `openDb(that, APP_NAME, { fenced:
      true })` `SHOW hornhoof.fenced` is `on`, `SHOW transaction_timeout` is `5s` and
      `current_setting('application_name')` is `hornhoof-app`; through `openAgentSql(that)`, `SHOW
      transaction_timeout` in mode `write` is `5s`.
    - `keeps the process up and names the route when the limit ends an idle transaction`: a small Fastify app with
      `registerErrorHandling` and a route `GET /slow` whose `db.transaction`, on `openDb(url, APP_NAME, { fenced: true
      })`, runs `SELECT 1`, waits 6 s in Node and runs `SELECT 1` again: `inject` answers 503 with reason
      `not_confirmed` (`transaction_timeout` ended the idle session; what drizzle throws is its `ROLLBACK`'s error),
      `console.warn` got one `The 5 s limit ended a transaction of GET /slow after <ms> ms.` with `<ms>` from 5000 to
      6500, no uncaught error reaches vitest, and the pool's next query works. The same transaction outside a request,
      with the admin's `pg_terminate_backend` of its session in place of the wait, rejects with `notConfirmed(err)`
      true and logs no such line.
    - `ends a transaction of the app that runs over 5 s`: `db.transaction` running `SELECT pg_sleep(6)` rejects with
      `notConfirmed(err)` true, `console.warn` got `The 5 s limit ended a transaction of work outside a request after
      <ms> ms.`, and the pool's next query works.
    - `cannot cancel another session of its own role`: one write call runs `SELECT pg_sleep(2)` while a second, given
      the first's pid from `pg_stat_activity`, runs `SELECT pg_cancel_backend(<pid>)` and fails with `42501`; the
      first succeeds.
    - `refuses PREPARE TRANSACTION`: on the admin, `BEGIN` and `PREPARE TRANSACTION 'x'` fail with `prepared
      transactions are disabled`.
    - `refuses before COMMIT a text that sleeps past the lease`: with the lease until now + 3 s, `SELECT pg_sleep(2);
      UPDATE agents SET name = name` fails with `HHF01` and leaves no journal row.
    - `ends a call that runs over 5 s`: `SELECT pg_sleep(6)` in mode `write` fails, and `notConfirmed(err)` is true.
    - `waits at commit for a copy and reports a cancelled wait as not confirmed`: with `ALTER SYSTEM SET
      synchronous_standby_names = 'FIRST 1 (nobody)'` and `pg_reload_conf()` (reset and reloaded in `afterEach`), an
      insert on `openDb(url, APP_NAME, { fenced: true })` waits with `wait_event` `SyncRep`; the admin's
      `pg_cancel_backend` on it makes the insert reject with `NotConfirmed` while the row is committed; the same with
      the client's own `SET statement_timeout = 300` instead of the cancel; `pg_terminate_backend` instead makes it
      reject with `notConfirmed(err)` true; a write call of the agent role, cancelled the same way, rejects with
      `NotConfirmed`.
- [ ] **Step 3: Run** Done when. Expected: FAIL (no check, no wrapper, no reason, the old role settings).
- [ ] **Step 4: Implement** the interfaces above, after installing the dependency as the Global Constraints say.
- [ ] **Step 5: Run Done when.** Expected: PASS.
- [ ] **Step 6: Commit** "Parse the orchestrator's SQL, end transactions after 5 seconds, and report a commit not
  confirmed".


