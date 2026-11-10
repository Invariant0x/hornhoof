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
6. Docker never runs on this machine; it runs Ivan's live company. On the test machine it is allowed only inside your own run: `remote.sh run --dind <label> '<command>'` gives a daemon in your container, and `npm run test:real` belongs there when a task's Done when names it. Do not run, build, pull, exec or inspect anything in Docker any other way.

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

- You read batch 9, slice journal, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-9, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch9-journal.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# Where to read

This batch's staging branch does not exist yet, because batch 6 lands first. Read the tree in the lane `/home/altera/hornhoof-network/wt/p3lease` instead, read only: it stands on batch 6's first commits, then Plan 3 Tasks 1 and 2 and the pure lease file. Batch 6's fix round (Plan 2 Task 3's `AppMode`, Plan 1b Task 7's store) is not under it and does not touch these files.

Plan 3 Task 4's rest (`lease-store.ts`, the keeper's renewals, the fence on a step-down) is not written. Nothing writes a lease yet, so agent roles are always fenced and the orchestrator's database writes are refused on a real company until then: the plan does not ship in part, by ruling. Do not report that as a finding. Do report what Task 4's writer will trip over.

Look hardest at: a write path that reaches a table with no journal entry or no fence, a role that can get around the fence (`SET ROLE`, `SECURITY DEFINER`, a default privilege, a function owner), what the journal stores about a person's secret columns (`HIDDEN`, `SECRET` in `apps/server/src/db/`), whether migration 0057 fails on a real company's existing data or locks a live one for long, and whether the real-Postgres tests would pass with the code wrong. The lease's edge cases: clocks that jump, a tick late by exactly the limit.

You are also this batch's reader for interactions, between the journal, the lease and what batches 4 to 6 already landed.

# The tasks

## 2026-11-03-network-phase-1-plan-3-fences-and-journal, Task 2

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


### Task 2: The journal and fence 1

**Repo:** Hornhoof worktree, branch `fences-and-journal`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/journal.test.ts test/migrations.test.ts
test/orchestrator-control.test.ts` passes, then the whole server suite (`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest
run`); from the worktree root `npm run test:real` passes and `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing.

**Files:**
- Create: `apps/server/src/db/net.ts`, `apps/server/drizzle/0045_sources.sql`, `apps/server/drizzle/0046_net.sql`
  (with their `meta/` snapshots and journal entries, as drizzle-kit writes them)
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts` (`migrateDb`),
  `apps/server/src/db/agent-sql.ts` (`HIDDEN`), `apps/server/src/modules/tools/database.ts` (`CLOSED`, the
  descriptions' list of closed tables), `apps/server/test/global-setup.ts`, `apps/server/test/helpers.ts`
- Test: `apps/server/test/journal.test.ts` (new), `apps/server/test/migrations.test.ts`,
  `apps/server/test/orchestrator-control.test.ts` (the `CLOSED` text), `apps/server/test/real/journal.test.ts` (new)

**Interfaces:**
- Produces, in `schema.ts`:
  ```ts
  export const applied = pgTable('applied', { source: text('source').primaryKey(), at: timestamp('at', { withTimezone: true }).notNull().defaultNow() });
  export const toolCalls = pgTable('tool_calls', { id: uuid('id').primaryKey(), jobId: uuid('job_id').notNull().references(() => jobs.id), answer: jsonb('answer'), at: timestamp('at', { withTimezone: true }).notNull().defaultNow() });
  // taskEvents gains: uuid: uuid('uuid').notNull().defaultRandom().unique()
  // tasks gains, beside its other indexes: index('tasks_turn_id').on(t.turnId), index('tasks_product_id').on(t.productId)
  ```
  The two indexes are the team lead's: turns read tasks by `turn_id`, and removing a department changes tasks by
  `product_id`, and neither had one; they come here so that no other migration lands between plan 1b's and this plan's.
  `0045_sources` is what drizzle-kit generates for these; its `ADD COLUMN ... DEFAULT gen_random_uuid() NOT NULL` gives
  every older row its own uuid.
- Produces, in `0046_net.sql` (all objects owned by the role that migrates):
  - Schemas `net` and `net_local`.
  - `net_local.state (id boolean PRIMARY KEY DEFAULT true CHECK (id), term_number bigint NOT NULL, term_machine text
    NOT NULL, term_split boolean NOT NULL DEFAULT false, machine text NOT NULL, cluster text NOT NULL)`, `cluster`
    being `pg_control_system()`'s `system_identifier` as text.
  - `net_local.lease (id boolean PRIMARY KEY DEFAULT true CHECK (id), term_number bigint NOT NULL, term_machine text
    NOT NULL, term_split boolean NOT NULL DEFAULT false, kind text NOT NULL CHECK (kind IN ('normal', 'split',
    'maintenance')), until timestamptz NOT NULL, sync text CHECK (sync IN ('copy', 'relay_off', 'alone')))`.
  - `net_local.maintenance (id boolean PRIMARY KEY DEFAULT true CHECK (id), version text NOT NULL, since timestamptz
    NOT NULL, until timestamptz NOT NULL)`, written by nobody yet.
  - `net.journal (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), xact uuid NOT NULL, term_number bigint, term_machine
    text, term_split boolean, machine text, at timestamptz NOT NULL DEFAULT clock_timestamp(), tbl text NOT NULL, op
    text NOT NULL CHECK (op IN ('insert', 'update', 'delete')), key jsonb NOT NULL, cols text[] NOT NULL, old jsonb)`,
    and `CREATE INDEX journal_at ON net.journal (at)` (ruling 19).
  - `net.assert_lease(margin interval, invocation uuid) RETURNS void`, `SECURITY DEFINER`, `SET search_path =
    pg_catalog, net_local, pg_temp`. It returns at once when `session_user` is a superuser and
    `current_setting('hornhoof.fenced', true)` is not `'on'` (ruling 1). Otherwise it raises `SQLSTATE 'HHF01'` with
    the message `This machine holds no lease now, so nothing was changed.` unless all hold: `net_local.state` and
    `net_local.lease` each have their row; the lease's `(term_number, term_machine, term_split)` equals the state's;
    its kind is `normal` or `split`; `until > clock_timestamp() + margin`; `current_setting('synchronous_commit')` is
    `on`; a `normal` lease has a non-null `sync`. `invocation` is not read yet.
  - `net.fence_check() RETURNS trigger`, the same `SECURITY DEFINER` and path: `PERFORM net.assert_lease('0 s',
    NULL)`, then `RETURN NULL`. `CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.journal
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check()`.
  - `net.attach_journal() RETURNS integer`: for every table in `public` (`relkind` `r`), creates or replaces
    `net."journal_<table>"()` (`SECURITY DEFINER`, the same path; a table name over 55 characters, or a table with no
    primary key, raises) and the trigger `net_journal AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW` on the table,
    when missing. The function writes one `net.journal` row as ruling 13 says: `xact` is `md5(<cluster> || ':' ||
    pg_current_xact_id()::text)::uuid`, `<cluster>` from `net_local.state`, or from `pg_control_system()` when it has
    no row; the term and `machine` from `net_local.state` (null when it has no row); `tbl` the table's name; `key`
    the primary key's columns as a JSON object; `cols` and `old` as ruling 13 says, `bytea` columns as `'sha256:' ||
    encode(sha256(value), 'hex')`. It answers how many tables it attached and ends with `REVOKE ALL ON ALL FUNCTIONS
    IN SCHEMA net FROM PUBLIC`.
  - `net.detach_journal() RETURNS integer`: drops every `net."journal_%"` function with `CASCADE`, which drops its
    trigger; answers how many.
  - `net.defer_foreign_keys() RETURNS integer`: `ALTER TABLE ... ALTER CONSTRAINT ... DEFERRABLE INITIALLY IMMEDIATE`
    for every foreign key in `public` that is not deferrable; answers how many.
  - `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC`. No `ALTER DEFAULT PRIVILEGES`: a per-schema default cannot
    take away the global one that lets PUBLIC run new functions, so `attach_journal`'s own revoke, after every
    migration run, covers a function a later migration adds. Nothing on `public`'s tables yet: `migrateDb` attaches.
- Produces, in `db/net.ts`:
  ```ts
  export const LEASE_REFUSED = 'HHF01';
  export const FENCED = 'hornhoof.fenced';            // a superuser session that sets it to 'on' is fenced
  export const JOURNAL_TRIGGER = 'net_journal';
  export const FENCE_TRIGGER = 'net_fence';
  export type LeaseKind = 'normal' | 'split' | 'maintenance';
  export type LeaseSync = 'copy' | 'relay_off' | 'alone';
  export type Term = { number: number; machine: string; split: boolean };
  export const BEFORE_MIGRATIONS: string;   // a DO block: PERFORM net.detach_journal() when to_regprocedure('net.detach_journal()') is not null
  export const AFTER_MIGRATIONS: string;    // 'SELECT net.attach_journal(); SELECT net.defer_foreign_keys();'
  export function isLeaseRefused(err: unknown): boolean;   // code HHF01 on err or on one of its causes
  ```
- `migrateDb(url, folder = MIGRATIONS)`: on its one pool, `BEFORE_MIGRATIONS`, drizzle's migrate, then
  `AFTER_MIGRATIONS` in a `finally` when `to_regprocedure('net.attach_journal()')` is not null; a failure of the
  migrations is still what it throws.
- `HIDDEN` gains `'applied'` and `'tool_calls'`. `CLOSED` becomes `Sign-ins, invites, install codes, sealed plan
  sign-ins, the public link and Hornhoof's records of where changes came from are closed to this tool.`, and both
  descriptions name the same list.
- `global-setup.ts`, after drizzle's migrate: `AFTER_MIGRATIONS`; a `net_local.state` row of term 1 of `test`, split
  false, machine `test`, and its `cluster`; a `net_local.lease` row of that term, kind `normal`, until `infinity`, sync
  `alone`. Then the dump, as today.
- `helpers.ts`: `openTestDb` runs `SET hornhoof.fenced = 'on'` on each PGlite it opens, before anything else (PGlite
  0.5.13 applies no `ALTER DATABASE ... SET` or `ALTER ROLE ... SET` when it loads a dump; checked while planning).
  ```ts
  export async function setLease(db: Db, change: { until?: string; kind?: LeaseKind; sync?: LeaseSync | null; termNumber?: number }): Promise<void>;
  //   UPDATE net_local.lease with what is given; until as timestamptz text ('-infinity', an ISO time)
  ```

- [ ] **Step 1: Write failing tests.**
  - `journal.test.ts`, on `createTestDb()` and `testApp()` databases:
    - `writes one journal row per changed row, with its transaction's uuid`: two inserts in one `db.transaction` share
      one `xact`, a third in its own transaction has another; each row has `term_number` 1, `term_machine` and
      `machine` `test`, and `tbl`, `op` and `key` of its row; a transaction that first runs `SET LOCAL net.xact =
      '<a uuid>'` still gets `md5(<cluster> || ':' || <its pg_current_xact_id()>)`.
    - `keeps the changed columns and their old values`: an update of an agent's `name` gives `cols` `['name']` and
      `old` `{ name: 'Bruno' }`; an insert gives every column of the table and `old` null; a delete gives every column
      and the old row.
    - `keeps a hash of a file, not its bytes`: an `attachments` row deleted gives `old.bytes` matching
      `^sha256:[0-9a-f]{64}$`, the hash of its bytes.
    - `journals an update that changes nothing`: `UPDATE agents SET name = name WHERE id = <id>` gives one row with
      `cols` `[]`.
    - `journals what the orchestrator's role changes`: a write through `ctx.agentSql.run(..., 'write')` gives its row.
    - `refuses a commit once the lease has ended, at the commit and not before`: after `setLease(db, { until:
      '-infinity' })`, inside a transaction the insert succeeds and the `COMMIT` fails with code `HHF01`; the row is
      not there.
    - `refuses a maintenance lease, a normal lease without sync, a lease of another term and a commit without
      synchronous commit`: each of `{ kind: 'maintenance' }`, `{ sync: null }`, `{ termNumber: 2 }` and a transaction
      that runs `SET LOCAL synchronous_commit = local` fails at commit with `HHF01`; `{ kind: 'split', sync: null }`
      commits.
    - `lets a superuser session that does not say it is fenced pass`: with the lease ended, after `SET
      hornhoof.fenced = off` an insert commits and journals its row; after `SET hornhoof.fenced = on` again the next
      fails.
  - `migrations.test.ts`:
    - `migration 0045`, `gives each task event of an older install its own uuid`: migrated up to `0044_link_tls`
      with two task events, then fully: both have a uuid and they differ; and `indexes the tasks by turn and by
      product`: fully migrated, `pg_indexes` lists `tasks_turn_id` on `tasks (turn_id)` and `tasks_product_id` on
      `tasks (product_id)`.
    - `migration 0046`, `adds the fences, and the journal once migrated`: a fresh PGlite fully migrated has the
      schemas `net` and `net_local` and no `net_journal` trigger; after `AFTER_MIGRATIONS` every table in `public` has
      one, `net.journal` has `net_fence` (deferrable, initially deferred), every foreign key in `public` is deferrable
      and initially immediate, every table in `public` has a primary key, and `has_function_privilege('public', oid,
      'EXECUTE')` is false for every function in `net`, also for a function `net.later()` made before a second
      `AFTER_MIGRATIONS`; after `SELECT net.detach_journal()` no `net_journal` trigger is left.
  - `orchestrator-control.test.ts`, in `is refused sign-ins, invites, install codes, the public link, passwords and the
    tables themselves`: the `CLOSED` check takes the new text, and `SELECT * FROM applied` and `SELECT * FROM
    tool_calls` join the statements it refuses.
  - `real/journal.test.ts`, each on its own `realDatabase()` migrated with `migrateDb`, and `state` and `lease` rows
    written by the admin as `global-setup.ts` writes them:
    - `fences the app's commits and lets older builds through`: on a test `pg.Client` with `application_name`
      `hornhoof-app` and `options: '-c hornhoof.fenced=on'` (Task 3 gives `openDb` that option), an insert commits
      under the lease and fails with `HHF01` once the admin ended it; on a plain superuser client the same insert
      commits and journals its row.
    - `fences the agent role whatever it sets`: with the lease ended, a write call of `openAgentSql(url)` that runs
      `SET hornhoof.fenced = off` and an insert into `notebook_notes` fails with `HHF01` at its commit.
    - `takes the journal off for the migrations and puts it back`: a copy of `MIGRATIONS` with one more migration
      that drops `notebook_notes.by_orchestrator` and updates that table, run by `migrateDb(url, copy)`, succeeds,
      and afterwards `net."journal_notebook_notes"` no longer names the column and every table has its trigger; a copy
      whose extra migration fails (`SELECT 1/0`) makes `migrateDb` throw, and every table still has its trigger.
    - `commits a 50 MB file within the app's limit, and journals its hash`: a table `public.big (id int PRIMARY KEY,
      b bytea)` made by the admin and `SELECT net.attach_journal()`; an insert of 50 MB of random bytes and its delete
      each commit on a test client with `-c transaction_timeout=5s -c hornhoof.fenced=on`; the delete's journal row
      has `old.b` `sha256:<hex of those bytes>`.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no tables, no `net`, no `setLease`).
- [ ] **Step 3: Implement** the interfaces above: `schema.ts`, then `npx drizzle-kit generate --name sources`, then
  `npx drizzle-kit generate --custom --name net` and the SQL, then `net.ts`, `migrateDb`, the fixture and helpers.
  The extra migrations live in the test's temporary copy only.
- [ ] **Step 4: Run Done when.** Expected: PASS. A test elsewhere in the suite that now fails at a commit shows a write
  path the fixture or a lease does not cover: report it rather than loosen the fence.
- [ ] **Step 5: Commit** "Journal every change and commit it only under a lease the keeper holds".


## 2026-11-03-network-phase-1-plan-3-fences-and-journal, Task 4

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


### Task 4: The keeper's lease and fence 4

**Repo:** Hornhoof worktree, branch `fences-and-journal`. **Starts from:** Task 3 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/lease.test.ts test/lease-store.test.ts
test/keeper.test.ts test/keeper-link.test.ts test/app-mode.test.ts` passes, then the whole server suite; from the
worktree root `npm run test:real` passes and `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/lease.ts`, `apps/server/src/modules/keeper/lease-store.ts`,
  `apps/server/test/fake-lease.ts`
- Modify: `apps/server/src/modules/keeper/keeper.ts`, `apps/server/src/keeper.ts`,
  `apps/server/src/modules/keeper/app-mode.ts`, `apps/server/test/helpers.ts` (`createTestSql`)
- Test: `apps/server/test/lease.test.ts`, `apps/server/test/lease-store.test.ts` (new),
  `apps/server/test/keeper.test.ts` and `apps/server/test/keeper-link.test.ts` (their keepers get `lease:
  fakeLease()`), `apps/server/test/app-mode.test.ts`, `apps/server/test/real/lease-store.test.ts` (new)

**Interfaces:**
- Consumes: `Term`, `LeaseKind`, `JOURNAL_TRIGGER`, `FENCE_TRIGGER` (Task 2); `REFUSED_FUNCTIONS`, `stripSettings`,
  `keepErrors`, `notConfirmed`, `HIDDEN`, `agentRole`, `readerRole` (Task 3 and today); `APP_NAME`, `KEEPER_NAME` (plan
  2).
- Produces:
  ```ts
  // modules/keeper/lease.ts
  export const LEASE_MS = 10_000;
  export const LATE_MS = 6_000;    // a gap over this between two ticks, on either clock, is a tick more than 5 s late
  export const BACK_MS = 1_000;    // the wall clock going back more than this
  export type Clocks = { wall: number; mono: number };    // Date.now() and performance.now()
  export type Held = { term: Term; kind: LeaseKind; sent: Clocks };   // the last renewal that committed, by when it was sent
  export type LeaseStep = { do: 'take'; kind: LeaseKind } | { do: 'fence'; why: string } | { do: 'renew'; kind: LeaseKind; endSessions: boolean };
  export function leaseValid(held: Held | null, now: Clocks): boolean;
  //   held, and now is less than LEASE_MS after held.sent on both clocks
  export function nextLeaseStep(o: { now: Clocks; last: Clocks | null; held: Held | null; maintenance: boolean }): LeaseStep;
  //   in order: held null: take (kind maintenance or normal); a late tick (now.mono - last.mono or now.wall -
  //   last.wall over LATE_MS, or last.wall - now.wall over BACK_MS): fence; !leaseValid: fence; else renew with
  //   endSessions true only when maintenance begins (held.kind is not maintenance)
  // modules/keeper/lease-store.ts
  export type Sql = { query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }> };
  export type LeaseStore = {
    take(kind: LeaseKind, until: Date): Promise<Term>;
    //   fence(), then one statement: state to (the highest of state's and lease's number, else 0) + 1 with this
    //   machine, split false, and the lease of that term with kind, until and sync 'alone'
    renew(term: Term, kind: LeaseKind, until: Date, endSessions: boolean): Promise<boolean>;
    //   UPDATE ... WHERE the term is that term AND until > clock_timestamp(): false when no row changed; endSessions
    //   then ends the sessions after the update committed
    fence(): Promise<void>;          // until '-infinity', then endSessions()
    endSessions(): Promise<number>;  // pg_terminate_backend of every other session of this database whose
                                     //   application_name is APP_NAME or whose user is its agentRole or readerRole
    problems(): Promise<string[]>;   // [] when every fence holds
    prune(batch?: number): Promise<number>;
    //   one statement (ruling 19): DELETE FROM net.journal WHERE id IN (SELECT id FROM net.journal WHERE at < now() -
    //   interval '7 days' ORDER BY at LIMIT batch) AND (SELECT sync FROM net_local.lease) = 'alone'; answers the rows
    //   it deleted; batch PRUNE_BATCH when not given
    close(): Promise<void>;
  };
  export const PRUNE_BATCH = 10_000;
  export function leaseStore(sql: Sql, opts: { machineId: string }): LeaseStore;
  export function keeperSql(url: string, opts?: { timeoutMs?: number }): Sql & { close(): Promise<void> };
  //   one pg.Client at a time on stripSettings(url), application_name KEEPER_NAME, options '-c
  //   synchronous_commit=local', keepErrors on it, no statement_timeout, connectionTimeoutMillis and query_timeout
  //   timeoutMs (2000); queries run one after another, each waiting for the one before to settle; a connect or query
  //   that fails or times out drops that client without waiting for its end, and the next query opens a new one
  // KeeperOptions gains: lease: LeaseStore | null; now?: () => Clocks; pruneEveryMs?: number (60000)
  // Keeper gains: term(): Term | null   (held's term while leaseValid, else null)
  // test/helpers.ts: export async function createTestSql(): Promise<{ db: Db; sql: Sql }>   (one PGlite from openTestDb, both views)
  // test/fake-lease.ts: export function fakeLease(opts?: { problems?: string[]; take?: (kind: LeaseKind) => Promise<Term>; prune?: () => Promise<number> }): LeaseStore & { calls: { method: string; args: unknown[] }[] }
  ```
- `problems()`, each a line, in this order: `public.<table> has no journal trigger` for a table of `public` without a
  `net_journal` trigger whose `tgenabled` is `O`; `net.<table> has no fence trigger` for a table of `net` without
  `net_fence` as a deferrable, initially deferred constraint trigger whose `tgenabled` is `O` (what `attach_journal` and
  the migration leave; `D`, `R` and `A` are changes Hornhoof never makes, and `R` or `D` stop the fence); `PUBLIC may
  still run <name>` for a function of `REFUSED_FUNCTIONS` in `pg_catalog`, or any in `net`, that PUBLIC may execute; for
  each agent role that exists: `<role> is a superuser`, `<role> may signal other sessions` (a member of
  `pg_signal_backend`), `<role> may reach <schema.table>` (any right on a table of `net` or `net_local`, or on
  `public.applied` or `public.tool_calls`), `<role> may run <function>` (a function of `net` but `assert_lease`);
  `max_prepared_transactions is <n>, not 0`.
- The keeper, added to plan 2's, every `everyMs`: `maintenance` is `updaterBusy(controlDir)`, or what it was when that
  is null; `nextLeaseStep`; then the step on `opts.lease`, with `until` at `sent.wall + LEASE_MS`, `sent` taken right
  before the call. A take that resolves sets `held`; a renew that answers true replaces `held` with its term, the kind
  it renewed and its `sent`; a fence clears `held`; a call that throws or answers false leaves `held`, so the lease
  lapses by itself. Every `linkEveryMs` `problems()`; a throw keeps the last answer. Every `pruneEveryMs` on the
  monotonic clock, the first one `pruneEveryMs` after the start, `prune()` unless `maintenance`. `mode()`: `maintenance`
  while `maintenance`; `lead` when `leaseValid(held, now())`, `held.kind` is `normal` and the last `problems()` answered
  `[]`; otherwise `read`. With `lease: null` it never leads. Log lines, each once per change: `This machine leads under
  term <number>.`; `The lease ended (<why>): the sessions of the app and the agents were ended, and Hornhoof only reads
  here until it takes a new term.` (`<why>`: `a tick came <s> s after the one before`, the larger gap of the two clocks,
  `the clock went back <s> s` or `no renewal for 10 s`; `<s>` in seconds rounded to a tenth, as JavaScript prints it);
  `Could not take a lease: <message>.`; `Could not prune the journal: <message>.` (a prune that works logs nothing);
  `Hornhoof does not lead here until this is fixed: <problems joined by '; '>.`.
- `keeper.ts`: `lease` is `leaseStore(keeperSql(databaseUrl), { machineId })` when both are set; else `null`, with
  once `The keeper takes no lease: HORNHOOF_MACHINE_ID is not set. Run the install command again.` or `The keeper
  takes no lease: DATABASE_URL is not set.`. `stop()` closes it.
- `AppMode.check()`: when no fresh word comes, the mode is `lead`, and the last fresh word is more than `staleMs` old,
  the mode becomes `read`, with its log line. Nothing else of plan 2 changes.

- [ ] **Step 1: Write failing tests.**
  - `lease.test.ts`, `picks each tick's step from the two clocks`, one table, `t0 = { wall: 1e12, mono: 5e3 }`, `held`
    normal sent at `t0` unless a row says otherwise, `last` one second before `now`:

    | held | last | now (from t0) | maintenance | step |
    |---|---|---|---|---|
    | none | none | +0 | no | take normal |
    | none | none | +0 | yes | take maintenance |
    | normal | +0 | wall +1 s, mono +1 s | no | renew normal, endSessions false |
    | normal | +1 s | wall +8 s, mono +8 s | no | fence, `a tick came 7 s after the one before` |
    | normal | +1 s | wall +8 s, mono +2 s | no | fence (late on the wall clock) |
    | normal | +1 s | wall -1.5 s, mono +2 s | no | fence, `the clock went back 2.5 s` |
    | normal | +1 s | wall +0.5 s, mono +2 s | no | renew normal |
    | normal | +9 s | wall +10 s, mono +10 s | no | fence, `no renewal for 10 s` |
    | normal | +9.5 s | wall +10.2 s, mono +9.8 s | no | fence (lapsed on the wall clock) |
    | normal | +0 | +1 s | yes | renew maintenance, endSessions true |
    | maintenance | +0 | +1 s | yes | renew maintenance, endSessions false |
    | maintenance | +0 | +1 s | no | renew normal, endSessions false |
    | none | +1 s | +9 s | no | take normal |

    and `leaseValid` false for `null`, for `now` 10 s after `sent` on either clock alone, true 9.9 s after on both.
  - `lease-store.test.ts`, on `createTestSql()` (the fixture's endless lease, term 1 of `test`):
    - `takes the next term and a lease of it`: `take('normal', until)` answers `{ number: 2, machine: <id>, split:
      false }`; state and lease say term 2 of that machine, kind normal, sync `alone`, that `until`.
    - `renews only the lease of its term that has not ended`: with `t` from `take('normal', until)`, `renew(t, ...)`
      answers true and moves `until`; `renew` of the fixture's term 1 answers false; after `fence()`, `renew(t, ...)`
      answers false and `until` stays `-infinity`.
    - `a renewal that arrives after the fence changes nothing`: with `t` from `take`, then `fence()`, `renew(t, ...)`
      with its `until` an hour ahead answers false and `until` stays `-infinity`.
    - `prunes journal rows older than 7 days while alone`: with 5 `net.journal` rows written with `at` 8 days ago and
      3 written now (one `INSERT ... SELECT ... FROM generate_series` each), `prune(3)` answers 3 and leaves 2 old rows
      and the 3 new; `prune()` answers 2 and leaves the 3 new; `prune()` then answers 0.
    - `prunes nothing unless the lease says alone`: the same old rows written first, then `UPDATE net_local.lease SET
      sync = 'copy'`: `prune()` answers 0 and every row stays; the same with the lease row deleted.
    - `gives up on a database that never answers`: against a `node:net` server that accepts and never writes,
      `keeperSql('postgres://u:p@127.0.0.1:<port>/d', { timeoutMs: 300 })`'s `query('SELECT 1')` rejects within 1 s;
      the next query opens a second socket; two queries sent together never hold two sockets open at once.
    - `names what keeps it from leading`: on the fixture, `problems()` has `PUBLIC may still run pg_cancel_backend`;
      after `PUBLIC_REVOKES`, `grantsFor('postgres_agent')` and `readerGrantsFor('postgres_reader')`, each one
      `sql.query`, it is `[]`; then, one at a time and undone after: `DROP TRIGGER net_journal ON notebook_notes` gives
      `public.notebook_notes has no journal trigger`; `GRANT EXECUTE ON FUNCTION pg_cancel_backend(integer) TO PUBLIC`
      gives `PUBLIC may still run pg_cancel_backend`; `GRANT SELECT ON net.journal TO postgres_agent` gives
      `postgres_agent may reach net.journal`; `GRANT EXECUTE ON FUNCTION net.attach_journal() TO postgres_agent` gives
      `postgres_agent may run attach_journal`; `DROP TRIGGER net_fence ON net.journal` gives `net.journal has no fence
      trigger`; `ALTER TABLE notebook_notes DISABLE TRIGGER net_journal`, `... ENABLE REPLICA TRIGGER net_journal` and
      `... ENABLE ALWAYS TRIGGER net_journal` each give `public.notebook_notes has no journal trigger`; `ALTER TABLE
      net.journal DISABLE TRIGGER net_fence` and `... ENABLE REPLICA TRIGGER net_fence` each give `net.journal has no
      fence trigger`.
  - `keeper.test.ts`, keepers with an injected `now` the test moves and `everyMs` 50:
    - `leads once it holds a lease, and reads without one`: with `fakeLease()`, `keeper.json` says `lead` and
      `term()` is the taken term; with a store whose `take` throws, `read`, and the log has `Could not take a lease:`
      once over 10 ticks; with `lease: null`, `read`.
    - `renews each second until ten seconds after it sent`: the calls have `renew` with `until` `sent.wall + 10000`.
    - `fences a late tick and takes a new term at the next`: after `now` moves 8 s at once, the next tick calls `fence`,
      `keeper.json` says `read` and the log has `The lease ended (a tick came 8 s after the one before)`; the tick after
      calls `take` and the mode is `lead` again.
    - `reads when renewals fail for ten seconds`: a store whose `renew` answers false: `lead` until 10 s after the
      last good send, then `fence` and `read`.
    - `writes a maintenance lease while the updater installs`: `status.json` `running`/`install` gives `renew` with
      kind `maintenance` and `endSessions` true once, and `keeper.json` `maintenance`; `done` gives kind `normal` and
      `lead`.
    - `leads after maintenance that was running when it started`: with `status.json` `running`/`install` before the
      first tick, the keeper calls `take` with kind `maintenance`, then renews with kind `maintenance` and
      `endSessions` false, and `keeper.json` says `maintenance`; after `done`, renewals have kind `normal` and the
      mode is `lead`; no renewal had `endSessions` true.
    - `prunes the journal once a minute, not in maintenance`: with `pruneEveryMs` 3000 and `now` moved 1 s a tick,
      `fakeLease()` gets `prune` once `now` has moved 3 s from the start and again at 6 s, and not before; none while
      `status.json` says `running`; a `prune` that throws three times logs `Could not prune the journal:` once.
    - `does not lead while the database lacks a fence`: `fakeLease({ problems: ['public.tasks has no journal trigger']
      })` gives `read` and the log `Hornhoof does not lead here until this is fixed: public.tasks has no journal
      trigger.` once; the problems cleared, `lead` within one `linkEveryMs`.
    - plan 2's cases keep passing with `lease: fakeLease()`.
  - `app-mode.test.ts`, `goes to read when no fresh word came for 10 s while leading`: in `lead`, with the file left
    as it was and `now` moved 10.5 s, `check()` gives `read`; a fresh `lead` word gives `lead`; in `maintenance` the
    same wait keeps `maintenance`.
  - `real/lease-store.test.ts`, on a `realDatabase()` migrated, with `openAgentSql(url)` started:
    - `ends the app's and the agents' sessions, and no other`: an idle client of an `APP_NAME` pool, an agent role
      session (a write call that runs `SELECT pg_sleep(3)`), a `KEEPER_NAME` client and a `MIGRATE_NAME` client;
      `endSessions()` answers 2; `pg_stat_activity` keeps the keeper's and migrate's; the sleeping call fails with
      `notConfirmed(err)` true; the app pool's next query works on a new connection.
    - `ends a commit that waits when the lease ends`: with `synchronous_standby_names = 'FIRST 1 (nobody)'`, an insert
      on the fenced app pool waits, `fence()` makes it reject with `notConfirmed(err)` true, and the lease's `until`
      is `-infinity`.
    - `renews without waiting for a copy`: with the same setting, `renew` of the term `take` answered is true within
      1 s.
    - `opens a new connection after its own is ended`: the admin ends the idle `keeperSql` session; no uncaught error
      reaches vitest, the first query after fails, the next succeeds.
    - `a renewal that arrives after the fence changes nothing`, as on PGlite.
    - `prunes as the keeper after the lease ended`: old `net.journal` rows written by the admin, then `fence()`:
      `prune()` on `keeperSql(url)` deletes them, since the keeper's session passes the fence trigger as a superuser
      that is not fenced.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no lease module, the keeper leads without a lease).
- [ ] **Step 3: Implement** the interfaces above. `take` is one `WITH ... INSERT ... ON CONFLICT` statement, so a
  term and its lease commit together.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Renew the lease from the keeper each second, and end it with the sessions on a late tick".


