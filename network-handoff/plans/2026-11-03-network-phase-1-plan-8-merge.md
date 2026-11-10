# Network Phase 1, Plan 8: Merge, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a database of the company comes back after it went its own way, the leading machine brings into its own
database what that database did and the leader lacks: a change the journal proves is applied, a row the leader lacks
is added, and any other difference becomes a conflict with both values, which the orchestrator settles, or the CEO
when it is about people, access, plans or machines. In this plan the database a restore set aside merges at once, is
saved as an encrypted bundle for 30 days and then removed; the journal's way, which plans 9 and 10 need for copies and
split machines, is built whole and tested on forks of one database.

**Architecture:** One migration, `0054_merges` (custom): `net.merges`, `net.merge_rows`, `net.merge_conflicts`,
`net.merge_consumed`, `net.restores` and `net.horizon`, each with plan 3's fence, and `fork` among the reasons of
`net.backups`. A gate for the app's writes (`db/gate.ts`) lets a merge run while the app's own writes wait outside
their transactions. The folder
`modules/merge/` holds the rule of each table (`rules.ts`), what the catalog says of each table (`facts.ts`), the plain
words (`words.ts`), the source (`source.ts`, the one file more that the fence lint lets open a client), the reading of
both sides (`read.ts`), the planner (`plan.ts`), the applier (`apply.ts`), the completion check (`check.ts`), the kept
databases (`kept.ts`), the loop that runs merges while the app leads (`merger.ts`), the merge task (`task.ts`), the
picks (`picks.ts`), the orchestrator's tools (`tools.ts`) and the CEO's routes (`routes.ts`). The data keeper asks for
fork bundles through plan 7's dump path, the updater dumps a kept database, and the keeper's prune leaves the journal
alone while a merge waits. The web app gets the restore dialog's choice, the kept databases' states in Settings and
the CEO's merge card.

**Tech Stack:** TypeScript on Node 22; Fastify 5; drizzle-orm 0.45.4 on node-postgres and PGlite (`dumpDataDir` and
`loadDataDir` make a fork in tests); `pg` for the source's client; bash 3.2 and BusyBox for `updater.sh`; React for
the web app; vitest with PGlite; Docker for `npm run test:real` and `npm run test:lab`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` section 5 (the cut-off return: "Safe merge", steps 1 to 8,
"After a restore", "Known limits"), 3.7 ("Sequences", "The journal", "Foreign keys", "No database is thrown away"),
3.8 ("Making": fork dumps are bundles; "Restoring": "A restore starts a new history ... to roll back on purpose, the
CEO removes those databases on the warning screen"), 3.9 ("Where a change came from"; "Jobs" for what this plan
leaves to plan 10) and section 12's merge bullets. Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan
8's entry.

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in the series' worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network` on its branch `network`, after plan 7's last task is
committed there. No new worktree: nothing of the series ships until the series merges into main, once, at its end.

**Handed over** (done on the `network` branch before this plan starts; none of it is shipped):
- Today's code: `db/schema.ts` (the tables, their keys and checks; agents' `kind` `orchestrator`, `head` or `worker`;
  the partial unique indexes `agents_one_head`, `agents_one_orchestrator` and `turns_one_open`; `notebook_notes`'
  `ON DELETE CASCADE` and `test_runs`' `ON DELETE SET NULL` on `department_id`); `db/agent-sql.ts` (`HIDDEN`);
  `db/agent-sql.ts`' `SECRET` (the columns that hold a password, a token or a key); `db/client.ts` (drizzle's
  `migrate`);
  `config.databaseUrl`; `modules/tasks/engine.ts` (`createTask`, `updateTask`, `TaskChange`, `Actor`, `NewTask`,
  `Wake`, `inRepository`); `modules/tasks/wake.ts` (`wakeAll`); `modules/tasks/tree.ts` (a task's branch is
  `task-<number>` when `inRepository`, a turn's `turn-<number>`); `modules/tasks/decisions.ts` (`DecisionSubject`,
  `decisionOwner`, `Decisions`, `visibleDecisions`); `modules/tasks/routes.ts` (`GET /api/requests`, which answers the
  decisions); `modules/tools/mcp.ts` (`toolsFor`: what is registered after its early return for every other kind of
  agent is the orchestrator's alone); `ctx.bus`; in `apps/web` `screens/Tasks.tsx` (the decisions, `ComputerCard`
  among them), `api.ts`, `types.ts`, `i18n/en.ts` and `ru.ts`.
- Plan 3: `net` and `net_local`; `net_local.state` (`cluster` is the system identifier); `net.journal` (`id`, `xact`,
  `at`, `tbl`, `op`, `key`, `cols`, `old`), written per table by `net."journal_<table>"()`; `net.fence_check()`,
  `net_fence` and `problems()` (`net.<table> has no fence trigger`); `net.defer_foreign_keys()` (every foreign key of
  `public` is `DEFERRABLE INITIALLY IMMEDIATE`); `stripSettings(url)` and `openPool` (the app's pool runs with
  `transaction_timeout=5s` and, under a keeper, `hornhoof.fenced=on`); `LeaseStore.prune(batch?)`, the keeper's prune
  timer and `test/real/lease-store.test.ts` (`prunes as the keeper after the lease ended`); the fence lint
  (`test/fence-lint.test.ts`); `createTestSql`, `setLease`; `npm run test:real` with `realDatabase()` on Postgres
  17.11. `openTestDb` in `test/helpers.ts` is not exported on the branch: Task 2 exports it.
- Plan 4: `applied (source, at, base)` and `tool_calls (id, job_id, answer, at)`; `nodeSource`, `webSource`,
  `toolSource`, `withSource`, `recordSources` (`db/sources.ts`: the one wrapper around the app's `db.transaction` and
  its write statements; a transaction in an open source inserts its step into `applied`); the
  tool wrapper that runs a tool call in `withSource(toolSource(<invocation>))`; `task_events.uuid`; the prune of
  `applied` and `tool_calls` beside the journal.
- Plans 5 and 5b: the columns the keeper's report writes on `machines` (`web_port`, `peer_port`, `commit`, `uptime_s`,
  `fsync_p99_ms`, `disk_free`, `report_at`, `addresses`, `path`, `direct_fails`, `renew_at`, `update_commit`,
  `update_state`, `owner_pin`) and those the follow of an update writes (`go_commit`, `go_at`, `failed_commit`,
  `failed_at`); the tables `authority`, `certificates`, `peer_secrets`, `machine_tickets`, `machine_online`,
  `person_keys`.
- Plan 6: `machine_access` (only a machine's owner opens it) and `computer_runs` (`waiting`, `sent`, `done`, `lost`).
- Plan 1b: `sign_in_attempts`, `link_tls`.
- Plan 7: `net.backups` and the check on its `reason`; the bundle's manifest `reason`; `machines.held_backups`;
  `recovery_keys`; `modules/backups/` (`bundle.ts`, `records.ts`, `holders.ts` with `pickHolders` and
  `refreshHolders`, `restore.ts`: `Restores`, `start`, `afterSwap`, `applyCarry`, `readRestoreStatus`; `types.ts`:
  `RestoreStatus` with `kept`, `MakerView`; `routes.ts`: `GET /api/backups` with the newest 10 bundles and `kept`,
  `POST /api/backups/:id/restore`, `GET /api/network/backups`, `POST /api/network/backups`, the report's
  `heldBackups`, at most 16); `restore.json` (`attempt`, `id`, `dumpedAt`, `carry`);
  `UpdaterControl.claim` and `POST /api/updates`; the keeper's `BackupKeeper` (`dump.json`, the latest 2 it keeps, one
  dump per 10 minutes); the updater's `dump_request`, `owned` and `applied`; the database `hornhoof_before_<stamp>` a
  restore keeps with its connections off; `apps/web/src/screens/Backups.tsx` (the restore dialog, `kept`) and
  `apps/web/test/api-mock.ts`; the lab's `steps.ts` and `backups.test.ts`; `guide/backups.md`.
- Where the branch's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and data made at run time.
- No new npm dependency. One new migration, `0054_merges`, by `npx drizzle-kit generate --custom --name merges` from
  `apps/server`; never an edit of an older one.
- The safe merge (spec section 5): the merge never deletes a row or overwrites a value on the leader unless the journal
  proves that the source changed it after the two parted, from the value the leader still holds, and the leader did not;
  a row's absence proves nothing, and a kept database never proves anything (rulings 3 and 5). It never writes the
  source: the source is read in one read-only transaction. Every difference it cannot prove stays as the leader has it
  and is listed with both values.
- A conflict's values are kept in `net.merge_conflicts` only. A secret column's value (ruling 9) never reaches the
  orchestrator, a screen, a log line or a task's text; no log line holds a row's values.
- Ivan's rules: only a machine's owner opens computer access to it, so no pick opens it (ruling 9); no step of this
  plan asks Ivan to type a command. Everything Ivan does here is a click: the restore's choice, a pick, "Leave it out".
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; `npm run test:real` and `npm run test:lab` need Docker. Types, from the worktree root: `npx tsc
  -p apps/server/tsconfig.json --noEmit`, and `apps/web` likewise when touched, each printing nothing. `bash -n` and
  `shellcheck` on `apps/updater/updater.sh` print nothing when it is touched. Never run prettier.

## Rulings made while planning

1. **One plan; what it leaves.** The reading, the planner, the applier, the records, the task and the picks only work
   whole, and each task below ends in something a reviewer can reject alone, so the plan is not split. Before plan 9
   no machine but the server holds data, so the only database that ever comes back in this plan is the one a restore
   set aside on the leader itself. (Deviations to rule on.) a) The spec's step 3 reads X "over the peer link"; this
   plan reads a database of the leader's own Postgres through one interface, `MergeSource`, and plan 9, which makes
   copies and the data link between machines, adds the source read over it. b) The overview's plan 9 entry cites
   "plan 8's restricted upload" (spec 3.3, a machine that lost whole-company scope uploads its unmerged rows): it is
   the peer reading of a) with a contract of its own, who may upload what and when the machine may wipe after, so it
   moves to plan 9, which defines both. c) Spec 3.9's jobs while a merge is pending (an unknown job keeps running, its
   events and results parked, X's tool tokens accepted) are plan 10's by the overview; section 5's "open ones stay
   open while their node lists them" and "parked results apply" need exactly those, so they go there too. Here
   nothing the source left open runs again (ruling 7). d) Steps 1 and 2 as a returning machine's own keeper and
   updater take them (fenced, `read`, its link stopped, its own bundle) and section 12's bullets about copies and
   returning machines are plans 9's and 10's; nothing runs on a kept database, and its bundle is ruling 15.
2. **A source is one database read in one snapshot.** `MergeSource` runs queries in one `REPEATABLE READ READ ONLY`
   transaction on its own connection, which `default_transaction_read_only` also opens read-only; its first query
   takes the snapshot before it answers. The merge reads the source only through it and never writes it. A kept
   database is read with the app's own credentials: the address is `stripSettings(config.databaseUrl)` with its path
   set to the database's name (in `pg` a database named in the address wins over a `database` option, so the name is
   never passed beside it), and the first query checks that `current_database()` is that name. `source.ts` is the
   one file the fence lint lets open a client beside its three. The two sides must have the same shape: in `public`
   the same tables with the same columns and types, else the merge waits with "The two databases are of different
   versions." The number of migrations is not compared: `0054` adds nothing to `public`, so a database plan 7 kept (at
   `0053`) merges, and a `net` table a source lacks (`net.merges`, `net.merge_rows`, `net.merge_conflicts`,
   `net.merge_consumed`, `net.restores`, `net.horizon`) reads as empty. The source's `companies` row must be the
   leader's, else "This database is of another company."
3. **Which way.** The merge compares row by row (spec "After a restore": only additions; every other difference a
   conflict, the leader's value kept) when the source is a kept database, when the leader has a restore (`net.restores`,
   ruling 13) the source lacks, or when the two journals share no id above the cutoff (step 3: "they prove nothing").
   Otherwise it goes by the journal. A kept database always compares, so a merge never undoes a restore's changes on
   its own: what the restore removed comes back as an addition, and what it put back as a difference.
4. **Where the two parted.** The cutoff is the later of the two sides' horizons (`net.horizon`, ruling 14), less one
   day, or none when neither side pruned. A side's ids are its journal rows at or after the cutoff. `A`, the source's
   changes, are its ids the leader lacks and no merge consumed (`net.merge_consumed`); `B`, the leader's, are its ids
   the source lacks; `shared` counts the ids both hold. The day of margin only widens what is read and proves nothing
   by itself: a journal row's `at` is when its row changed, not when its transaction committed, and a prune deletes
   in batches. What a row of `A` proves is ruling 5's base check.
5. **What the journal proves.** First the source's transactions whose source the leader lists go: every row of `A`
   whose `xact` also inserted an `applied` row the leader's `applied` lists, or a `tool_calls` row the leader's
   lists, is consumed as `skipped` (spec step 4). Those rows, and every row of `A` older than the leader's own horizon
   (the leader may have pruned what it did then), are `S`: read, compared, never taken. The rest of `A` proves. Per
   table and key, with the key's rows of `A` and `S` in order (`at`, then `id`; plan 3 writes one key's rows in the
   order their transactions took the row), X the source's row now and Y the leader's, and the columns of ruling 6 left
   out everywhere:
   - A column's base is its value on the source before `A` first changed it: the `old` of the first row of `A` that
     names it. A key whose first row of `A` is an insert has no base.
   - X and Y both have the row: a column is taken from X only when a row of `A` changed it, no row of `S` names it,
     `B` neither changed it nor inserted or deleted the key, and Y's value is its base. A key `A` inserted that Y holds
     (only a natural key can) is compared whole: equal, or a conflict `differs`. Any other column that a row of `A` or
     `S` names and whose values differ is in conflict; one row may take some columns and list others. A column no row
     of `A` or `S` names is the leader's.
   - X has the row and Y none: added when `A` inserted the key and `B` did not delete it; else a conflict
     `changed_removed`.
   - X has no row: Y's row is deleted only when the key's last row in `A` and `S` is a delete of `A`, `A` did not
     insert the key, `B` did not touch it, and Y's row equals the base row (that delete's `old`, with each column an
     earlier row of `A` changed at its base); the applier then looks for the leader's rows that point at it (ruling
     8). A key `A` inserted and deleted again is nothing. Otherwise nothing is deleted, and when a row of `A` named a
     column of the key and Y has the row, it is a conflict `removed_changed` whose `there` is the key's last `old` in
     the source's journal (the row as it was before it went; a `bytea` value only as its hash).
   - A key only `B` touched, or only `S`, is the leader's: the leader has its own result of that input.
   So a row's absence never deletes, a value a skipped transaction wrote is never taken, and an update that changed
   nothing (`cols` empty) does nothing.
6. **Columns that are never compared.** `updated_at` (on `tasks`, `notebook_notes`, `improvements`) and `tasks.version`;
   `nodes.last_seen_at`, `nodes.status` and `nodes.version`; `subscriptions.status`, `limits` and `models`;
   `machines.server_order` and `server_why` when plan 9 has added them; and the machine columns plans 5, 5b and 7 have
   the keeper's report and an update's follow write (Handed over, and `held_backups`). A row the merge adds brings the
   source's values; a row it changes keeps the leader's, but for `updated_at`, which takes the later of the two, and
   `tasks.version`, which takes the larger plus 1. (Additions to rule on: the spec lists `nodes.last_seen_at`,
   `nodes.status`, `subscriptions.status`, `limits`, `models`, `server_order`, `server_why`, `updated_at` and
   `tasks.version`; `nodes.version` and the machines' report columns are reports as those are, written every minute
   on both sides, and would make every machine a conflict.) An end both sides recorded is one end: two non-null values
   of `revoked_at`, `removed_at`, `closed_at`, `used_at` or `retired_at` count as equal and the leader's time stays, so
   a certificate revoked on both sides, or the restore's carry, lists nothing. Values are compared by their type: a
   timestamp as an instant to the microsecond, a `bytea` by its SHA-256 (the journal keeps only `sha256:<hex>`),
   anything else as JSON with an object's keys sorted.
7. **The rule of each table** (`rules.ts`; a table `public` holds that the list does not name stops the merge with
   "No merge rule for public.<table>.", and a test keeps the list whole):
   - Never merged (`skip`): `node_codes`, `machine_tickets`, `pending_wakes`, `sign_in_attempts` and `link_tls` (spec
     step 5: join codes and waiting wakes go; tickets are join codes too; a sign-in count and the link's certificate
     belong to the machine that leads). `sessions` stay (spec) by the journal, but are never added after a restore,
     whose carry ended every session on purpose (plan 7, ruling 14).
   - Added and never compared (`add`): `applied`, `tool_calls`, `machine_online`. A source's `applied` row the leader
     lacks is added, so a node that sends that message again finds it done.
   - Logs (`log`), matched by a column and added with a new sequence value (spec 3.7), never compared and never
     deleted: `agent_events` by `id` with a new `seq`, `task_events` by `uuid` with a new `id`, `agent_changes` by
     `id`. By the journal a `task_events` key (its `id`, a number of each side) is read as its row's `uuid` on the
     source first, and the leader's row is found by that uuid. `attachments` stay `rows` (deviation to rule on): main
     sets an attachment's `request_id` when a picture is attached to a request and deletes old files by its retention,
     changes the journal proves; after a restore `compare` only adds them, as it would a log's.
   - `map_returns.source_key` (`task:<id>` or `message:<seq>`, numbers of each side) is read on both sides as the
     uuid of that event before it is compared, and written as the leader's number of the event with that uuid, in an
     added row, a change and a pick; with no such event on the leader the unit is `refused` ("Its task_events row is
     not here."). The logs go before `map_returns` (the rule's `after`).
   - Numbers (`tasks`, `turns`, `test_runs` per company, `notebook_notes` per company and department): a row added
     whose number another row of its scope holds takes the next free one, the scope's highest plus 1; the source's
     number is kept for the task's text ("was #57").
   - One open turn: a turn added `open` while the leader has another open turn is added `closed`, `closed_at` now, and
     the source's tasks of that turn that are not done or cancelled are added in the leader's open turn.
   - One head and one orchestrator: an agent added as `head` of a department that has a live head, or as
     `orchestrator` while one is live, is added as `worker`.
   - Nothing runs again: a row of `jobs`, `computer_runs`, `test_runs` or `test_parts` that the merge or a pick writes
     in an open state is written closed: a job `queued` or `running` as `failed`, `finished_at` now, with the error
     "Ran on <label> while it was cut off." (by the journal) or "Ran before the restore; how it ended was not kept."
     (after a restore); a computer run `waiting` or `sent` as `lost`, `done_at` now; a test run `running` as
     `stopped`, `finished_at` now; a test part `queued` or `running` as `stopped`, `finished_at` now, with the job's
     error. Main's scheduler hands out queued test parts by themselves, so a failed job alone would not stop them. A
     row the leader holds open stays as it is (plan 10).
   - Computer access is never opened by a merge: `machine_access`' `until`, `opened_by`, `opened_at` and `grant` are
     never taken from the source; a row the merge adds has them null, and a difference in them is a conflict only
     `here` settles (ruling 11). So a machine added after the restored bundle comes back with its access closed.
   - One unique match: a `person_access` row whose insert fails on `person_access_place` is that place's row on the
     leader when every other column but `id` and `created_at` is equal (plan 7's carry writes these rows with new
     ids); it is recorded as `matched`, and no row points at a `person_access` row. Any other error of class 23 is
     `refused`, naming the constraint. No other unique key matches rows: a key's predicate and its nulls
     (`agents_one_head`, `jobs.tool_token_hash`) would make a match by its columns wrong.
   - Soft references (`SOFT_REFS`), ids in a column no foreign key checks: `tasks.gates` and `tasks.panel` (agents),
     `tasks.after` (tasks), `subscriptions.target_id` (a department or a team, by `target_kind`). They are checked as
     foreign keys are (ruling 8). The ids and names in `turns.messages`, `task_events.data` and `agent_events.data`
     are history, shown as written, and not checked.
   - `net.backups` rows the leader lacks are added by id, in both ways: a restore of an older bundle then lists, and
     can check, the bundles made after it. (Addition to rule on.)
   - A conflict an earlier merge left open in the source (its `net.merge_conflicts`) is carried: it becomes a conflict
     of this merge with its kind, its operation and its `there`, `here` the leader's row now, and `carried` the id it
     had first, unless the leader holds a conflict of that first id already. It may hold the only copy of a value the
     company wrote.
   - Topics, which say whose a conflict is: `people` (`people`, `invites`, `sessions`, `person_keys`,
     `sign_in_attempts`), `access` (`person_access`, `machine_access`, `recovery_keys`, `certificates`, `authority`,
     `peer_secrets`, `public_links`, `link_tls`), `plans` (`subscriptions`, `nodes`, `plan_credentials`), `machines`
     (`machines`, `machine_online`, `computer_runs`, `node_codes`, `machine_tickets`), and `work`, the orchestrator's,
     for every other table. Every table in `HIDDEN` has a topic of the CEO's or is `skip` or `add`.
8. **One transaction, while the app's writes wait outside theirs.** The merge runs inside the write gate
   (`db/gate.ts`): every write of the app's process enters the gate before its `BEGIN` and leaves after its end (a
   `db.transaction` that is not read-only and a write statement outside one, both in plan 4's `recordSources`
   wrapper, and an agent's SQL in `write` mode). The merge closes the gate to new writers, waits up to 30 s for those
   inside to leave, and then holds it alone. So a write that comes during a merge waits before its transaction opens,
   plan 3's 5 s `transaction_timeout` never ends it, and no lock of the app's is held when the merge locks, so no
   lock order can cross. (Addition to rule on: the spec says only that the app's writes wait.) Then `REPEATABLE READ`;
   `SET LOCAL lock_timeout = '10s'`, `statement_timeout = 0` and `transaction_timeout = 0`; `LOCK TABLE` every table of
   `public` the merge may write `IN EXCLUSIVE MODE` (reads go on), for any session outside the gate, before the first
   read takes the snapshot; then `SET CONSTRAINTS ALL DEFERRED`. Each row the merge writes is a unit, tables parents
   first (by their foreign keys and the rules' `after`, a cycle in name order), each under a savepoint (a batch of
   units may share one, and goes one by one when it fails). An error of class 23 (a unique key, a check, a null) takes
   the unit back to its savepoint and makes it `refused`, naming the constraint; any other error (a lock not taken in
   10 s, a fault) ends the whole transaction and changes nothing, and the merge is tried again later. Then the
   reference pass: every unit whose row points, by a foreign key or a soft reference, at a row that is not there is
   made `refused` ("Its <table> row is not here."), and the merge goes back to a savepoint taken before its first
   unit and writes again every unit not refused, until a pass refuses none. Nothing is ever undone by a delete or a
   value put back, so no `ON DELETE CASCADE` or `SET NULL` acts on a unit's account and no unique key another unit took
   is met by an old value; a unit that fails only in a replay is refused as in the first pass. That is the spec's row
   group: a row whose parent failed fails with it, and the merge never aborts. (Deviation in form: the group is found
   after the fact by the references and replayed, not built before, which also covers the cycle of `turns` and
   `tasks`.) A unit that deletes first looks for the leader's rows that point at the row, by a foreign key or a soft
   reference: then `still_used`, so no delete of the merge cascades. Rows the merge writes wake nobody (spec step 5):
   it writes rows only, and the screens are told once to read again.
9. **The records, and when the source may go.** The same transaction writes `net.merge_conflicts` (both values, the
   operation `there` would run, the source's latest `at`, the task the row belongs to); every id of `A` and `S` into
   `net.merge_consumed` as `applied`, `skipped`, `conflict` or `equal` (spec step 6); `net.merge_rows` for what a key
   alone does not show: a row of `S` the leader lacks (`skipped`), a matched row (`matched`, with the leader's key),
   and a row written with other values than the source's (`rewritten`, with those columns and the source's values: a
   number, a closed turn, a worker, a closed job, run or part, closed access); and on `net.merges` the counts, the
   tasks it touched, the code (ruling 10), the cutoff, its own `xact` and the status `applied`. A merge `applied`
   never runs again: after a stop it goes on with its check, so nothing it did is read as a new difference. The check
   reads the source again, in a new snapshot:
   - by the journal, every id of the source at or after the cutoff is on the leader or consumed;
   - every row of a table that is not `skip` (nor `sessions` after a restore) is on the leader by its key (a log's by
     its match), and, but in a `log` or `add` table, equal to it as ruling 6 compares (`source_key` in uuid form),
     leaving out the columns `net.merge_rows` names `rewritten` for it; or its key is named by a conflict of any merge,
     or by `net.merge_rows` as `skipped`, or as `matched` with the leader's key there; or the leader's journal names its
     key since the two parted (by the journal at or after the cutoff, after a restore once the merge was applied) in a
     transaction no merge made (`net.merges.xact`), which is the company's own later change or deletion;
   - every `net.backups` row and every open conflict of the source is on the leader.
   Only then is the merge `merged`, and only a merged or left-out source may be dropped. A row of the source that is
   neither there nor listed keeps the check failing and the database kept, the safe way. A secret column is one that
   `SECRET` of `db/agent-sql.ts` names for its table (`machines.machine_key` and `nodes.account` among them), or whose
   name ends in `_hash` or `_enc`, or is `sealed`, `wrapped`, `salt`, `iv` or `grant`: its values are kept for a pick
   but shown as "(hidden)", also where a row's name would show its key (`sessions.token_hash`). A conflict on
   `machine_access` can only be settled by keeping the leader's row: computer access is opened by the machine's owner,
   on its card (plan 6).
10. **The merge task.** A merge with a conflict of the orchestrator's, a renumbered row or a task with code becomes one
    task of the orchestrator's (spec step 7), made by `createTask` as the orchestrator with himself as assignee:
    "Bring back what <label> did while apart (<from> to <to> UTC)" by the journal, "Bring back what <label> held
    (<from> to <to> UTC)" after a restore. What it needs is on `net.merges`, written in the merge's transaction, since
    the source may be gone when the task is made: `tasks`, the tasks of every row the merge added, changed or listed,
    and `code`, for each of them that `inRepository`: its number on the source, its branch by that number, and the
    machines the source's jobs on it ran on with their last time (spec step 8). Its body says what came back, counts,
    the renumbering ("Task #63 here was #57 on <label>"), the code, the orchestrator's conflicts grouped by task and
    then by table with both values in plain words (at most 100, then "and <n> more; merge_conflicts lists them"), and
    of the CEO's only how many: no value, name or table of a conflict of the CEO's or of a table in `HIDDEN` reaches
    the orchestrator. Then what to do: settle them with `merge_conflicts` and `merge_pick`, tell the holders of tasks
    that changed, and report to the CEO what was kept and what he decided. A second source merged while that task is
    open joins it (spec: "More than two sides merge one at a time into the same merge task"): its title names every
    source and its body is written again by `updateTask` as the orchestrator, who is woken on it (`wakeAll`,
    `assigned`). With no live orchestrator that can take it, the task is tried again each minute; the drop and the
    CEO's conflicts do not wait for it.
    Renumbered tasks and turns keep no branch column: their code stays on the branch of the source's number, which
    the task names, and the orchestrator moves it. (Deviation to rule on: a branch column on tasks and turns would let
    a renumbered task keep its branch; it is left out, since branches today follow numbers everywhere.)
11. **Picks.** `merge_pick` settles conflicts of the orchestrator's topic: one, a list, or every open one of a merge,
    a table or a time range (spec: "in bulk by table, side or time range"), at most 500 a call. `here` keeps the
    leader's row as it is; `there` runs the conflict's operation with the source's values (an update writes its
    columns, an insert adds the row with ruling 7's rules, a delete removes the leader's row when nothing points at
    it); `value` writes the given columns of one `differs` conflict. Each conflict settles in its own transaction,
    journaled and fenced as any change of the app, in the tool's source, but for a group: `there` on a `refused`
    conflict settles with it, in one transaction, every open `refused` conflict of the same merge its row points at or
    that points at its row (by foreign keys and soft references, both ways, on and on), since a turn and its task can
    only come back together; the group settles or fails whole, and is the CEO's when one of it is. One that fails
    stays open with its reason. The answer names the tasks whose rows changed, whose holders he tells. The CEO picks
    the same way on his screen, any conflict, and is the only one for `people`, `access`, `plans` and `machines` (spec
    step 7), each a decision of his (`DecisionSubject` `merge`).
12. **Kept databases.** At its first lead after a start the app makes a `net.merges` row (`kept:<name>`) for each
    database named `hornhoof_before_<stamp>` that has none: `pending`, or `removing` when the CEO chose so (below) or
    when it holds no company. Its label is "the database from before the restore of <time>", or "the database kept as
    <name>" for one plan 7 kept before this release, which has no mark. The app turns its connections on (`ALTER
    DATABASE ... ALLOW_CONNECTIONS true`) to read it. A `fork` id is set when it holds the company, and the data
    keeper makes that fork bundle (ruling 15). The merger runs one merge at a time, every minute while the app leads,
    waiting twice as long after each failure, up to an hour: a `pending` merge is applied and then checked, an
    `applied` one only checked; a merge `merged` or `removing` whose fork bundle is in `net.backups` (or that needs
    none) has its database dropped and is `done`. The restore dialog has "Bring back what came after <time>", on by
    default; turned off, the database is left out: its bundle is made and it is dropped without a merge (spec 3.8:
    "the CEO removes those databases on the warning screen"). The choice is written to `/control/restore-choice.json`
    before the order goes, since the app's memory does not outlive the swap, and removed only after the `net.merges`
    row that holds it has committed; a file of another attempt stays for the next restore to write over. Settings
    shows each kept database's state, and "Leave it out" while its merge is `pending` or `applied`. An Update is
    refused while a merge is `pending` or `applied`, since migrations could part the two shapes (ruling 2): "A database
    from before a restore is still being brought back. Wait for it, or leave it out in Settings." (Addition to rule
    on.) The fork bundle is asked for at once and the merge does not wait for it, since the database stays until both
    are done.
13. **A restore leaves a mark.** `afterSwap` writes `net.restores` (the attempt, the bundle, its `dumpedAt` and the
    kept database's name) once per attempt, also after a restore from a recovery file, which has no carry. The order
    does not outlive the swap and the restored database rarely holds its own bundle's record (the record is written
    after the dump), so the updater writes `dumpedAt` from `restore.json` into `restore-status.json` beside `kept`. A
    status written before this release has no `dumpedAt` and leaves no mark. Plan 9's sources read the mark (ruling 3).
14. **The prune knows the merges** (plan 3's ruling 19). `LeaseStore.prune` deletes journal rows older than 7 days only
    while the lease's sync is `alone`, the lease has not lapsed (`until` ahead of now) and no merge is `pending` or
    `applied`; each prune that deletes a row writes `net.horizon.below` (7 days ago) in the same transaction and
    deletes `net.merge_consumed` rows older than it. Plan 3's real test that prunes as the keeper after the lease ended
    changes with it. Plan 9, with copies, adds "every data machine confirmed".
15. **Fork bundles.** A fork bundle is a bundle as plan 7 makes them, with the reason `fork`: the keeper writes
    `dump.json` with the kept database's name, the updater turns its connections on and dumps it, and the keeper
    seals, signs and records it, sending the record again until `net.backups` has it. It is kept 30 days from
    `madeAt` outside the usual rotation (spec step 2), on the data machine and on its holders: its holders are picked
    as for any bundle, and it stays named for them beside the newest 2 until its 30 days end. It is listed in "Restore
    from a backup" beyond the newest 10 as "Set aside before a merge", reported held beyond the newest 16 (at most 32
    in all), and restores as any other.
16. **Times in a task's text are UTC.** A task's title and body are stored text that every reader sees alike, so they
    say "14:02 to 15:30 UTC", with the day when the two are not on one day.

## Review Focus

1. A confirmed write lost silently: a row or column of the source that is neither on the leader nor listed after a
   merge, by either way, also after a unit failed, a transaction was skipped, a parent was refused or the app stopped
   between the merge and its check. Tests in Task 4 (every case of `journalOutcome`, `lists a change whose base the
   leader no longer holds`) and Task 5 (`finishes the completion check`, `refuses a row whose parent is gone, and what
   hangs on it`, `never deletes through a skipped transaction`, `carries a conflict left open`).
2. A restore undone behind the CEO's back: a kept database's deletions or older values written over the restored
   ones. Tests in Task 5 (`never reads a stale absence as a deletion or a stale value as a change`) and Task 10 (`an
   older bundle restored, then the database from before`).
3. The company working while a merge runs: a task moved, an invite accepted, a page saved meanwhile. The writes wait
   before their transactions, under 30 s on a big company, and land after; none ends at 5 s, and the merge does not
   list them. Tests in Task 3 (`gates the app's writes`), Task 5 (`holds the app's writes while it runs`) and Task 10
   (`writes wait for the merge`, `holds the app's writes briefly on a big company`).
4. Something of the source running or opening again: a job, a test part, a command, or computer access on a machine
   added after the bundle. Tests in Task 5 (`stops what the source left running`, `brings back a new machine with its
   access closed`) and Task 8 (`never opens computer access`).
5. A conflict in the wrong hands: the orchestrator seeing a secret, a CEO's conflict or a hidden table in a list or in
   his task's text, settling a CEO's conflict, or a secret shown in a row's name. Tests in Task 2 (`hides secrets`),
   Task 8 (`keeps the CEO's conflicts and secrets from the orchestrator`, `tells the orchestrator only how many are
   the CEO's`) and Task 9 (`lets only the CEO pick his conflicts`).
6. A kept database dropped too soon, not at all, or the wrong one: before its bundle is recorded, before the check
   passed, the live database read in its place, or a name that is not a kept database's. Tests in Task 6 (`drops only
   what is merged and saved`, `goes on with the check after a stop`) and Task 10 (`reads the kept database, not the
   live one`, `drops only a kept database`).

---

### Task 1: The tables for merges

**Repo:** the `network` worktree, branch `network`. **Starts from:** plan 7's last task committed there. **Done when:**
from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/migrations.test.ts test/lease-store.test.ts
test/orchestrator-control.test.ts test/fence-lint.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/drizzle/0054_merges.sql` (and its `meta` entry, as drizzle-kit writes them)
- Modify: `apps/server/test/fence-lint.test.ts` (its allowed files)
- Test: `apps/server/test/migrations.test.ts`, `apps/server/test/lease-store.test.ts`,
  `apps/server/test/orchestrator-control.test.ts`, `apps/server/test/fence-lint.test.ts`

**Interfaces:**
- Produces, in `0054_merges.sql` (hand written; drizzle's schema does not describe `net`):
  ```sql
  CREATE TABLE net.merges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source text NOT NULL UNIQUE CHECK (source ~ '^(kept|machine):.+$'),
    label text NOT NULL,
    path text CHECK (path IN ('journal', 'compare')),
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'applied', 'merged', 'removing', 'done')),
    fork uuid,
    cutoff timestamptz,
    xact uuid,
    task_id uuid,
    task_wanted boolean NOT NULL DEFAULT false,
    tasks uuid[] NOT NULL DEFAULT '{}',
    code jsonb NOT NULL DEFAULT '[]',
    from_at timestamptz,
    to_at timestamptz,
    counts jsonb NOT NULL DEFAULT '{}',
    tries integer NOT NULL DEFAULT 0,
    tried_at timestamptz,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    applied_at timestamptz,
    merged_at timestamptz,
    done_at timestamptz
  );
  CREATE TABLE net.merge_rows (
    merge uuid NOT NULL REFERENCES net.merges (id),
    tbl text NOT NULL,
    key jsonb NOT NULL,
    how text NOT NULL CHECK (how IN ('skipped', 'matched', 'rewritten')),
    cols text[] NOT NULL DEFAULT '{}',
    was jsonb,
    here jsonb,
    PRIMARY KEY (merge, tbl, key)
  );
  CREATE INDEX merge_rows_key ON net.merge_rows (tbl, key);
  CREATE TABLE net.merge_conflicts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merge uuid NOT NULL REFERENCES net.merges (id),
    carried uuid,
    tbl text NOT NULL,
    key jsonb NOT NULL,
    op text NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
    kind text NOT NULL CHECK (kind IN ('differs', 'changed_removed', 'removed_changed', 'still_used', 'refused')),
    topic text NOT NULL CHECK (topic IN ('people', 'access', 'plans', 'machines', 'work')),
    task_id uuid,
    cols text[] NOT NULL DEFAULT '{}',
    here jsonb,
    there jsonb,
    at timestamptz,
    why text NOT NULL,
    picked text CHECK (picked IN ('here', 'there', 'value')),
    value jsonb,
    picked_by text,
    picked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (merge, tbl, key, carried)
  );
  CREATE INDEX merge_conflicts_open ON net.merge_conflicts (merge) WHERE picked IS NULL;
  CREATE INDEX merge_conflicts_key ON net.merge_conflicts (tbl, key);
  CREATE TABLE net.merge_consumed (
    journal uuid PRIMARY KEY,
    merge uuid NOT NULL REFERENCES net.merges (id),
    at timestamptz NOT NULL,
    how text NOT NULL CHECK (how IN ('applied', 'skipped', 'conflict', 'equal'))
  );
  CREATE INDEX merge_consumed_at ON net.merge_consumed (at);
  CREATE TABLE net.restores (
    attempt uuid PRIMARY KEY,
    backup uuid NOT NULL,
    dumped_at timestamptz NOT NULL,
    kept text,
    at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE net.horizon (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    below timestamptz NOT NULL
  );
  ```
  Each of the six gets `CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.<table>
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check()`. `net.backups`: the check on `reason`
  that `0053` made is dropped by its name and `backups_reason CHECK (reason IN ('timer', 'update', 'fork'))` added.
  `picked_by` is `person:<id>` or `agent:<id>`; `here`, `there` and `was` are a row's `to_jsonb` (or its columns), or
  null for no row; `carried` is the id a conflict had in the database it came from (ruling 7).
- The fence lint's allowed files for a pool or client gain `src/modules/merge/source.ts`, and no other.

- [ ] **Step 1: Write failing tests.**
  - `migrations.test.ts`, `migration 0054`, `adds the merge records, fenced`: after migrating fully, the six tables
    exist, each with `net_fence` (deferrable, initially deferred); `net.backups` takes the reason `fork` and refuses
    `other` with `23514`; a `net.merges` row with the source `other:x` or the status `other` fails with `23514`, two
    with one source with `23505`; a conflict of kind `other` or op `other` fails with `23514`; two conflicts with the
    same merge, table and key and no `carried` fail with `23505`, and with two other `carried` values both go in; a
    `net.merge_rows` row with `how` `other` fails with `23514`; a second `net.horizon` row fails.
  - `lease-store.test.ts`, `names what keeps it from leading`: on the fixture `problems()` names none of the six;
    after `DROP TRIGGER net_fence ON net.merge_rows` it has `net.merge_rows has no fence trigger`.
  - `orchestrator-control.test.ts`, `stays out of the merge records`: the orchestrator's `SELECT * FROM net.merges`,
    `net.merge_rows` and `net.merge_conflicts` fail with `42501`.
  - `fence-lint.test.ts`, `lets the merge source alone open a client`: the allowed list is the three files and
    `src/modules/merge/source.ts`; a line `new Client(` in a file of `src/modules/merge/` other than `source.ts` is
    named by the lint.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `npx drizzle-kit generate --custom --name merges`, its SQL, and the lint's list. When
  `0053`'s check on `reason` has no name the agent can drop, it stops and reports.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the tables that record merges, restores and the journal's horizon".

### Task 2: The rule of each table, the catalog and the words

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/merge-rules.test.ts` passes, then the whole server
suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/merge/rules.ts`, `apps/server/src/modules/merge/facts.ts`,
  `apps/server/src/modules/merge/words.ts`
- Modify: `apps/server/test/helpers.ts` (`openTestDb` exported, as it is)
- Test: `apps/server/test/merge-rules.test.ts` (new)

**Interfaces:**
- Consumes: `HIDDEN`, `SECRET` (`db/agent-sql.ts`).
- Produces:
  ```ts
  // modules/merge/rules.ts
  export type Topic = 'people' | 'access' | 'plans' | 'machines' | 'work';
  export const CEO_TOPICS: readonly Topic[];                 // people, access, plans, machines
  export type TableRule = {
    kind: 'rows' | 'add' | 'log' | 'skip';                   // ruling 7
    topic: Topic;
    match?: string;                                          // log: the column rows are matched by
    sequence?: string;                                       // log: the column that takes nextval on an added row
    number?: readonly string[];                              // the scope columns of a per-scope `number`
    task?: string;                                           // the column naming the task a row belongs to
    after?: readonly string[];                               // tables planned before it besides its parents
    afterRestore?: 'skip';                                   // sessions
    hereOnly?: readonly string[];                            // columns never taken from the source (ruling 7)
  };
  export const TABLE_RULES: Readonly<Record<string, TableRule>>;
  export const BOOKKEEPING: Readonly<Record<string, readonly string[]>>;   // ruling 6, per table
  export const ENDS: readonly string[];                      // revoked_at, removed_at, closed_at, used_at, retired_at
  export type Closing = { column: string; open: readonly string[]; to: string; at: string; error?: string };
  export const CLOSING: Readonly<Record<string, Closing>>;   // ruling 7's "Nothing runs again"
  export type SoftRef = { table: string; column: string; parent: string; list: boolean;
    when?: { column: string; value: string } };
  export const SOFT_REFS: readonly SoftRef[];
  export function ruleOf(table: string): TableRule;          // throws Error(`No merge rule for public.${table}.`)
  export function isSecret(table: string, column: string): boolean;   // ruling 9
  export function ceosConflict(table: string): boolean;      // CEO_TOPICS has its topic
  // modules/merge/facts.ts
  export type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
  export type ForeignKey = { name: string; table: string; columns: string[]; parent: string; parentColumns: string[] };
  export type TableFacts = { name: string; columns: { name: string; type: string }[]; key: string[];
    fks: ForeignKey[]; referencedBy: ForeignKey[] };
  export type Facts = { tables: Map<string, TableFacts>; order: string[] };
  export function factsOf(q: Query): Promise<Facts>;
  //   from pg_catalog for the tables of public (relkind r): columns with format_type, the primary key, foreign keys
  //   both ways; order lists the tables parents first and each after the tables its rule's `after` names, a cycle in
  //   name order
  export function sameShape(a: Facts, b: Facts): string | null;   // null, or 'The two databases are of different versions.'
  //   the tables of public, their columns and types; nothing else
  // modules/merge/words.ts
  export function nameOf(table: string, row: Record<string, unknown> | null, key: Record<string, unknown>): string;
  export function valueWords(table: string, column: string, value: unknown): string;
  export function timeWords(at: Date, now?: Date): string;          // '3 Nov 14:02 UTC', the year when not now's
  export function rangeWords(from: Date, to: Date, now?: Date): string;
  //   '14:02 to 15:30 UTC' within one UTC day, else '3 Nov 14:02 to 4 Nov 09:10 UTC'
  ```
- `TABLE_RULES`, exactly (every other field absent):
  ```text
  skip  node_codes (machines), machine_tickets (machines), pending_wakes (work), sign_in_attempts (people),
        link_tls (access)
  add   applied (work), tool_calls (work), machine_online (machines)
  log   agent_events (work; match id, sequence seq), task_events (work; match uuid, sequence id, task task_id),
        agent_changes (work; match id)
  rows  people (people); sessions (people, afterRestore skip); invites (people); person_keys (people)
        person_access (access); machine_access (access, hereOnly until, opened_by, opened_at, grant);
        recovery_keys (access); certificates (access); authority (access); peer_secrets (access);
        public_links (access)
        subscriptions (plans); nodes (plans); plan_credentials (plans)
        machines (machines); computer_runs (machines)
        companies, departments, teams, agents, proposals, improvements, test_parts (work);
        tasks (work; number company_id; task id); turns (work; number company_id; task task_id);
        test_runs (work; number company_id; task task_id); notebook_notes (work; number company_id, department_id);
        jobs, requests, attachments (work; task task_id);
        map_returns (work; task source_task_id; after task_events, agent_events)
  ```
- `BOOKKEEPING`: `tasks` `updated_at`, `version`; `notebook_notes` and `improvements` `updated_at`; `nodes`
  `last_seen_at`, `status`, `version`; `subscriptions` `status`, `limits`, `models`; `machines` `server_order`,
  `server_why`, `web_port`, `peer_port`, `commit`, `uptime_s`, `fsync_p99_ms`, `disk_free`, `report_at`, `addresses`,
  `path`, `direct_fails`, `renew_at`, `update_commit`, `update_state`, `go_commit`, `go_at`, `failed_commit`,
  `failed_at`, `owner_pin`, `held_backups`. A name a table does not have is ignored.
- `CLOSING`, exactly: `jobs` `status` `queued`, `running` to `failed`, at `finished_at`, error `error`;
  `computer_runs` `state` `waiting`, `sent` to `lost`, at `done_at`; `test_runs` `status` `running` to `stopped`, at
  `finished_at`; `test_parts` `status` `queued`, `running` to `stopped`, at `finished_at`, error `error`.
- `SOFT_REFS`, exactly: `tasks.gates` and `tasks.panel` to `agents`, `tasks.after` to `tasks`, each a list;
  `subscriptions.target_id` to `departments` when `target_kind` is `department`, and to `teams` when it is `team`.
- `isSecret(table, column)`: `SECRET[table]` holds it, or the name ends in `_hash` or `_enc`, or is `sealed`,
  `wrapped`, `salt`, `iv` or `grant`.
- `nameOf`: `tasks` `task #<number> "<title>"`; `turns` `turn <number> "<title>"`; `people` `<name> (<email>)`;
  `agents`, `departments`, `teams` `<name>`; `machines` `<hostname>` or `a machine`; `subscriptions` `<label>`; `jobs`
  `job <the id's first 8 characters>`; every other table `<table> <the key's values joined by ", ">`, a secret
  column's value as `(hidden)`. With no row, from the key. `valueWords`: `(hidden)` when `isSecret`; `nothing` for
  null; text in double quotes, cut at 200 characters with `...`; anything else its JSON, cut the same way.

- [ ] **Step 1: Write failing tests** in `merge-rules.test.ts`:
  - `has a rule for every table`: on `openTestDb()`, every table of `public` has `ruleOf`; `TABLE_RULES` names no table
    `public` lacks; `ruleOf('nope')` throws `No merge rule for public.nope.`; every table and column `CLOSING`,
    `SOFT_REFS` and `hereOnly` name is in `factsOf`.
  - `gives every hidden table to the CEO or keeps it out`: each name in `HIDDEN` has a topic in `CEO_TOPICS` or the
    kind `skip` or `add`.
  - `reads the catalog`: `factsOf` on the test database gives `tasks` the key `['id']`, a foreign key to `turns` and
    one from `turns`; `map_returns` a key of three columns; in `order`, `departments` before `teams`, `teams` before
    `agents`, and `task_events` and `agent_events` before `map_returns`. `sameShape` of the facts with themselves is
    null; with a column dropped from a copy of the facts, or its type changed, it is the sentence.
  - `hides secrets`: `isSecret` is true for `people.password_hash`, `jobs.tool_token_hash`, `subscriptions.secret_enc`,
    `nodes.key_hash`, `nodes.account`, `machines.machine_key`, `departments.repo_token_enc`, `sessions.token_hash`,
    `person_keys.wrapped`, `person_keys.salt`, `machine_access.grant`, and false for `tasks.title`, `people.email`,
    `nodes.status`; `valueWords('machines', 'machine_key', 'x')` is `(hidden)`; `nameOf('sessions', null, {
    token_hash: 'abc' })` holds no `abc`.
  - `says rows and times in plain words`: `nameOf('tasks', { number: 57, title: 'Fix login' }, ...)` is `task #57 "Fix
    login"`; a 300-character title is cut at 200 with `...`; `rangeWords` of 14:02 and 15:30 on one UTC day is `14:02
    to 15:30 UTC`, across midnight `3 Nov 23:50 to 4 Nov 00:10 UTC`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the three files and the export.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Give every table its merge rule, and read what the catalog says of each".

### Task 3: The source, the write gate, and reading both sides

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/merge-read.test.ts test/gate.test.ts
test/sources.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing.

**Files:**
- Create: `apps/server/src/modules/merge/source.ts`, `apps/server/src/modules/merge/read.ts`,
  `apps/server/src/db/gate.ts`, `apps/server/test/merge-fixture.ts`
- Modify: `apps/server/src/db/sources.ts` (the gate in `recordSources`' wrapper), `apps/server/src/db/agent-sql.ts`
  (the gate in `run`'s `write` mode), `apps/server/test/helpers.ts` (`testApp` gains a third parameter, `opened?: {
  client: PGlite; db: Db }`, the database it runs on instead of a new one)
- Test: `apps/server/test/merge-read.test.ts` (new), `apps/server/test/gate.test.ts` (new),
  `apps/server/test/sources.test.ts`

**Interfaces:**
- Consumes: `Query`, `TableFacts` (Task 2); `openTestDb` (Task 2's export); `stripSettings` (plan 3);
  `recordSources`, `WRITE_TEXT` (plan 4); `agentSqlOn` (`test/helpers.ts`).
- Produces:
  ```ts
  // db/gate.ts
  export const GATE_WAIT_MS = 30_000;
  export class GateBusy extends Error {}                     // "The app's writes did not stop within 30 s."
  export class WriteGate {
    enter(): Promise<() => void>;
    //   at once while the gate is open, or when this async context is inside it already (a writer's own nested
    //   write, or the merge's work); else it waits until the merge is done. The answer leaves, once
    exclusive<T>(work: () => Promise<T>, waitMs?: number): Promise<T>;
    //   one at a time: closes the gate to new writers, waits until every writer inside has left, runs work in a
    //   context that is inside, then opens the gate. Writers still inside after waitMs (GATE_WAIT_MS): it opens the
    //   gate, lets the waiting ones in and throws GateBusy
    inside(): number;                                        // writers inside now
  }
  export const writeGate: WriteGate;                         // one for the process
  // db/sources.ts: recordSources' wrapper enters writeGate around every db.transaction whose accessMode is not
  //   'read only' (before its BEGIN until after its end) and every prepared query matching WRITE_TEXT outside a
  //   transaction, in a source or not; what it records is as before
  // db/agent-sql.ts: run in mode 'write' enters writeGate around its transaction
  // modules/merge/source.ts
  export type MergeSource = { label: string; query: Query; close(): Promise<void> };
  //   query runs in one REPEATABLE READ READ ONLY transaction whose snapshot its first query took; close ends it and
  //   the connection
  export const KEPT_NAME: RegExp;                            // /^hornhoof_before_[A-Za-z0-9_]{1,47}$/
  export function sourceUrl(databaseUrl: string, database: string): string;
  //   stripSettings(databaseUrl) with its path set to `/${database}`, everything else as it was
  export function keptSource(config: Config, database: string, label: string): Promise<MergeSource>;
  //   a name KEPT_NAME refuses throws before any connection; new Client({ connectionString: sourceUrl(...),
  //   application_name: 'hornhoof-merge', options: '-c default_transaction_read_only=on' }); BEGIN ISOLATION LEVEL
  //   REPEATABLE READ READ ONLY, then SELECT current_database() as the first query: another name closes it and throws
  //   Error('The merge source is not the kept database.')
  // modules/merge/read.ts
  export const HORIZON_MARGIN_MS = 86_400_000;
  export type Row = Record<string, unknown>;                 // a row's to_jsonb
  export type JournalRow = { id: string; xact: string; at: Date; tbl: string; op: 'insert' | 'update' | 'delete';
    key: Record<string, unknown>; cols: string[]; old: Row | null };
  export function keyText(key: Record<string, unknown>): string;           // JSON with the columns sorted
  export function netTables(q: Query): Promise<Set<string>>;              // the side's tables of net, by name
  export function horizonOf(q: Query): Promise<Date | null>;              // net.horizon's below
  export function journalIds(q: Query, from: Date | null): Promise<Map<string, Date>>;   // id to at, at >= from
  export function journalRows(q: Query, ids: string[]): Promise<JournalRow[]>;         // by 1000, by at, then id
  export function restoresOf(q: Query): Promise<string[]>;                // attempts, oldest first
  export function lastChange(q: Query): Promise<Date | null>;             // max(at) of net.journal
  export function rowsByKeys(q: Query, t: TableFacts, keys: Record<string, unknown>[], by?: string):
    Promise<Map<string, Row>>;
  //   by 500, keyed by keyText of the key, or of { [by]: value } when by is given
  export function rowsOf(q: Query, t: TableFacts, batch?: number): AsyncGenerator<Row[]>;   // key order, keyset paging
  export function consumedIds(q: Query, ids: string[]): Promise<Set<string>>;              // in net.merge_consumed
  export function listedSources(q: Query, sources: string[], calls: string[]):
    Promise<{ sources: Set<string>; calls: Set<string> }>;                // in applied, in tool_calls
  export function openConflicts(q: Query): Promise<Row[]>;                // net.merge_conflicts not picked
  export function backupsOf(q: Query): Promise<Row[]>;                    // net.backups
  //   each function of a net table the side lacks (netTables) answers empty or null without asking
  // test/merge-fixture.ts
  export function forkOf(client: PGlite): Promise<{ client: PGlite; db: Db }>;
  //   new PGlite({ loadDataDir: await client.dumpDataDir('none') }), then UPDATE net_local.state SET cluster =
  //   cluster || '-fork-<n>', so its transactions get other xact ids than the original's (two PGlites from one
  //   data directory count transactions alike)
  export function asPlan7(client: PGlite): Promise<void>;
  //   drops the six tables of 0054 and deletes the newest row of drizzle.__drizzle_migrations, as plan 7 kept one
  export function pgliteSource(client: PGlite, label: string): Promise<MergeSource>;
  export function twoSides(): Promise<{ leader: { client: PGlite; db: Db }; fork(): Promise<{ client: PGlite; db: Db;
    source: () => Promise<MergeSource> }> }>;
  ```
  Every query names its tables with their schema and passes values as parameters; table and column names come only
  from `Facts` and are quoted with `"`.

- [ ] **Step 1: Write failing tests.**
  - `gate.test.ts`:
    - `lets writers in together and the merge alone`: two `enter`s at once both pass; `exclusive` waits until both
      left; an `enter` while its work runs waits until the work ends; an `enter` inside the work passes at once.
    - `gives up when writers do not leave`: with a writer that stays, `exclusive(work, 100)` throws `GateBusy` without
      running work, and a writer that waited at the gate goes in.
    - `lets a writer's own nested write through`: inside an entered context, an `enter` made while `exclusive` waits
      passes at once.
    - `gates the app's writes`: on `openTestDb()`, while `exclusive`'s work waits on a promise of the test, a
      `db.transaction` that inserts a team and a `db.insert` of another outside a transaction have not run (neither row
      is there), while a `db.select` and a `db.transaction(..., { accessMode: 'read only' })` answered; once the work
      ends, both rows are there. `agentSqlOn`'s `run` in `write` mode waits the same; in `read` mode it answers.
  - `sources.test.ts`, `records as before behind the gate`: plan 4's tests pass unchanged, and a write in a source
    still inserts its step into `applied` once.
  - `merge-read.test.ts`, on `twoSides()` with a company set up on the leader by plain inserts (a company, its owner,
    a department, two tasks) before the fork:
    - `reads only`: a source opened on the fork gives the fork's rows; an `INSERT` through `source.query` fails as a
      read-only transaction. (A PGlite has one connection, so the snapshot against a concurrent write is Task 10's.)
    - `sees where the two parted`: after the fork, one title change on each side: `journalIds` of each side holds the
      rows of before the fork on both, and each side's change on its own; `journalRows` of the fork's own id gives `tbl`
      `tasks`, `op` `update`, `cols` `['title']` and `old` `{ title: <the title before> }`; the two changes' `xact`
      differ.
    - `reads keys, matches and pages`: `rowsByKeys` of the two task ids gives both rows by `keyText`; `rowsByKeys` of
      `task_events` by `uuid` keys them by uuid; `rowsOf` with `batch` 1 gives two pages of one.
    - `reads the records a merge needs`: `horizonOf` is null, then the time written into `net.horizon`; `restoresOf`
      lists two attempts oldest first; `consumedIds`, `listedSources`, `openConflicts` and `backupsOf` give back only
      what is there.
    - `reads a database plan 7 kept`: after `asPlan7` on the fork, `netTables` lacks `merges`, `horizonOf` is null and
      `restoresOf`, `consumedIds` and `openConflicts` are empty, with no query of a missing table.
    - `points at the kept database, not the live one`: `sourceUrl('postgres://u:p@db:5432/hornhoof?options=-c%20x%3Dy&
      sslmode=disable&application_name=a', 'hornhoof_before_t1')` is `postgres://u:p@db:5432/hornhoof_before_t1?
      sslmode=disable` (written on one line in the test). The real database's check is Task 10's.
    - `refuses a database that is not kept`: `keptSource(config, 'hornhoof', ...)` and `'hornhoof_restore'` throw
      before any connection (a `config.databaseUrl` of a port nothing listens on proves it).
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the files above. The gate keeps who is inside in an `AsyncLocalStorage`, so a nested write
  and the merge's own transaction pass.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Read a database that comes back in one snapshot, and let a merge hold the app's writes
  before they begin".

### Task 4: The planner

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 3 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/merge-plan.test.ts` passes; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/merge/plan.ts`
- Test: `apps/server/test/merge-plan.test.ts` (new; no database)

**Interfaces:**
- Consumes: `JournalRow`, `Row`, `keyText`, `HORIZON_MARGIN_MS` (Task 3); `TableFacts` (Task 2); `BOOKKEEPING`,
  `ENDS`, `ruleOf` (Task 2).
- Produces:
  ```ts
  // modules/merge/plan.ts
  export type Path = 'journal' | 'compare';
  export function pathOf(p: { kept: boolean; leaderRestores: string[]; sourceRestores: string[]; shared: number }): Path;
  export function cutoffOf(source: Date | null, leader: Date | null): Date | null;      // ruling 4
  export function divergence(source: Map<string, Date>, leader: Map<string, Date>, consumed: Set<string>):
    { a: string[]; b: string[]; shared: number };
  export function skippedXacts(a: JournalRow[], listed: { sources: Set<string>; calls: Set<string> }): Set<string>;
  export type KeyHistory = { a: JournalRow[]; s: JournalRow[] };   // one key's rows of A and of S, each by at, then id
  export function historiesOf(a: JournalRow[], skipped: Set<string>, leaderHorizon: Date | null):
    Map<string, Map<string, KeyHistory>>;                            // table, keyText; S as ruling 5 says
  export type Theirs = { insert: boolean; delete: boolean; cols: Set<string> };   // what B did to one key
  export function theirsOf(b: JournalRow[]): Map<string, Map<string, Theirs>>;
  export type Outcome =
    | { do: 'equal' }
    | { do: 'add' }
    | { do: 'change'; set: string[]; conflict: string[] }
    | { do: 'delete' }
    | { do: 'conflict'; kind: 'differs' | 'changed_removed' | 'removed_changed'; cols: string[]; there?: Row };
  export function journalOutcome(t: TableFacts, x: Row | null, y: Row | null, mine: KeyHistory, theirs?: Theirs):
    Outcome;
  export function compareOutcome(t: TableFacts, x: Row, y: Row | null): Outcome;
  export function same(type: string, a: unknown, b: unknown): boolean;   // ruling 6, by the column's format_type
  export function differing(t: TableFacts, x: Row, y: Row, cols?: Iterable<string>): string[];
  //   the columns (all, or those given) whose values differ by same, leaving out BOOKKEEPING and counting two non-null
  //   ENDS as equal
  ```
  `journalOutcome` is ruling 5 exactly; a `change` whose `set` and `conflict` are both empty is `equal`. A `delete` is
  checked for the leader's references by the applier, which may make it `still_used`. `compareOutcome`: no `y`, `add`;
  `differing` empty, `equal`; else `conflict` `differs` with those columns. A table's kind decides before either:
  `skip` is never planned, `add` and `log` only ever `add` or `equal`.

- [ ] **Step 1: Write failing tests** in `merge-plan.test.ts`, with facts, rows and journal rows written in the test:
  - `chooses the way`: `kept` gives `compare`; a leader restore the source lacks gives `compare`; `shared` 0 gives
    `compare`; else `journal`.
  - `finds where the two parted`: with a horizon on one side, `cutoffOf` is it less one day; `divergence` puts the
    source's ids the leader lacks into `a` but not those in `consumed`, the leader's the source lacks into `b`, and
    counts the shared.
  - `skips what the leader already did`: of three transactions in `a`, the one whose `applied` insert names a source
    `listed.sources` holds, and the one whose `tool_calls` insert names a listed call, are skipped; the third is not;
    `historiesOf` puts the skipped ones' rows, and a row older than the leader's horizon, into `s`.
  - one test per line of ruling 5: `applies a column only the source changed, from the value the leader holds`, `lists
    a column both changed`, `takes some columns and lists others of one row`, `adds a row only the source has`,
    `deletes a row only the source removed, from the row the leader holds`, `lists a row removed there and changed
    here`, `lists a row changed there and removed here`, `leaves a key only the leader touched`, `finds nothing in a row
    added and removed there`, `lists a natural key both added with other values`.
  - `lists a change whose base the leader no longer holds`: a row of `a` changing `title` from `T0` to `T2`, Y's
    `title` `T1` and no row of `B` (the leader's change of it pruned): a conflict on `title`, nothing taken.
  - `never takes what a skipped transaction wrote`: a row of `a` and a later row of `s` both naming `title`, X's and Y's
    titles differing: a conflict on `title`; the same with them equal: `equal`.
  - `never deletes through a skipped transaction`: a row of `a` changing `title`, then a delete of `s`, X null, Y the
    row: `removed_changed` with `there` the delete's `old`; with no row of `a` before the delete: `equal`; with the
    row of `a` naming no column (an update that changed nothing): `equal`.
  - `deletes nothing the leader changed since`: a delete of `a` whose `old` has `title` `T0` while Y's is `T1` and no
    row of `B`: `removed_changed`.
  - `proves nothing below the leader's horizon`: a row of `a` older than the leader's horizon changing `title`: with
    X's and Y's titles differing, a conflict, not a change.
  - `leaves the bookkeeping alone`: two `tasks` rows differing only in `updated_at` and `version`, and two `machines`
    rows only in `report_at`, `disk_free` and `addresses`, are `equal`; two `certificates` rows with other non-null
    `revoked_at` are `equal`, one null and one set `differs`.
  - `compares by type`: `same('timestamp with time zone', '2026-11-03T14:02:00.123456+00:00',
    '2026-11-03T16:02:00.123456+02:00')` is true and with `...123457+00:00` false; `same('bytea', '\x6869',
    'sha256:<the SHA-256 of "hi">')` is true; `same('jsonb', { a: 1, b: 2 }, { b: 2, a: 1 })` is true.
  - `compares after a restore`: `compareOutcome` adds a row the leader lacks, finds a row equal but for bookkeeping,
    and lists one with another `status`, the leader's kept.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `plan.ts`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Plan a merge: which way, where the two parted, and what the journal proves per column".

### Task 5: The applier and the completion check

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 4 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/merge-apply.test.ts` passes, then the whole server
suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/merge/apply.ts`, `apps/server/src/modules/merge/check.ts`
- Test: `apps/server/test/merge-apply.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 2 to 4; `writeGate`, `GateBusy` (Task 3); `withSource`, `nodeSource` (plan 4); `inRepository`
  (`modules/tasks/engine.ts`).
- Produces:
  ```ts
  // modules/merge/apply.ts
  export type Counts = { added: number; changed: number; deleted: number; equal: number; skipped: number;
    conflicts: number; carried: number; matched: number; rewritten: number;
    byTable: Record<string, { added: number; changed: number; deleted: number; conflicts: number }> };
  export type CodeLine = { task: string; number: number; branch: string; machines: { name: string; at: string }[] };
  export type MergeResult = { path: Path; counts: Counts; tasks: string[]; code: CodeLine[]; from: Date | null;
    to: Date | null; heldMs: number };                       // heldMs: from exclusive's start to its end
  export class MergeRefused extends Error {}                 // two shapes, another company, applied already
  export function runMerge(db: Db, merge: { id: string; label: string; kept: boolean; companyId: string },
    source: MergeSource, opts?: { onUnit?: (n: number) => void | Promise<void>; gateWaitMs?: number }):
    Promise<MergeResult>;
  // modules/merge/check.ts
  export function complete(db: Db, mergeId: string, source: MergeSource):
    Promise<{ ok: boolean; missing: { table: string; key: Record<string, unknown> }[] }>;   // at most 20 named
  ```
- `runMerge`, in `writeGate.exclusive` (`gateWaitMs`, else `GATE_WAIT_MS`) and one `db.transaction(..., {
  isolationLevel: 'repeatable read' })`, as ruling 8 says; `opts.onUnit(n)` is awaited before the n-th unit's write
  (a throw there is a fault, for tests):
  1. The settings and locks; the merge's row must be `pending` (else `MergeRefused` 'The merge was applied
     already.'); `factsOf` of both sides and `sameShape` (else `MergeRefused`); the source's `companies` row is
     `merge.companyId` (else `MergeRefused` 'This database is of another company.').
  2. The way (`pathOf`: `kept` from the merge, the restores and `shared` from both sides) and, by the journal, the
     cutoff, `a` and `b`, their rows, the skipped transactions, `historiesOf` with the leader's horizon, and
     `theirsOf`.
  3. Per table in `facts.order` but `skip` (and `sessions` after a restore): by the journal, the keys of `A` and `S`
     (a `task_events` key read as its row's uuid on the source), both rows read; else every row of the source by
     `rowsOf` and the leader's by `rowsByKeys` (a log by its `match`). `map_returns.source_key` is read in uuid form on
     both sides first. Each outcome is a unit.
  4. Units, with ruling 7's rules on a row it writes, in this order: the number, the open turn, the head, `CLOSING`,
     `hereOnly`, the sequence, the `source_key` as the leader's number; an added row by `INSERT INTO public.<t> SELECT *
     FROM jsonb_populate_record(NULL::public.<t>, $1)`, a `change` by one `UPDATE ... SET (<cols>) = (SELECT <cols>
     FROM jsonb_populate_record(NULL::public.<t>, $1))` by key, with `updated_at` and `version` as ruling 6 says. A
     `delete` first looks for the leader's rows that point at it (`referencedBy` and `SOFT_REFS`). A `23505` on
     `person_access_place` is the match of ruling 7. Then the reference pass and the replays of ruling 8.
  5. `net.backups` rows the leader lacks; the source's open conflicts, carried as ruling 7 says.
  6. The records (ruling 9): conflicts with `op`, `here` the leader's row as read, `there` the source's (or the
     outcome's `there`), `at` the source's latest change of the key, `task_id` by the rule's `task` (`tasks` its own
     id), `topic` the table's, `why` in plain words (`nameOf`, the columns and `valueWords` of both); consumed ids;
     `net.merge_rows`; on `net.merges` `path`, `cutoff`, `counts`, `tasks`, `code`, `from_at` and `to_at` (by the
     journal the first and last `at` of `a` not skipped; after a restore the restore's `dumped_at` from `net.restores`
     whose `kept` is the source's name, and `lastChange` of the source), `xact` (`md5(<cluster> || ':' ||
     pg_current_xact_id()::text)::uuid`, `<cluster>` from `net_local.state`, as plan 3's trigger), `status` `applied`,
     `applied_at` now, `task_wanted` true (Task 8 makes the task) and `error` null.
  `code`: for each of `tasks` whose row `inRepository` says yes, its number on the source, `task-<that number>`, and
  per machine its source's jobs on the task ran on (by `jobs.node_id`, the node's machine's `hostname`, or "the
  server" with no node) the latest `finished_at` or `started_at`. Once `exclusive` has ended, one log line `The merge
  <merge id> held the app's writes <heldMs> ms.`, with no value of a row. After the commit, `ctx.bus` is not touched
  here; the merger publishes (Task 6).
- `complete` is ruling 9's check for the merge's row (its `path`, `cutoff`, `applied_at`), read in a new snapshot of
  the source and outside any transaction on the leader.

- [ ] **Step 1: Write failing tests** in `merge-apply.test.ts`, each on `twoSides()` with a company set up on the
  leader (`setUpCompany` through a `testApp` on the leader's database, a department, an orchestrator and two
  employees), forked, then changed on each side through each side's `db` as the test says, then `runMerge` on a
  `pending` `net.merges` row the test makes, with `kept` false unless the test says so, and `complete` after it:
  - `adds what the leader lacks`: a department, a task in it, two of its `task_events`, an `agent_events` row and an
    `agent_changes` row added on the fork are on the leader with their ids, the events with new `id` and `seq`;
    `counts.added` 6; `complete` ok.
  - `applies a proven overwrite`: a task's `title` changed on the fork only: the leader has it, its `version` the
    larger plus 1; no conflict; the consumed row of that change is `applied`.
  - `keeps the leader's value on an unproven difference`: the title changed on both sides: the leader's stays, one
    conflict `differs` with `cols` `['title']`, `op` `update`, `here` and `there` the two rows, `topic` `work`,
    `task_id` the task.
  - `keeps a value the leader changed where its journal lost it`: on the leader a title changed and that one journal
    row deleted by the admin (as a prune that took it alone), on the fork the same task's title changed: a conflict
    `differs`, the leader's title stays.
  - `deletes only what the source alone removed`: a team removed on the fork (no row points at it) is gone; a
    department removed on the fork that the leader's notebook note points at stays, with a conflict `still_used`, and
    the note stays.
  - `never deletes through a skipped transaction`: on the fork a task's title changed, then the task deleted inside
    `withSource(nodeSource('n1', 'jobs', 7))`, and that source also written on the leader: the task stays on the
    leader with a conflict `removed_changed` whose `there` holds the fork's title.
  - `skips what the leader already did from the same source`: one change written on each side inside
    `withSource(nodeSource('n1', 'jobs', 7))` (an agent event added, other uuids) is on the leader once, the fork's
    consumed as `skipped` and its event in `net.merge_rows` as `skipped`; `counts.skipped` its row count; `complete`
    ok.
  - `closes the second open turn`: each side opens its own new turn whose `task_id` is a new task of that turn (the
    cycle of `turns` and `tasks`): the fork's turn and task are both on the leader, the turn `closed` with
    `closed_at`, the task in the leader's open turn; `turns_one_open` holds, the commit's foreign keys pass, and both
    rows are `rewritten` in `net.merge_rows`.
  - `renumbers a split number`: each side makes task 3: the fork's is 4 on the leader, and `net.merge_rows` has it
    `rewritten` with `cols` `['number']` and `was` `{ number: 3 }`.
  - `keeps two forks' task_events apart by uuid`: by each way, each side adds an event that gets the same `id` with
    another `uuid`: both are on the leader, the fork's with a new `id` (by the journal the fork's key is read as its
    uuid, not its number); a `map_returns` row the fork adds with `source_key` `task:<its id>` points at the new `id`,
    one the fork changes to `message:<its seq>` gets the leader's `seq` of that event, and one naming an event the
    leader lacks is `refused`.
  - `makes a second head an ordinary agent`: each side hires a head for one department: the fork's is a `worker`.
  - `refuses a row whose parent is gone, and what hangs on it`: the leader removes department P; the fork adds
    department D under P, a notebook note in D (`ON DELETE CASCADE`) and a task in D with two events: all are
    `refused` ("Its departments row is not here." first), none of them is on the leader, every note the leader had is
    there, and the merge commits; `complete` ok.
  - `refuses a task whose after names a refused task`: the fork adds task A in a department the leader removed and
    task B in another with `after` `[A]`: both are `refused`.
  - `replays instead of putting values back`: before the fork, node N on machine M1 for plan P and machine M2; the
    leader deletes M2; the fork moves N to M2 and adds node N2 on M1 for P: N's change and N2 are both `refused` (N2 by
    `nodes_machine_plan` in the replay), N stays on M1, and the merge commits.
  - `sends one email on both sides to the CEO`: each side invites another person with one email: one conflict
    `refused` naming `people_email_unique`, `topic` `people`, the merge commits and the fork's other changes apply.
  - `sends a broken task check to the orchestrator`: the fork moves a task to `review` while the leader removed its
    executor: the row is `refused` naming `tasks_review_has_executor`, `op` `update`, `topic` `work`.
  - `stops what the source left running`: added on the fork, a job `running` and one `queued` are `failed` with "Ran
    on <label> while it was cut off." and `finished_at`; a `computer_runs` row `waiting` is `lost`; a test run
    `running` is `stopped` and its parts `queued` and `running` are `stopped` with `finished_at` and the job's error;
    each `rewritten`; `complete` ok.
  - `brings back a new machine with its access closed`: with `kept` true, a machine added on the fork with a
    `machine_access` row whose `until` is in an hour, with `opened_by`, `opened_at` and `grant`: on the leader the
    machine and its access row with those four null; by the journal, the fork opening an existing machine's access: a
    conflict `differs`, the leader's row closed.
  - `finds a row the carry wrote anew`: a `person_access` row the leader deleted and wrote again with a new id for the
    same person and department is no conflict and is `matched` in `net.merge_rows` with the leader's id; `complete`
    ok.
  - `never reads a stale absence as a deletion or a stale value as a change`: with `kept` true, a task the fork
    removed stays on the leader; a title only the fork changed is a conflict `differs` with the leader's kept, not an
    overwrite; a task the leader removed after the fork is added back (spec "Known limits").
  - `compares a kept database even when its journal adds nothing`: a fork whose only difference, a task's title, was
    written with `net_journal` dropped on `tasks` for that write: with `kept` true the title is listed; with `kept`
    false the journals share every id and prove nothing new, so nothing is listed, and `complete` is not ok (the row
    differs and nothing explains it).
  - `never adds sessions after a restore`: with `kept` true, a session only the fork has is not added, and `complete`
    is ok; by the journal it is added.
  - `merges a database plan 7 kept`: after `asPlan7` on the fork, with `kept` true, a department added on it comes
    back and `complete` is ok.
  - `carries a conflict left open`: the fork holds a `net.merges` row and an open `refused` conflict of a task the
    leader lacks, written by the test: after the merge the leader has a conflict of this merge with `carried` that
    conflict's id and its `there`; `complete` ok; a merge of a second fork that holds the same conflict carries none.
  - `three sides`: two forks, each with its own change, merged one after the other: both apply, each consumed set
    under its own merge, and the second does not list the first's rows.
  - `never applies twice`: `runMerge` again on the merge it applied throws `MergeRefused` 'The merge was applied
    already.' and changes nothing; `complete` is ok after a merge with a renumbered task, a closed turn and a failed
    job.
  - `finishes the completion check`: after a merge with applied, skipped and conflicted ids `complete` is ok; with one
    `net.merge_consumed` row deleted by hand, or the `skipped` row of `net.merge_rows`, `ok` is false and `missing`
    names its table and key; with a task the merge added then changed and then deleted on the leader by the app, `ok`
    again (the company's own later change).
  - `changes nothing when it fails half way`: with the fork's table `teams` given a column the leader lacks,
    `MergeRefused` "The two databases are of different versions."; with `onUnit` throwing at the tenth unit, the
    leader's rows, journal and `net` tables are as before and the merge's row is `pending`.
  - `holds the app's writes while it runs`: with `onUnit` waiting on a promise of the test at the first unit, a title
    change of another task through the leader's `db` started then is not on the database while the merge waits, and is
    after it; the merge lists nothing of it; `heldMs` is at least the time it waited, and one log line says it,
    holding no value of a row.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `apply.ts` and `check.ts`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Apply a merge in one transaction, list what it cannot prove, and check that nothing was
  left".

### Task 6: Kept databases, the merger, the restore's mark and the prune

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/merge-kept.test.ts test/restore.test.ts
test/updates.test.ts test/lease-store.test.ts test/backups-routes.test.ts test/bundle.test.ts test/updater.test.ts`
passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing; `bash -n` and
`shellcheck` on `apps/updater/updater.sh` print nothing. `test/real/lease-store.test.ts` runs in Task 10's `npm run
test:real`.

**Files:**
- Create: `apps/server/src/modules/merge/kept.ts`, `apps/server/src/modules/merge/merger.ts`
- Modify: `apps/server/src/modules/backups/restore.ts` (`start`, `afterSwap`),
  `apps/server/src/modules/backups/routes.ts` (the restore's body, `kept`, `MakerView.fork`, the record of a fork,
  "Leave it out"), `apps/server/src/modules/backups/types.ts` (`RestoreStatus.dumpedAt`, `MakerView.fork`),
  `apps/server/src/modules/backups/bundle.ts` (the reason `fork`), `apps/server/src/modules/updates/routes.ts`,
  `apps/server/src/modules/keeper/lease-store.ts`, `apps/server/src/app.ts` (the merger), `apps/server/src/errors.ts`,
  `apps/updater/updater.sh` (`dumpedAt` in the restore's status)
- Test: `apps/server/test/merge-kept.test.ts` (new), `apps/server/test/restore.test.ts`,
  `apps/server/test/updates.test.ts`, `apps/server/test/lease-store.test.ts`, `apps/server/test/backups-routes.test.ts`,
  `apps/server/test/bundle.test.ts`, `apps/server/test/updater.test.ts`, `apps/server/test/real/lease-store.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 5; plan 7's `Restores`, `readRestoreStatus`, `MakerView`, `RestoreStatus`, `UpdaterControl`,
  `BundleReason`.
- Produces:
  ```ts
  // modules/backups/bundle.ts: BundleReason is 'timer' | 'update' | 'fork', and checkHead takes all three
  // modules/backups/types.ts: RestoreStatus gains dumpedAt?: string (the restored bundle's, from restore.json);
  //   MakerView gains fork: { id: string; database: string } | null
  // modules/merge/kept.ts
  export const CHOICE_FILE = 'restore-choice.json';          // { attempt, bringBack }, 0600, in the control folder
  export type KeptDatabases = {
    list(): Promise<string[]>;                               // pg_database names KEPT_NAME matches
    open(name: string, label: string): Promise<MergeSource>; // connections on, then keptSource
    drop(name: string): Promise<void>;                       // DROP DATABASE IF EXISTS by format('%I'), KEPT_NAME only
  };
  export function keptDatabases(db: Db, config: Config): KeptDatabases;
  // modules/merge/merger.ts
  export const MERGE_EVERY_MS = 60_000;
  export const RETRY_MAX_MS = 3_600_000;
  export class Merger {
    constructor(ctx: Ctx, kept: KeptDatabases, opts?: { everyMs?: number; now?: () => Date });
    start(): void;                                            // ticks every everyMs while the app leads
    stop(): void;
    discover(): Promise<void>;
    tick(): Promise<void>;
    pending(): Promise<boolean>;                              // a merge is pending or applied
  }
  // errors.ts: ErrorReason gains 'merge_pending' | 'not_pending'
  ```
- `discover`, at the app's first lead right after `afterSwap` has run, and at each tick: for each name of `list()`
  without a `net.merges` row `kept:<name>`: the label "the database from before the restore of <timeWords of the
  restore's dumped_at>" from `net.restores` whose `kept` is the name, else "the database kept as <name>"; opened
  once: no `companies` row, the status `removing` and no `fork`; else `fork` a new uuid and the status `pending`, or
  `removing` when `CHOICE_FILE` names that restore's attempt with `bringBack` false. The file is removed only after
  the row that holds its choice has committed; a file of another attempt stays as it is.
- `tick`, one step at a time and none while one runs or the app does not lead:
  - The oldest `pending` or `applied` merge never tried, or whose `tried_at` is older than `MERGE_EVERY_MS` times 2 to
    the power of `tries - 1`, at most `RETRY_MAX_MS`: `tried_at` now, `tries` plus 1; when `pending`, `runMerge` on a
    source it then closes, and `ctx.bus` publishes `{ type: 'org' }` once; then, in both, `complete` on a new source;
    ok: `merged` and `merged_at`; not ok: `error` "Not complete yet: <table> <key>, ..." and it stays `applied`. A
    throw: `error` its message (a `MergeRefused` or `GateBusy` one as is, any other "The merge stopped: <message>"), one
    log line without values.
  - A `merged` or `removing` merge whose `fork` is null or names a `net.backups` row, and whose source is `kept:`:
    `drop`, then `done` and `done_at`; a failed drop is one line, tried at the next tick.
- `GET /api/network/backups` (own) carries `fork`: the oldest merge `pending`, `applied`, `merged` or `removing` with
  a `fork` that `net.backups` lacks, its database the source's name. `POST /api/network/backups` takes the reason
  `fork` only for the id a merge's `fork` names (else 400 `bundle_refused`).
- `POST /api/backups/:id/restore` takes `bringBack?: boolean` (true when absent); `Restores.start` writes `CHOICE_FILE`
  under umask 077 before the order is kept. `afterSwap`, when the status names an attempt at `start` or `done` and has
  `dumpedAt`: `INSERT INTO net.restores (attempt, backup, dumped_at, kept) ... ON CONFLICT (attempt) DO NOTHING`, with
  or without a carry; then `merger.discover()`.
- `updater.sh`: every write of `restore-status.json` carries `dumpedAt` as `restore.json` has it.
- `GET /api/backups`' `kept` items gain `merge: { id: string; status: 'pending' | 'applied' | 'merged' | 'removing' |
  'done'; added: number; conflicts: number; error: string | null } | null`. `POST /api/backups/kept/:name/leave` (the
  CEO, as the other backup routes): its merge `pending` or `applied` becomes `removing`, else 409 `not_pending`.
- `POST /api/updates`: 409 `merge_pending` "A database from before a restore is still being brought back. Wait for it,
  or leave it out in Settings." while `merger.pending()`, checked before the claim.
- `LeaseStore.prune` (ruling 14): its delete runs only when `net_local.lease.sync` is `alone`, `until >
  clock_timestamp()` and no `net.merges` row is `pending` or `applied`; in the same transaction, when it deleted a
  row, `INSERT INTO net.horizon (below) VALUES (now() - interval '7 days') ON CONFLICT (id) DO UPDATE SET below =
  EXCLUDED.below` and `DELETE FROM net.merge_consumed WHERE at < <below>`. `applied` and `tool_calls` are pruned under
  the same conditions.

- [ ] **Step 1: Write failing tests.**
  - `merge-kept.test.ts`, on a `testApp` that leads, a control folder in a temp folder and a fake `KeptDatabases`
    whose databases are `forkOf` the app's (its `drop` recording the name):
    - `brings back the database from before a restore`: a `net.restores` row naming `hornhoof_before_t1`, a fork by
      that name with a department added: `discover` makes a `pending` row with a `fork` and the label naming the
      restore's time; `tick` merges it by `compare` and makes it `merged`; the department is on the app's database.
    - `leaves it out when the CEO chose so`: `CHOICE_FILE` `{ attempt, bringBack: false }`: the row is `removing`, no
      merge runs, the file is gone.
    - `keeps the choice until it is written`: the same file with `open` failing once: the file stays and no row is
      made; the next `discover` makes the row `removing` and then removes the file. A file of another attempt stays.
    - `names a database kept before this release`: with no `net.restores` row, the label is "the database kept as
      hornhoof_before_t9".
    - `removes an empty database without a backup`: a fork with no `companies` row: `removing`, `fork` null, and the
      next tick drops it and makes it `done`.
    - `drops only what is merged and saved`: a `merged` row with a `fork` is not dropped until a `net.backups` row
      with that id exists, then dropped once; a `pending` or `applied` one never; `list` naming `hornhoof` changes
      nothing.
    - `goes on with the check after a stop`: a merge `applied` by `runMerge` with no check after: the tick runs no
      `runMerge` (a spy) and makes it `merged` by `complete`.
    - `tries a failed merge again, less often`: a source whose `companies` row is another company's: `error` "This
      database is of another company.", `tries` 1; the next tick within `MERGE_EVERY_MS` runs nothing, one after it
      runs again; tries grow the wait up to `RETRY_MAX_MS`.
    - `merges one at a time, only while leading`: two `pending` rows give two ticks, one merge each; with the app in
      `read`, no tick runs.
    - `asks the keeper for the fork`: the own `GET /api/network/backups` carries `fork` with the row's `fork` and name
      until a recorded bundle names it; a record of reason `fork` for any other id is 400.
  - `restore.test.ts`: `remembers the CEO's choice across the swap`: `POST /api/backups/:id/restore` with `bringBack`
    false writes `CHOICE_FILE` (0600) naming the attempt; `marks every restore`: `afterSwap` with a status at `start`
    and a `dumpedAt` writes one `net.restores` row with that time, and again none; with no carry file too; a status
    with no `dumpedAt` writes none.
  - `updater.test.ts`, `keeps the dump's time in the restore's status`: after a restore with the stubs, every
    `restore-status.json` written has `dumpedAt` equal to `restore.json`'s.
  - `bundle.test.ts`, `takes the reason fork`: a manifest with `fork` checks; one with `other` is refused.
  - `updates.test.ts`: `waits for a merge`: with a `pending` merge, and with an `applied` one, `POST /api/updates` is
    409 `merge_pending` and nothing is claimed; with it `merged`, it goes on.
  - `lease-store.test.ts`: `prunes nothing while a merge waits` (a `pending` row, then an `applied` one: `prune()`
    answers 0); `prunes nothing on a lapsed lease` (`until` a minute ago: 0); `records the horizon`: after a prune that
    deleted rows `net.horizon` is 7 days ago within a second, and a `net.merge_consumed` row 8 days old is gone, one of
    now stays.
  - `real/lease-store.test.ts`: plan 3's `prunes as the keeper after the lease ended` becomes `prunes as the keeper only
    while the lease holds`: old `net.journal` rows written by the admin; with the lease live, `prune()` on
    `keeperSql(url)` deletes them (the keeper's session passes the fence trigger); written again and `fence()`, it
    deletes none.
  - `backups-routes.test.ts`: `shows each kept database's merge`: `GET /api/backups`' `kept` carries the merge's status
    and counts; `POST /api/backups/kept/<name>/leave` makes a `pending` one, and an `applied` one, `removing`, and is
    409 `not_pending` after.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above. `keptDatabases.open` runs `ALTER DATABASE <name> WITH ALLOW_CONNECTIONS
  true` through `format('%I')` on the app's pool before connecting; the real one is tested in Task 10.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Bring back the database a restore set aside, then save it and drop it, and prune the
  journal only when no merge needs it".

### Task 7: Fork bundles

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 6 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/updater.test.ts test/keeper-backups.test.ts
test/holders.test.ts test/backups-routes.test.ts test/restore.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing; `bash -n` and `shellcheck` on `apps/updater/updater.sh` print
nothing.

**Files:**
- Modify: `apps/updater/updater.sh` (`dump_request`), `apps/server/src/modules/keeper/backups.ts` (fork dumps, the
  record sent again, their days, the report), `apps/server/src/modules/keeper/keeper.ts` and
  `apps/server/src/modules/keeper/worker.ts` (the report's `heldBackups`), `apps/server/src/modules/backups/types.ts`
  (`FORK_KEEP_MS`, `REPORT_MAX`), `apps/server/src/modules/backups/holders.ts`,
  `apps/server/src/modules/backups/routes.ts` (the holders' bundles, the report's limit, the list)
- Test: `apps/server/test/updater.test.ts`, `apps/server/test/keeper-backups.test.ts`,
  `apps/server/test/holders.test.ts`, `apps/server/test/backups-routes.test.ts`, `apps/server/test/restore.test.ts`

**Interfaces:**
- Consumes: `MakerView.fork`, `BundleReason` (Task 6); plan 7's `BundleStore`, `StoredBundle.head`, `pickHolders`,
  `refreshHolders`, `KEEP_OWN`.
- Produces:
  ```ts
  // modules/backups/types.ts
  export const FORK_KEEP_MS = 30 * 86_400_000;
  export const REPORT_MAX = 32;                              // heldBackups: the newest 16, then every fork held
  // modules/backups/holders.ts
  export function namedBundles(db: Db, now?: Date): Promise<BackupRow[]>;
  //   the newest 2 rows with a recovery key whose reason is not fork, and every fork row with a recovery key whose
  //   madeAt is within FORK_KEEP_MS of now; refreshHolders, MakerView.holders and HolderView.hold all take these
  ```
- `dump.json` may be `{ id, database, reason: 'fork' }`. `dump_request` with a `database`: only a name matching
  `^hornhoof_before_[A-Za-z0-9_]{1,47}$` (else `.failed` "Not a kept database." and `dump.json` removed); `ALTER
  DATABASE "<name>" WITH ALLOW_CONNECTIONS true` from `postgres`; `pg_dump` of that database as of `hornhoof`; the
  `.json` with `reason` `fork` and `migrations` read from that database. A `reason` without a `database`, or another
  reason with one, is `.failed` the same way.
- The keeper: when the view's `fork` names an id its store and `dumps/` lack and no dump is in flight, it writes that
  `dump.json` before a timer dump that is due, outside the 10-minute spacing. It seals with the `.json`'s reason. When
  the view's `fork` names an id its store holds, it posts that bundle's stored head again each round until the answer
  is 200 or 201. It keeps every fork bundle until `madeAt` plus `FORK_KEEP_MS`, outside its latest `KEEP_OWN`, which
  count only `timer` and `update`. Its report's `heldBackups` is the newest 16 it holds and every fork it holds
  besides, at most `REPORT_MAX`; the worker's report the same.
- Holders: a fork bundle with a recovery key gets holders by `pickHolders` as any bundle does; `namedBundles` keeps
  it named for them until its 30 days end, and a holder's removal of older bundles leaves alone what is named.
- Routes: the report takes at most `REPORT_MAX` ids (400 above); `GET /api/backups` lists the newest 10 rows and every
  fork row within `FORK_KEEP_MS` besides.

- [ ] **Step 1: Write failing tests.**
  - `updater.test.ts`, `dumps a kept database for its fork bundle`: with the stubs, `dump.json` `{ id, database:
    'hornhoof_before_20261103T210000Z', reason: 'fork' }`: the stub's `docker` log has the `ALTER DATABASE` and a
    `pg_dump` of that database, `dumps/<id>.json` has `reason` `fork`, both 0600; `database` `hornhoof` or
    `x;rm -rf /` gives `.failed` "Not a kept database." and runs no `pg_dump`.
  - `keeper-backups.test.ts`:
    - `makes the fork bundle first`: a view with `fork` and a timer dump due: the first `dump.json` is the fork's; the
      sealed bundle's manifest `reason` is `fork` and its record carries it.
    - `records a fork again until it is recorded`: the record answered 503, then 201: the next round posts the stored
      head again without a new dump, and the round after posts nothing.
    - `keeps fork bundles 30 days`: with three timer bundles and one fork, the oldest timer goes and the fork stays; at
      `madeAt` plus `FORK_KEEP_MS` it goes.
    - `reports every fork it holds`: with 16 newer bundles held and a fork, `heldBackups` names 17, the fork among
      them.
  - `holders.test.ts`, `keeps a fork named for its holders 30 days`: a fork row with a recovery key gets holders as any
    bundle; with two newer timer rows, `namedBundles` holds the fork and both; 30 days after its `madeAt`, only the
    two.
  - `backups-routes.test.ts`: `lists forks beyond the newest ten`: with 12 timer rows newer than a fork, the list has
    the newest 10 and the fork; `takes a longer report`: 32 ids are taken, 33 are 400.
  - `restore.test.ts`, `restores a fork after newer bundles`: a fork row and 17 newer timer rows, the server's report
    naming the fork among 32: `Restores.start` of the fork passes its checks (held, hash, migrations, signer) and
    writes the order.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Save a database before it goes as an encrypted fork bundle, kept 30 days with its holders".

### Task 8: The merge task, the picks and the orchestrator's tools

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 7 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/merge-task.test.ts test/merge-tools.test.ts` passes,
then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/merge/task.ts`, `apps/server/src/modules/merge/picks.ts`,
  `apps/server/src/modules/merge/tools.ts`
- Modify: `apps/server/src/modules/tools/mcp.ts` (after the early return), `apps/server/src/modules/merge/merger.ts`
- Test: `apps/server/test/merge-task.test.ts` (new), `apps/server/test/merge-tools.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 2, 5 and 6 (`CodeLine`, the unit writer of `apply.ts`); `createTask`, `updateTask`, `wakeAll`;
  `HIDDEN`.
- Produces:
  ```ts
  // modules/merge/task.ts
  export function titleOf(merges: { label: string; path: Path; from: Date | null; to: Date | null }[]): string;
  //   one: ruling 10's two titles; several: `Bring back what ${labels} did while apart`, labels joined by ", " and
  //   " and "
  export function bodyOf(db: Db, mergeIds: string[]): Promise<string>;
  export function taskFor(ctx: Ctx, mergeId: string): Promise<string | null>;
  // modules/merge/picks.ts
  export type Take = 'here' | 'there' | 'value';
  export type Picker = { kind: 'ceo'; personId: string } | { kind: 'orchestrator'; agentId: string };
  export type PickFilter = { ids?: string[]; merge?: string; table?: string; from?: Date; to?: Date };
  export type ConflictView = { id: string; merge: string; label: string; table: string; what: string;
    kind: string; cols: string[]; here: Record<string, string> | null; there: Record<string, string> | null;
    at: string | null; task: { id: string; number: number; title: string } | null; whose: 'orchestrator' | 'ceo';
    picked: Take | null };
  export function conflictsOf(db: Db, who: Picker, f: PickFilter & { settled?: boolean; after?: string;
    limit?: number }): Promise<{ conflicts: ConflictView[]; more: boolean }>;
  export function pick(ctx: Ctx, who: Picker, f: PickFilter, take: Take, value?: Record<string, unknown>):
    Promise<{ settled: number; here: number; there: number; refused: { id: string; why: string }[];
      tasks: { id: string; number: number }[] }>;
  // modules/merge/tools.ts
  export function registerMergeTools(server: McpServer, ctx: Ctx, job: ToolJob): void;
  ```
- The merger's tick gains a step: a merge with `task_wanted` and no `task_id`, `taskFor`; a task id is kept as
  `task_id`; null sets `task_wanted` false; a throw (no orchestrator that can take a task) is one line, tried at the
  next tick. The drop does not wait for it.
- `taskFor` and `bodyOf` read only the leader: `net.merges` (`tasks`, `code`, `from_at`, `to_at`, `counts`),
  `net.merge_rows` (`rewritten` rows whose `cols` hold `number`, for the renumbering) and `net.merge_conflicts`; never
  a source. `taskFor` is null when the merge has no conflict of the orchestrator's, no renumbering and no `code`; else
  ruling 10. `bodyOf` is plain text in this order: what came back and from when ("What <label> did from <from> to <to>
  UTC is brought back as far as its records prove."); the counts; "To settle: <n> for you; <m> for the CEO (people,
  access, plans or machines), which wait on his screen."; the renumbering; "Code:" and a line per `code` entry ("Task
  #<number here> was worked on as <branch> on <machine> until <time>; ..."); the orchestrator's conflicts, by task and
  then by table, each "<what>: <column>: here <value>, there <value>"; the instructions of ruling 10. Values by
  `valueWords`. A conflict whose table is `ceosConflict` or in `HIDDEN` adds only to `<m>`, nothing else of it.
- `conflictsOf`: the orchestrator sees only conflicts whose table is not `ceosConflict` and not in `HIDDEN`; the CEO
  sees all. `here` and `there` hold the conflict's columns (a whole row's non-key columns for a row conflict) by
  `valueWords`; `what` is `nameOf`. Order: `at`, then `id`; `limit` 1 to 100, 50 by default; `after` an id.
- `pick`, ruling 11: a filter with no field at all is refused ("Name the conflicts: ids, a merge, a table or a time
  range."); at most 500 settled a call; for the orchestrator, a CEO's conflict, or a group with one, is refused "This
  one is the CEO's (<topic>); it waits on his screen."; `there` or `value` on a `hereOnly` column is refused "Only the
  machine's owner opens computer access, on its card."; `value` needs one id of kind `differs` and only its columns; a
  settled one is refused "Already settled.". `there` runs the conflict's `op` with `there`'s values as Task 5's units
  do (savepoint, ruling 7's rules on a row it writes, the references before a delete, the references of the row after
  it); a `refused` one takes its group as ruling 11 says, in one transaction. Each settled conflict gets `picked`,
  `value`, `picked_by` and `picked_at`.
- Tools, registered after `toolsFor`'s early return:
  - `merge_conflicts`: `{ merge?: uuid, table?: string, from?: datetime, to?: datetime, settled?: boolean, after?:
    uuid, limit?: 1..100 }`, description "What a merge could not prove: each conflict with both values, the task it
    belongs to and whose it is. Open ones by default.", answers the JSON of `conflictsOf`.
  - `merge_pick`: `{ ids?: uuid[], merge?: uuid, table?: string, from?: datetime, to?: datetime, take: 'here' |
    'there' | 'value', value?: object }`, description "Settles conflicts: here keeps this company's value, there takes
    the other side's, value writes yours for one conflict. In bulk by merge, table or time range.", answers "Settled
    <n>: kept here <h>, took there <t>." then, when any, "Refused <r>: <id>: <why>; ..." and "Tasks changed: #<n>,
    ... Tell their holders."

- [ ] **Step 1: Write failing tests.**
  - `merge-task.test.ts`, on Task 5's fixture with a `testApp` that leads:
    - `gives the orchestrator one task`: a merge with two conflicts, a renumbered task in a repository and an added
      job on it, its source closed and dropped before `taskFor` runs: one task assigned to the orchestrator, titled
      "Bring back what <label> did while apart (<range> UTC)", whose body holds both conflicts with both values, "Task
      #4 here was #3 on <label>", the branch `task-3` with the job's machine and time, and no secret value; the task's
      id is on the merge.
    - `tells the orchestrator only how many are the CEO's`: with a `people` conflict on an invite's email and a
      `plan_credentials` conflict besides one of his: the body says "2 for the CEO" and holds neither the email, nor
      `people`, `invites` or `plan_credentials`.
    - `joins a second merge into the open task`: a second merge with a conflict: no new task; the title names both
      labels, the body both merges, and the orchestrator has a wake `assigned` on it.
    - `makes no task for nothing`: a merge that only added rows answers null.
    - `waits for an orchestrator`: with the orchestrator switched off, `taskFor` throws and the merger keeps
      `task_id` null and tries again at its next tick.
  - `merge-tools.test.ts`, through `mcp(app, <orchestrator's job token>)`:
    - `lists conflicts with both values`: `merge_conflicts` answers the open ones of the orchestrator's with `what`,
      both values and the task; `settled: true` lists the settled ones.
    - `keeps the CEO's conflicts and secrets from the orchestrator`: a `people` conflict and a conflict on `sessions`
      are not listed to him; a `jobs` conflict on `tool_token_hash` shows `(hidden)`; `merge_pick` on the `people`
      one by id is refused "This one is the CEO's (people); it waits on his screen."
    - `settles one or many`: `take: 'there'` on one id writes the source's title; `take: 'here'` with `table: 'tasks'`
      settles every open task conflict and changes no row; `merge` settles only that source's (two merges open);
      `from`/`to` settle only those in the range; `value` with `{ title: 'Both' }` writes it; a pick with no filter is
      refused; each settled row has `picked_by` `agent:<id>`.
    - `runs what the merge tried`: `there` on a `refused` update (`tasks_review_has_executor`) once the executor is
      back moves the task to `review`; `there` on a `refused` turn and its task (a cycle, refused for a department the
      leader removed) after that department's `changed_removed` conflict was settled `there` brings both back in one
      transaction and settles both.
    - `refuses a pick the leader cannot take`: `there` on a `changed_removed` task whose department is gone stays
      open with "Its departments row is not here."
    - `never opens computer access`: `there` on a `machine_access` conflict is refused "Only the machine's owner opens
      computer access, on its card." and its row stays closed.
    - `is the orchestrator's alone`: an employee's job token gets no `merge_conflicts` or `merge_pick`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the three files and the merger's call of `taskFor`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Give the orchestrator one task for each merge's conflicts, and the tools to settle them".

### Task 9: The CEO's conflicts, the restore's choice and the screens

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 8 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/merge-routes.test.ts test/decisions.test.ts` passes;
from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/MergeCard.test.tsx test/Backups.test.tsx
test/Tasks.test.tsx test/i18n.test.tsx` passes; then the whole suite from the root; both `tsc` commands print nothing.

**Files:**
- Create: `apps/server/src/modules/merge/routes.ts`, `apps/web/src/screens/MergeCard.tsx`
- Modify: `apps/server/src/modules/tasks/decisions.ts`, `apps/server/src/modules/tasks/routes.ts` (`GET
  /api/requests`), `apps/server/src/app.ts` (the routes), `apps/web/src/screens/Tasks.tsx`,
  `apps/web/src/screens/Backups.tsx`, `apps/web/src/api.ts`, `apps/web/src/types.ts`, `apps/web/src/i18n/en.ts`,
  `apps/web/src/i18n/ru.ts`, `apps/web/test/api-mock.ts` (its `decisions()` answers `merges: []`), `guide/backups.md`
- Test: `apps/server/test/merge-routes.test.ts` (new), `apps/server/test/decisions.test.ts`,
  `apps/web/test/MergeCard.test.tsx` (new), `apps/web/test/Backups.test.tsx`, `apps/web/test/Tasks.test.tsx`

**Interfaces:**
- Consumes: `conflictsOf`, `pick` (Task 8); the routes of Task 6.
- Produces:
  ```ts
  // modules/tasks/decisions.ts
  //   DecisionSubject gains { source: 'merge' }, whose owner is the CEO
  //   Decisions gains merges: { id: string; label: string; after: string | null; open: number; agentId: string;
  //     ownerPersonId: string }[]    after: the restored bundle's dumpedAt, for a kept database
  //     the merges with open CEO conflicts, for the company's owner only; counted once each, by the orchestrator
  // GET /api/requests answers `merges` beside `computerAccess`
  // modules/merge/routes.ts, the company's owner only (403 `forbidden` for anyone else):
  //   GET  /api/merges/:id/conflicts?settled=      { conflicts: ConflictView[] } the CEO's of that merge
  //   POST /api/merges/pick { ids?, merge?, table?, take, value? }   pick() as the CEO; answers its result
  ```
- Web: `MergeCard({ merge, onChange, onFailure })` among the decisions after `ComputerCard`; it loads the merge's
  conflicts and shows, per table, each conflict's `what` and its columns in two columns, "Here" and "There", with
  "Keep here" and "Take there" per conflict and "Keep all here" and "Take all from there" per table. `Backups`' restore
  dialog gets the tick; its kept list shows each merge's state and "Leave it out" with a confirm. `api.ts` gains
  `mergeConflicts(id)`, `pickConflicts(body)`, `leaveKept(name)`, and `restoreBackup(id, recoveryFile?, bringBack?)`.
- Copy, EN / RU, exactly:
  - The warning's line "Everything after <time> stays in the current database, which is kept on this server. A later
    update of Hornhoof merges it back." / «Все, что было после <time>, останется в текущей базе, она сохранится на
    этом сервере. Позднее обновление Hornhoof вернет эти данные.» goes; the tick and its line take its place.
  - The tick: "Bring back what came after <time>" / «Вернуть то, что было после <time>». Under it, ticked: "What the
    company did after <time> comes back as additions. Anything that differs goes to the orchestrator as a task, with
    both values; the restored values stay until he picks." / «То, что компания сделала после <time>, вернется
    добавлениями. Все, что различается, станет задачей оркестратора с обоими значениями; до его выбора остаются
    восстановленные.» Not ticked: "The database from before is saved as an encrypted backup for 30 days, then removed
    from this machine. What came after <time> does not come back." / «База, которая была до этого, сохранится
    зашифрованной копией на 30 дней и затем будет удалена с этой машины. То, что было после <time>, не вернется.»
  - A kept database: plan 7's line "The database from before the restore of <time> is kept on this server." / «База,
    которая была до восстановления <time>, сохранена на этом сервере.» stays first, its state after it; `pending` or
    `applied`: "Bringing back what came after it." / «Возвращаем то, что было после нее.»; either with an error: "Could
    not bring it back yet: <error>" / «Пока не удалось вернуть: <error>»; `merged`: "Brought back: <n> added, <m> to
    decide. Removed once its backup is made." / «Возвращено: добавлено <n>, решить <m>. Будет удалена, когда сохранится
    ее копия.»; `removing`: "Left out. Removed once its backup is made." / «Не возвращаем. Будет удалена, когда
    сохранится ее копия.»; the button "Leave it out" / «Не возвращать», while `pending` or `applied`, its confirm "What
    it held after the backup will not come back. It stays as an encrypted backup for 30 days." / «То, что в ней было
    после копии, не вернется. Она останется зашифрованной копией на 30 дней.»
  - A fork bundle in the list: "Set aside before a merge" / «Отложена перед слиянием».
  - The card's title, for a kept database: "What came after <time>" / «Что было после <time>», `<time>` its `after`;
    for any other source its `label` as it is. Then: "<n> changes about people, access, plans or machines
    need you." / «Нужно ваше решение по изменениям людей, доступа, тарифов или машин: <n>.»; "Here" / «Здесь»; "There"
    / «Там»; "Keep here" / «Оставить здесь»; "Take there" / «Взять оттуда»; "Keep all here" / «Оставить все здесь»;
    "Take all from there" / «Взять все оттуда».
  - `merge_pending`: "A database from before a restore is still being brought back. Wait for it, or leave it out in
    Settings." / «База, бывшая до восстановления, еще возвращается. Подождите или откажитесь от возврата в
    настройках.»
- `guide/backups.md`: a part "What came after a restore" in the guide's voice: the tick, the orchestrator's task, the
  CEO's card, "Leave it out", and that the database from before is kept as a backup for 30 days.

- [ ] **Step 1: Write failing tests.**
  - `merge-routes.test.ts`, on Task 8's fixture: `lets only the CEO pick his conflicts`: an invited person with the
    whole company's scope gets 403 on both routes; the CEO's `GET` lists the `people` conflict with `(hidden)` for
    `password_hash`; his `POST` with `take: 'there'` writes it and the row is settled `person:<id>`; with `take:
    'there'` on `machine_access` it is refused as for the orchestrator.
  - `decisions.test.ts`, `gives a merge's conflicts to the CEO`: with an open `people` conflict, the CEO's decisions
    carry the merge with `open` 1 and the counts count it once; a department's own person and the orchestrator's
    view do not.
  - `MergeCard.test.tsx`: `shows both values and settles them`: the conflicts in two columns; "Take there" posts the
    id with `take: 'there'`; "Keep all here" posts the table; `onChange` after each.
  - `Backups.test.tsx`: `asks whether to bring back what came after`: the tick is on and `restoreBackup` gets
    `bringBack` true; off, the other line shows and it gets false; `shows each kept database's state` for each status;
    "Leave it out" asks first and posts.
  - `Tasks.test.tsx`: `shows the CEO's merge card`.
  - The i18n test's key parity holds for every new key.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Show the CEO his merge conflicts, and ask before a restore whether to bring back what came
  after".

### Task 10: Real Postgres and the lab

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 9 committed. **Done when:** from the worktree
root `npm run test:real` and `npm run test:lab` pass with Docker running; `npx tsc -p apps/server/tsconfig.json
--noEmit` prints nothing.

**Files:**
- Create: `apps/server/test/real/merge.test.ts`, `apps/server/test/lab/merge.test.ts`
- Modify: `apps/server/test/real/pg.ts` (`forkDatabase`)

**Interfaces:**
- `pg.ts` gains `forkDatabase(from: string, name: string): Promise<void>`: every other session on `from` ended
  (`pg_terminate_backend` of its `pg_stat_activity` rows; the test closes its own pools on `from` first), `CREATE
  DATABASE <name> TEMPLATE <from>`, then `ALTER DATABASE <name> WITH ALLOW_CONNECTIONS false`, as a kept one is. A
  test that writes the fork by its own session turns its connections on first, as `keptDatabases.open` does.
- `real/merge.test.ts`, on a migrated real database with a company written by plain inserts, forked as
  `hornhoof_before_t<hex>`, each test dropping what it made:
  - `reads one snapshot`: a source opened on the fork reads the count of `tasks` (its first query takes the
    snapshot), then a task is inserted into the fork by another session: the source's next count is the same.
  - `reads the kept database, not the live one`: a title changed on the live database after the fork; `keptSource`
    with `config.databaseUrl` the live one's address (with `options` and `application_name` in it) reads the fork's
    title, and its `current_database()` is the fork's name.
  - `merges a fork of one cluster by its journal`: writes on both sides, then `runMerge` with `kept` false through
    `keptDatabases(...).open`: the two sides' new `xact` ids differ (one cluster counts transactions once); a proven
    overwrite applies, an unproven difference is listed, a skipped source is consumed, `complete` is ok.
  - `writes wait for the merge`: the app's own pool (`openDb` with `APP_NAME`, fenced, its 5 s
    `transaction_timeout`); a merge held 7 s by `onUnit`; meanwhile a task's title change and an invite's acceptance
    (main's: `invites`, then `people`) through the app's `db` wait at the gate (no row of theirs in `pg_locks`, no
    `transaction_timeout`) and land after the merge's commit, and the merge's result is as without them. A merge
    started while a session outside the gate holds a lock on `tasks` for 15 s ends with the lock timeout and changes
    nothing.
  - `holds the app's writes briefly on a big company`: before the fork, 50,000 `agent_events`, 5,000 `task_events`
    and 2,000 `tasks` written with `generate_series`, so both sides hold them; the kept one adds 1,000 agent events,
    100 task events and 50 tasks after it; merged by `compare` with `kept` true: `heldMs` is under 30,000, and every
    added row is on the leader. Above 30 s the agent stops and reports; it does not raise the limit.
  - `merges a database plan 7 kept`: a database migrated with a copy of the migrations folder without `0054` (its
    `_journal.json` without that entry) and filled, forked as a kept one: merged by `compare` into a leader at `0054`,
    `complete` ok.
  - `drops only a kept database`: `list` names the fork; `open` reads it with its connections off before; `drop`
    removes it; `drop('hornhoof')` throws before any SQL.
  - `an older bundle restored, then the database from before`: the leader is a fork taken before a series of writes
    on the other (the kept one), which also removes a task the leader has: by `compare`, every row the kept one added
    is added, every row it changed is a conflict with the leader's value kept, the removed task stays, and no value
    of the leader changed (a row by row compare of the leader before and after, but for the added rows).
- `lab/merge.test.ts`, one scenario, 20 minutes at most, with `steps.ts`: m1 a server, set up; a bundle within 3
  minutes; then a department "Later", a task in it, and the title of a task of before changed; the owner's restore of
  that bundle (`bringBack` true): within 4 minutes `/api/health`; within 3 more minutes the department "Later" and its
  task are back, the orchestrator has a task whose title starts "Bring back what the database from before the
  restore" and whose body names the changed task with both titles, `net.backups` has a `fork` row, and `pg_database`
  has no `hornhoof_before_*`. Then a new bundle, a department "Second" made after it, and the restore of that bundle
  with `bringBack` false: "Second" is not back, a second `fork` row is there, and no `hornhoof_before_*` within 5
  minutes.

- [ ] **Step 1: Write the failing tests** and `forkDatabase`; `npm run test:real` fails on `merge.test.ts`.
- [ ] **Step 2: Fix** what they find in Tasks 3 to 7, each fix with its failing test first in that task's test file.
- [ ] **Step 3: Check the disk, then run Done when,** as plan 7's Task 10 Step 3. Expected: PASS.
- [ ] **Step 4: Commit** "Test merges on real Postgres and in the lab: a fork, writes that wait, and a restore that
  brings back what came after".

### Task 11: Run everything and review

**Repo:** the `network` worktree, branch `network`. **Starts from:** Tasks 1 to 10 committed and reviewed. **Done
when:** Steps 1 and 2 pass for the agent; Step 3 is the team lead's, never an agent's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` and `npm run
  test:lab` (after the disk check) → pass; the `tsc` commands → no output; `bash -n` and `shellcheck` on
  `apps/updater/updater.sh` → no output.
- [ ] **Step 2: Check the public-repo rule.** As plan 7's Task 11 Step 2.
- [ ] **Step 3: Review.** The team lead reads the branch against spec section 5, 3.7, 3.8 and section 12's merge
  bullets, the overview's plan 8 entry and this plan's rulings, with Review Focus first; the CLI agent that did not
  write a task reviews it too; one fix pass, each fix with its failing test first.

The rehearsal, the merge into main, Ivan's Updates and the worktree's close are done once, for the whole series, at
its end. This plan's part of that rehearsal is what Task 10's lab scenario does: a restore with "Bring back what came
after" on, then one with it off.
