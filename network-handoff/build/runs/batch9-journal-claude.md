# Review: batch 9, slice journal (Claude)

Read only. Package `network-build/runs/batch9-journal.diff`, tree `wt/p3lease` at 4582e356 (commits 2df69d65, 44507786,
4582e356). Compared with plan 3 Tasks 2 and 4 (top, Interfaces, Steps, Global Constraints, rulings 1, 2, 12, 13, 19),
the spec's fence section (lines 372-416) and journal section (666-679), the build rulings and the brief. No file changed.
Author checks and the real run (5 journal tests, 17.11) were read from `runs/remote-p3t2-*.log` and
`remote-p3lease-check-*.log`, not rerun. No em dash in any tracked file of the three commits; nothing private.

## Critical

None found.

## Important

1. `apps/server/drizzle/0057_net.sql:248-261` and `apps/server/src/db/client.ts:42-56`: while `migrateDb` runs, fence 1 is
   off, not only the journal. `detach_journal` drops every `net.journal_<t>()` with CASCADE, so no public table has a
   trigger from `BEFORE_MIGRATIONS` until `AFTER_MIGRATIONS`, and a write in that window fires nothing: no journal row,
   so `net_fence` never asks `assert_lease`. Plan 3's Review Focus 2 says "the maintenance lease refuses the app's
   commits while `migrate` runs"; of fence 1 that is not true, and the Global Constraint "a fence function that cannot
   decide refuses" has no function to ask. What a person gets: during an Update, a write from a session that still
   reaches the database (the old app container keeps running while compose runs `migrate`, see `scripts/install.sh:967`;
   or any fenced session) commits unfenced and unjournaled, and plan 8's merge can never prove that change. How checked:
   `detach_journal` runs in its own statement before drizzle's transaction (client.ts:46), the only trigger on a public
   table is `net_journal` (0057:238-239), and `net_fence` sits on `net.journal` alone (0057:153). Fence 4 (Task 4's
   `endSessions` at maintenance begin) and `AppMode` maintenance narrow this, but both are outside this slice and the
   fence that is meant to fail closed on its own does not. This follows ruling 2 to the letter, so the lead may rule it
   down; the smallest code fix that keeps ruling 2's point: `detach_journal` keeps each trigger and replaces the body of
   `net.journal_<t>()` with a stub that names no column, `PERFORM net.assert_lease('0 s', NULL); RETURN NULL;`. Then a
   migration that drops a column still runs (unfenced superuser), a fenced session is refused while the journal is off,
   and `attach_journal`'s CREATE OR REPLACE puts the real body back; `problems()` also stops seeing every table without
   a trigger during each Update (see Task 4 notes).

## Minor

- `0057_net.sql:199-205`: `old` keeps every column of a deleted or changed row, so `net.journal` holds `machines.machine_key`
  (plain text), `nodes.account` (a person's email), `link_tls`'s sealed keys and the token hashes. No agent path reaches
  `net` (no USAGE, every function revoked), so no new exposure here; plan 7's backups, plan 8's merge and anything that
  ships the journal must treat `journal.old` as the SECRET columns. A ledger line would do.
- `0056_sources.sql:13` rewrites `task_events` (volatile default) and `defer_foreign_keys` takes ACCESS EXCLUSIVE on every
  table with a foreign key once, with no `lock_timeout`, while the old app may still hold locks: a one-time stall on
  the first Update, acceptable, worth a line in the ledger.
- `test/journal.test.ts:695`: rows of one statement are ordered by `at, id`; two trigger fires within one microsecond
  would fall back to the random id. Practically never, but comparing the keys as a set, or `together` rows unordered,
  removes the dependence on ids the conveyor forbids.
- `test/real/journal.test.ts:1088`: `fences the agent role whatever it sets` sends `SET` through `agents.run`. Task 3
  wires `checkAgentSql` into the `database` tool, not into `run` (plan 3:503), so the test keeps proving the fence; if a
  later task moves the check into `run`, this test turns into a parser refusal and proves nothing. Note for that writer.
- `apps/server/src/modules/keeper/lease.ts`: `//` comments where `apps/server` writes `/* */` (AGENTS.md: match the code
  around you). The lease code itself matches the Interfaces and the plan's table line by line; the limits are on the
  right side (`>` LATE_MS and BACK_MS, `<` LEASE_MS), checked against rows 1341-1350 of the package.
- No red run of `test/lease.test.ts` is in `runs/` (only `remote-p3lease-check`); the commit says 23 hand breaks. Not
  verifiable from here.
- `test/real/journal.test.ts:1014` imports `ENDLESS_LEASE` from `global-setup.ts`, which loads PGlite and its migrator
  at import inside a real test. Harmless, slow.

## Checked and found right

- `assert_lease`: every null condition falls to the refusal (missing rows, unknown setting); `session_user`, not
  `current_user`, so `SET ROLE` changes nothing and `SECURITY DEFINER` does not promote the agent; `search_path` as
  ruling 12, every table schema-qualified; `split` needs no sync, `normal` does; `synchronous_commit` must be `on`.
- The agent role: own login, no superuser, no USAGE on `net` or `net_local`, `applied` and `tool_calls` in `HIDDEN` and
  out of `grantsFor`'s loop; triggers fire for it although `EXECUTE` is revoked; `write_journal` is the one SECURITY
  DEFINER writer and PUBLIC cannot call it. `SET CONSTRAINTS ALL IMMEDIATE` and `SET LOCAL synchronous_commit` are the
  spec's known holes and belong to Task 3's parser, which already refuses every non-row statement (`sql-check.ts`).
- `xact` from `pg_current_xact_id()`, not a setting (test at journal.test.ts:727); bytea as `sha256:` hash on real
  Postgres with 50 MB under `transaction_timeout=5s`; wide tables through `||`.
- `migrateDb` puts the journal back after a failed run and still throws the failure; `AFTER_MIGRATIONS` runs as one
  simple query, so attach and defer commit together; `to_regprocedure` guards older databases.
- Migrations 0056 and 0057 by build ruling 5, snapshots present (omitted from the package, in the tree), `_journal.json`
  in order; the `tasks_*` indexes ruling stands (already in 0045).
- Tests that would pass with the code wrong: none found; each fence case asserts `HHF01` by code and the row's absence.

## For Task 4's writer (not findings)

- `net_local.state.cluster` and `machine` are NOT NULL: `take()` must write `cluster` (from the existing row or
  `pg_control_system()`); the plan's `take` text names neither.
- `term_number` is `bigint`: pg answers a string; `Term.number` is a number, so cast.
- On PGlite `createTestSql` is fenced (`hornhoof.fenced = on`): after `fence()` a `prune()` is refused with `HHF01` until a
  new `take()`; keep the plan's prune tests under a live lease. On real Postgres `keeperSql` is an unfenced superuser.
- While `migrate` runs (Important 1), `problems()` names every public table as missing its trigger, so the keeper logs
  `Hornhoof does not lead here until this is fixed: <about 60 names>` once per Update unless maintenance mutes it.
- `withJournalBackAfter` only warns when the put-back after a failed migration fails too: the company then has no
  trigger anywhere and only `problems()` keeps it from leading. By design, but do not lead on a stale `problems()`
  answer there.
- Task 3's `-c hornhoof.fenced=on` must go on `openDb`'s pools only, not into `openPool`, or `migrateDb` becomes fenced
  and an Update under a maintenance lease fails.

## Count

Critical 0, Important 1, Minor 7.
