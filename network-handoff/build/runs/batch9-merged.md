# Batch 9: what the fix round does

Reports: `network-build/runs/batch9-journal-claude.md` (Claude), `network-build/runs/batch9-journal-agy.md` (Antigravity), `network-build/runs/batch9-harness-claude.md` (Claude). Read all three from the top. Check each claim first; if one does not hold, say why and leave it. Each fix from a failing test.

## Not a fix
Antigravity's Critical (a `pg_temp` function or operator shadowing an unqualified call inside the journal's SECURITY DEFINER functions) does not hold. Postgres never searches the temporary schema for functions or operators, whatever the search path says; the lead ran it. Leave `0057_net.sql`'s qualification as it is, and do not revoke TEMPORARY for this reason.

## Important: `migrateDb` and the journal (both readers, `client.ts`, `0057_net.sql`)
Today `BEFORE_MIGRATIONS` runs on every `migrate`, also with nothing to do, and `detach_journal` drops every trigger. So a by-hand `docker compose up -d` over a live company (compose runs the finished `migrate` again) takes ACCESS EXCLUSIVE on every table twice, a write in that window commits with no journal row and no fence, and the keeper's `problems()` can see every table without its trigger. Plan 3's Review Focus 2 promises the maintenance lease refuses the app's commits while `migrate` runs; of fence 1 that is not true.

1. With no migration to apply, `migrateDb` does not take the journal off. It compares what the migrator would apply, as `applyMissingMigrations` already reads it. It runs `AFTER_MIGRATIONS` only if a public table lacks `net_journal`, a stub body is left (see 2), or a foreign key is not deferrable, so a killed run heals at the next `migrate`. Test: two `migrateDb` runs in a row leave the same trigger oids; a run with nothing to do leaves a session's write journaled throughout.
2. `detach_journal` keeps each trigger and replaces the body of `net.journal_<t>()` with one that names no column and refuses a fenced session with `HHF01`, whatever the lease says. A session that is not fenced (the migration's own) passes and writes no journal row. So a migration that drops a column and writes that table still runs (ruling 2's point), a fenced session is refused during `migrate`, and a killed run fails closed. `attach_journal`'s `CREATE OR REPLACE` puts the real body back, makes a trigger for a new table, and drops the function of a table that is gone. Tests: under detach, a fenced session's write refused with `HHF01` and an unfenced one passes with no journal row; a migration that drops a column and writes that table passes; `attach` restores journaling; a table dropped in a migration leaves no function behind.
3. Give Task 4's `problems()` a way to see a stub left behind: one function in `net`, say `net.journal_off()`, returning the names of tables whose journal function is the stub, not callable by the agent roles. Its use is Task 4's. Pull the "is this session fenced" test out of `assert_lease` so the stub and it share one definition, and read the setting first, then the role: no `pg_roles` scan for a fenced app row (Antigravity's Minor 1).

Update the plan's words nowhere; ledger this as a ruling in your commit body: ruling 2's "a `migrate` killed in between leaves the company in `read`" becomes "fails closed: fenced writes are refused, and the next `migrate` heals it".

## Minor, in your way
4. `0057_net.sql:119-122`: `a.attnum = ANY (i.indkey)` takes `INCLUDE` columns too. Use the key's own attributes (`i.indnkeyatts`).
5. `test/journal.test.ts:695`: rows of one statement are ordered by `at, id`, which falls back to a random id on a tie. Compare without the order: tests do not depend on ids.
6. `apps/server/src/modules/keeper/lease.ts`: `/* */` comments, as `apps/server` writes them.
7. `test/real/auth-locks.test.ts:30`: a failed `beforeAll` makes `afterAll` throw on `app.close()`, hides the cause and leaves the database. Guard it. `pg.ts:46`'s `drop()` should try every statement.
8. `test/real/auth-locks.test.ts:118`: the sign-in test waits for 2 sessions where the pool holds up to 10. Wait for the pool's size, so that it does not depend on the machine's speed.
9. `test/real/run.sh`: pass `POSTGRES_PASSWORD` by name from the environment, so the value is not on a command line.

## Not yours
The rest of the Minors go to the ledger, and the notes for Task 4's writer go to that writer. `tools/database.ts`'s message for a schema refused goes to Plan 3 Task 3's writer.
