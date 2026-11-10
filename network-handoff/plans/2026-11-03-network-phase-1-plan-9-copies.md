# Network Phase 1, Plan 9: Copies, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A computer of the CEO, or of someone who sees the whole company, that is fit to hold the company's data gets
a number in the server order and becomes a copy: it takes the company's secrets, starts its own database, and follows
the leader by Postgres logical replication over the peer link. Once it holds everything, the leader makes it the sync
copy, so a commit is confirmed only once the copy has it, and says so at hornhoof.org; a copy that falls silent is
dropped from sync within seconds and named again once it keeps pace. A copy whose replication breaks makes itself
again beside the old database, which the leader merges before it goes. A machine whose owner loses whole-company
scope stops holding data at once, uploads what it holds through a restricted endpoint when it is back, and then wipes
its database, its plaintext dumps and its secrets.

**Architecture:** One migration, `0055_copies`: the server order's columns and the copy's report columns on
`machines`, `net.pulse` (a row the leader writes each second, so every copy knows how far it reaches), and the merge
sources `machine:` and `upload:` with the machine they come from. On the leader's app, `modules/copies/` decides who
may hold data (`qualify.ts`), numbers the machines and gives the first three the data role (`order.ts`), takes the
data away when a scope is lost (`scope.ts`), hands a new copy the secrets (`routes.ts`) and shows each machine's
place and copy (`view.ts`); plan 8's merger reads a copy's old database over the peer link (`peerSource`) and an
uploaded one on the leader. The keeper gains a third kind, the follow
keeper (`modules/keeper/follow.ts`), for a data machine that does not lead: it is a worker's keeper with a database,
which makes and remakes the copy (`copy.ts`) and opens a local door to the leader's database (`net/db-door.ts`). The
leading keeper gains the sync controller (`sync.ts`, with its decisions in the pure `sync-step.ts`), the pulse, the
slots, and doors to the copies for merges. The updater gains four requests: become a data machine, load the schema
of a new copy, load an upload, and wipe. The web app shows each machine's number and its copy's state.

**Tech Stack:** TypeScript on Node 22 (`node:http2`, `node:net`, streams); Postgres 17.11 logical and synchronous
replication; Fastify 5; drizzle-orm 0.45.4 on node-postgres and PGlite; `pg`; `age-encryption` 0.3.1 (plan 7);
bash 3.2 and BusyBox for `updater.sh`; Docker Compose profiles; React for the web app; vitest; Docker for `npm run
test:real` (pairs of `linux/amd64` and `linux/arm64` Postgres, the second under QEMU on CI) and `npm run test:lab`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.3 ("Who may hold data", losing whole-company scope, the
server order's columns and what the order decides), 3.4 ("One data machine", fence 1's sync flag, fence 3, fence 4,
"When the relay and the copy are both gone"), 3.7 (all but "Promotion" and "Rejoining"), section 2 ("Joining" and
the copy's lines on the Machines tab), section 4's rows "Copy laptop sleeps, copy disk full, or copy behind" and "The
server is 1, two laptops 2 and 3", section 5 steps 1 to 3 for a returning copy, section 10 ("Secrets", "A stolen
machine" for a data machine) and section 12's bullets on pairs, the lab's writer and checker, and the lost scope.
Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 9's entry. Plan 8, ruling 1 a), b) and d).

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in the series' worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network` on its branch `network`, after plan 8's last task is
committed there. No new worktree: nothing of the series ships until the series merges into main, once, at its end.

**Handed over** (done on the `network` branch before this plan starts; none of it is shipped):
- Today's code: `people.scope_kind` (`company` or `listed`), `people.is_owner`, `people.status`; `person_access`;
  `machines` (`kind`, `hostname`, `person_id`, `revoked_at`, `created_at`); `PublicLinks` (`modules/link/link.ts`:
  `set`, `remove`); `Machines.tsx`; `apps/web/src/i18n/en.ts` and `ru.ts`.
- Plan 1: the relay client's `route`, `setSync`, `health`, `changeKey`, `visitorKey`; `Route`, `SyncRecord`,
  `SyncPost`, `SyncResult`; the fake relay `apps/server/test/fake-relay.ts` with the sync record.
- Plan 2: compose's `front`, `keeper`, `migrate`, `app`, `db`, `node`, `updater` and `db`'s settings (`wal_level =
  logical`, `max_replication_slots = 10`, `max_wal_senders = 10`); `app` waits for `migrate`
  (`service_completed_successfully`); `KEEPER_PORTS`, `Keeper`, `KeeperOptions`, `keeper.json` (`KEEPER_FILE`),
  `AppMode` (`off` until the first fresh word); `migrate.ts`; `passThrough`, `serve`, `Target`; `TunnelKeeper`;
  `updater.sh` (`handle_request`, `status.json`, `update`, `healthy`).
- Plan 3: `net`, `net_local` (`state`, `lease` with `sync` `copy`, `relay_off` or `alone`), `net.journal`,
  `net.fence_check()`, `net_fence`, `net.assert_lease`; `LeaseStore` (`take`, `renew`, `fence`, `endSessions`,
  `problems`, `prune`), `keeperSql`, `leaseValid`, `nextLeaseStep`, `LEASE_MS`; the keeper's `mode()`; `openPool`,
  `stripSettings`; `test/real/pg.ts` (`realDatabase`, `migrateDb`, `openDb`); `createTestSql`, `setLease`; the fence
  lint (`test/fence-lint.test.ts`).
- Plan 4: `applied`, `tool_calls`; `KEEPER_HOLD_MS`; `front` stamping tool calls.
- Plan 5: `issueCertificate`, `certFacts`, `MachineRole` (`data`, `worker`); `thisMachine`, `findThisMachine`,
  `revokedSerials`, `peerSecret`; `networkRoutes` (`POST /api/network/certificate`, `GET /api/network/peers`, `POST
  /api/network/report`); `askerOf`, `VIA`; the leader's own hidden `server:<machine id>` row; `PeerServer` (`hello`,
  `CONNECT app:8080`, `CONNECT db:5432` on a `peer` listener for a `data` certificate), `PeerDoor`, `APP_AUTHORITY`,
  `DB_AUTHORITY`; `peerClientFor`, `serviceName`, `PeerServices` (the `-data` and `-app` stcp services); the keeper's
  `Measures` (`fsync_p99_ms`, `disk_free`, `uptime_s`), `CertificateKeeper`, `machineKey`; `LeaseStore.othersHoldData()`
  and the check that no lease is taken or renewed with sync `alone` while another data machine is listed.
- Plan 5b: `WorkerKeeper`, `workerConfig`, `WorkerView` (`role`, `data`, `link`), `DataMachine`, `workerView`,
  `PEERS_FILE`; `PeerLink` (`use`, `leader`, `request`, `connectApp`, `state`), `DialTarget`; `visitConfigFor`,
  `visitClientFor`; `keeperAsker`, `KEEPER_MARK`; `lockLiveMachine`, `revokeMachineRows`, `dropPeerSecrets`,
  `visitorKeyOf`, `disconnectMachines`; `onlineShare`; `compose.worker.yaml` (`db`, `migrate`, `app`, `node` in the
  profile `data`); a worker's `.env` (`COMPOSE_FILE=compose.yaml:compose.worker.yaml`, `HORNHOOF_ROLE=worker`,
  `HORNHOOF_JOIN_SERVER`, `HORNHOOF_MACHINE_ID`); `updater.sh`'s worker mode; the lab (`npm run test:lab`,
  `test/lab/`).
- Plan 6: `machine_access`; the keeper's part that keeps a machine's computer access, run by `WorkerKeeper`.
- Plan 7: `machines.age_key`, `ageKey(dir)`, `BundleSecrets` (`HORNHOOF_SECRET`, `NODE_KEY`, `RELAY_URL`) and the
  rule `updater.sh` checks each with before it writes it into `.env`; `PeerLink.stream`; the leader's peer paths
  `/peer/backups/<id>`; `HolderKeeper`; `dump.json` and `dumps/`; `owned`; `cutover.sql`; `recovery_keys` and
  `linkPrint` (a changed link key retires the recovery key's match and raises the banner); `disablePerson`.
- Plan 8: `MergeSource`, `keptSource`, `sourceUrl`, `KEPT_NAME` (`modules/merge/source.ts`, the one file the fence
  lint lets open a client beside its three); `runMerge`, `MergeResult` (`apply.ts`); `complete` (`check.ts`); `A`,
  `B`, `S` and the cutoff (its rulings 4 and 5); `Merger` (`discover`, `tick`, `pending`), `KeptDatabases`
  (`merger.ts`, `kept.ts`, tested in `merge-kept.test.ts`); `net.merges` (`source` checked `^(kept|machine):.+$`,
  `fork`, `status` `pending`, `applied`, `merged`, `removing` or `done`), `net.restores`, `net.horizon`; the fork
  bundle through `dump.json` with a database's name; `rules.ts` and its never-compared columns; `LeaseStore.prune`
  with its conditions (ruling 14).
- Where the branch's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`; in Russian a plan is «тариф».
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys and passwords made at run time.
- No new npm dependency. One new migration, `0055_copies`: `npx drizzle-kit generate --name copies` from
  `apps/server` for what `schema.ts` describes, with the hand-written part of Task 1 appended after a `-->
  statement-breakpoint`; never an edit of an older one.
- A worker holds no company secret and no database (plan 5b). A data machine holds `HORNHOOF_SECRET`, `NODE_KEY`,
  `RELAY_URL`, its own `POSTGRES_PASSWORD`, both stcp secrets and the whole database (spec section 10). A secret never
  goes into a log line, an answer other than the one sealed to its machine, or a file outside `.env`, the keeper's
  volume, the replica's passfile in the `db` volume (ruling 7) and a control file of mode 0600 that is removed once
  read.
- A copy never writes the company's tables: its keeper takes no lease, runs no link frpc and never sets its app to
  `lead`; only its apply worker writes, as `session_replication_role = replica`.
- No database is thrown away before it is merged (spec 3.7): a copy's old database goes only after the leader's merge
  of it is `merged`, or `done` by ruling 15; an upload, and the machine's database it came from, only after the
  upload's merge is `merged` and its fork bundle recorded.
- Messages between keepers and apps change only by additions (spec section 9); a field a keeper of plan 8's build
  does not send keeps what it had.
- Ivan's rules: only a machine's owner opens computer access to it; no step of this plan asks Ivan to type a command.
  Everything here happens by itself: a machine becomes a copy, a copy is remade, a lost scope is wiped.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; `npm run test:real` and `npm run test:lab` need Docker. Types, from the worktree root: `npx tsc
  -p apps/server/tsconfig.json --noEmit`, and `apps/web` likewise when touched, each printing nothing. `bash -n` and
  `shellcheck` on `apps/updater/updater.sh` print nothing when it is touched. Never run prettier.
- Before a real or lab run on the team lead's Mac: `df -h /` and `docker system df`; clean only build cache and
  `hornhoof-lab/*` images, never a volume.

## Rulings made while planning

1. **Plan 9 is three plans; this is the first.** (The team lead approved the split on 2026-11-03: 9 Copies, 9b The
   server order, 9c The planned switch and updates across machines, all on the `network` branch.) The overview's plan 9
   holds copies, the server order and the planned switch with updates across machines. This plan, 9, makes copies and
   keeps them in sync. Plan 9b brings the score and its measurements, the daily ranking, pins, "Does not take the
   server" and its refusals, `server_why` for numbers from 2, the copy handed over when the ranking changes, and section
   2's whole Priority row and sortable column. Plan 9c brings "Move the server here" (3.4 "Planned switch") with 3.7's
   promotion and sequences, section 9's updates across machines (the promise, the slot wait before the dump, sync off
   for migrations, rollback with slots, copies remaking after migrations), the built-in node's identity per machine
   (plan 4's ruling 9, which a copy's own node needs; until then a copy runs no built-in node), and the relay's traffic
   counter with its runbook line. Plan 10 keeps proofs (a) and (b), the heartbeats and the takeover. Until 9c, an update
   of the leader that changes the schema makes each copy make itself again (ruling 14: it sees the leader's count of
   migrations differ from its own), and a copy whose subscription stopped first is dropped from sync within seconds
   (ruling 9).
2. **What this plan does of the server order.** It adds the three columns of spec 3.3 and numbers the machines by the
   spec's ties alone, since the score is 9b's: 1 is the leader; then the machines that hold a copy, then the rest that
   qualify (ruling 3), each group by the CEO's machines, then whole-company people's, then the older `created_at`.
   Numbers 2 and 3 get the data role; from 4 on a machine works. A machine holding a copy keeps its place ahead of those
   without one, so no ranking here ever takes a copy away: a copy goes only with its scope (ruling 10), its row
   (Disconnect) or plan 9b's handover. A data row whose person no longer passes the scope check of ruling 3 (a restore
   of an older bundle can bring one back, ruling 21) is not ranked: the ranking takes its data away as ruling 10 does.
   `server_why` holds a key the card turns into words: `server` on 1 ("The company server runs here."), `next` from 4
   ("Gets a copy if one of the first three leaves."), null on 2 and 3 until 9b. `server_pin` is added and stays null.
   The ranking runs at the app's first lead, every minute while it leads, and at once after a scope change of a person
   or a Disconnect; it writes only rows whose values change, in one transaction.
3. **Who may hold data** (spec 3.3), checked in this order, the first failure being the machine's reason: a live row of
   `kind` `computer` (else "it is a phone"); with a core, `network_id` set, or the leader's own `server:` row (else
   "Hornhoof runs here without Docker"); its person active and the CEO (`is_owner`) or `scope_kind` `company` (else the
   scope line); a public link of the company (else ruling 18's line); a report within the last 2 minutes with `memory`,
   `disk_free` and `fsync_p99_ms` (else "measuring"); `memory` at least 3.5 GiB; `disk_free` at least 3 times the
   leader's database (`pg_database_size`, read by the ranking) plus 10 GiB; `fsync_p99_ms` under 50. The spec says
   Docker "gets 4 GB of memory or more": a Linux VM given 4 GB reports a little less as its total, so 3.5 GiB is the
   line (deviation in form). The keeper reports `memory` as `os.totalmem()` and `cores` as `os.availableParallelism()`,
   both inside its container, which on a Mac is Docker's VM. A machine that holds a copy and later fails a measure keeps
   it until 9b hands it over; one that fails the scope check loses it at once (ruling 10).
4. **A copy is a data machine that follows.** It has the role `data`, a `data` certificate, the secrets of
   `BundleSecrets`, its own `POSTGRES_PASSWORD`, and runs `db` and `app` from the profile `data`. `compose.worker.yaml`
   moves `node` to a profile of its own, `builtin`, which no `.env` of this plan names (ruling 1). Its keeper is the
   follow keeper: the worker's keeper of plan 5b (certificate by the peer link and by signed renewal, the view, the
   front door to the leader's app, the reports, computer access, the holder) with a database, a peer server, the peer
   frpc of its own `-data` and `-app` services, and the copy maker. It never takes a lease, never runs the link frpc,
   and writes `keeper.json` with the mode `off` while its database is being made or swapped and `read` otherwise; with
   no leader reachable for 60 s its front door passes to its own app, which reads (spec 3.9). Which keeper runs is
   chosen at its start: `HORNHOOF_ROLE=worker`, the worker's; else, while the control folder holds `replica.json` or
   its database has an enabled subscription, the follow keeper; else the leading keeper as before. The keeper's
   environment carries `HORNHOOF_ROLE` (plan 5b), so the `up` that makes a worker a data machine, or a data machine a
   worker again, starts it anew as the other kind. `migrate` does nothing and exits 0 while `replica.json` is there
   ("This machine keeps a copy; its schema comes from the company server."), so the `app`'s wait for it never
   migrates a copy; the updater updates such a machine as a worker (no backup, no migrations, its turn waited for)
   until 9c brings a copy's own order. The app's grants for its agent roles are per database and not copied, so with
   a keeper the app runs them on each change of its mode from `off`, not at its start.
5. **Becoming a copy.** The ranking sets the role `data` on the row. The worker's keeper sees it in its view, asks for a
   new certificate (plan 5's route issues the row's role), and with it `POST /api/network/secrets`, which answers the
   three secrets sealed with age to the row's `age_key`, only to a live row of the role `data` whose certificate it is
   and whose person passes ruling 3's scope check; plan 5's certificate route likewise issues a `data` certificate only
   to such a row, and a `worker` one otherwise. Only a worker's keeper does this, and never while `role.json` or
   `replica.json` is there. The keeper opens them, writes `replica.json` and then `role.json` (`{ id, secrets }`, 0600)
   into the control folder, and the updater's `become_data` writes `.env`: the three secrets (checked as plan 7 checks
   them), `POSTGRES_PASSWORD` (24 random alphanumerics when the line is missing or empty), `HORNHOOF_ROLE=data` and
   `COMPOSE_PROFILES=data`; removes `role.json`; and runs `up -d --no-build` of every service but itself with
   `HORNHOOF_ROLE=data` in compose's own environment (the updater's environment holds the role it was started with,
   which would else win over `.env`), then replaces itself from the image it runs. A failed check or a failed `up` puts
   the `.env` of before back, removes `role.json` and `replica.json`, stops `db`, `migrate` and `app`, starts `front`
   and `keeper` again as a worker's, and writes `role.failed` with one line ("The company's settings cannot be written
   here, so this machine stays a worker."), which the card shows as the copy's state; the keeper tries again an hour
   later. `.env.before-data`, kept until the end, lets an updater that restarted in the middle finish or undo it.
6. **The data link.** A data machine reaches another's `db` through `CONNECT db:5432` on the peer link, directly or
   through that machine's `-data` stcp service, whose secret only data machines get (spec 3.2); `visitConfigFor` takes
   `-data` targets with that secret for a data machine, whose peer link then dials through them. Postgres never sees
   the peer link itself: the keeper opens a door, a TCP listener on its container, whose every connection becomes one
   `CONNECT db` stream. The follow keeper's door, `KEEPER_PORTS.db` (7432), leads to the leader's `db`, and the copy's
   `db` connects to `keeper:7432` for the schema and the subscription. The leading keeper opens a door to a copy's
   `db` while its app asks for one, on a port of its choice named in `keeper.json` (`doors`). A door takes connections
   only from the addresses `db` and `app` resolve to, looked up each minute. The copy and a merge connect as
   `hornhoof_replica` (`LOGIN REPLICATION BYPASSRLS`, `USAGE` and `SELECT` on `public`, `net`, `net_local` and
   `drizzle` and on their tables now and later, nothing else), whose password is `replicaPassword(secret)`, base64url
   of HMAC-SHA256 keyed by the company secret's bytes (as `loadConfig` decodes them) over `hornhoof-replica`, so every
   data machine knows it and none stores it. `BYPASSRLS`, since the tables plan 5 hides keep row level security with
   no policy, and a copy would else get them empty. The password is set as a SCRAM-SHA-256 verifier the keeper
   computes, on a connection closed right after, so no statement, log line or `pg_stat_activity` row holds it; the
   subscription reads it from a passfile in the `db` volume (ruling 7). The role is cluster-wide but its grants are
   per database, so each keeper checks, each minute, that the role exists and has `USAGE` on each of the four schemas
   its database has (`has_schema_privilege`), and grants in full when not; the follow keeper also right after a
   schema load and after a swap. Every table of `public` and `net` has a primary key, or the publication would refuse
   the leader's updates of it; Task 4's test holds that. (Deviation in form: the spec names no role for this.)
7. **A new copy** (spec 3.7). The copy maker asks its updater with `schema.json` (`{ attempt, database, port, password
   }`, 0600). The updater runs, in `db`, `pg_dump --schema-only --no-owner --no-publications --no-subscriptions
   --no-privileges` of the leader through `keeper:7432` and `pg_dump --data-only --table=drizzle.__drizzle_migrations`,
   both into one file, then loads it into the database named with `psql -1 -v ON_ERROR_STOP=1`, which must hold no
   table in `public` first; writes the replica's passfile `<PGDATA>/replica.pgpass` (0600, the `postgres` user's); and
   writes `schema/<attempt>.done` or `.failed`. Then the maker grants the replica role in that database (ruling 6),
   sets `wal_receiver_status_interval = 1s` (by `ALTER SYSTEM` and a reload) and makes the subscription `copy_<the
   first 16 hex of its network id>_<attempt number>`, to the publication `hornhoof`, with `copy_data = true`,
   `synchronous_commit = 'local'`, `binary = false`, `streaming = off` and `disable_on_error = true`, connecting to
   `host=keeper port=7432 dbname=hornhoof user=hornhoof_replica passfile=<that file>`; its name is its slot's and its
   application name. A failed attempt is given up whole before the next, 10 minutes later with the next number, so a
   slot name is never used twice: its subscription disabled, detached (`slot_name = NONE`) and dropped, then its
   database dropped when it holds no `net_local.state` row (ruling 12). The leader drops the detached slots (ruling
   13). The leading keeper keeps the publication `FOR TABLES IN SCHEMA public, net` (made once, when missing). The copy
   is finished when every row of `pg_subscription_rel` is `r`; its progress until then is its database's size over the
   leader's, at most 99. It keeps the count of migrations its schema came with; each view carries the leader's
   (ruling 14).
8. **The pulse.** While another data machine is listed, the leading keeper writes `net.pulse` (`at`
   `clock_timestamp()`) every second with `synchronous_commit = local`, so published WAL flows even when the company
   is idle, every copy confirms its position each second, and each copy knows in the leader's clock how far it
   reaches: its report's `copyAt` is its `net.pulse.at`. `net.pulse` has the fence trigger as every `net` table; the
   keeper's session passes it as before.
9. **Synchronous replication and the sync record** (spec 3.4 fence 3, 3.7). The leading keeper's sync controller
   samples every 250 ms and decides with the pure `nextSyncStep` (Task 7 has its table):
   - With no other data machine listed: sync `alone`. When one is listed, it first posts "sync off" (epoch one above
     the record's, at its own route's generation) and goes on with `relay_off` once the relay stored it.
   - A copy keeps pace while its slot's `confirmed_flush_lsn` is at or past the leader's WAL position of 1 s before.
     The lowest-numbered copy that finished and has kept pace for 30 s is named: `synchronous_standby_names = 'FIRST 1
     ("<its name>")'` by `ALTER SYSTEM` and a reload. A reload does not say when commits start to wait: backends
     decide by a flag the checkpointer sets once it has read the new setting. So the setting counts only after a
     barrier: its walsender shows `sync_state` `sync`, then a `CHECKPOINT` ends, which the checkpointer runs only after
     the reload it was signalled before. Then the WAL position W is read, and once the slot confirmed W, "sync on"
     naming the copy's network id, at its own route's generation.
   - A named copy is silent when no new `reply_time` came from its walsender for 2 s, timed by the leader's own
     monotonic clock from when it last saw the value change (the value is the copy's clock, which may be off by
     seconds), or when its walsender is gone; or when for 5 s every sample saw a commit waiting on it (`wait_event`
     `SyncRep`) for over 1 s while the copy's `CONNECT db` streams carried under 1 MB in those 5 s. The spec's "commits
     under 1 MB" is read by what the keeper can see: a big file moving to the copy is bytes on its streams, so it does
     not count; a big transfer slower than 1 MB in 5 s does count as silent, and other traffic on the streams can keep
     a slow copy named (deviation in form, both accepted). Then "sync off", and once the relay stored it,
     `synchronous_standby_names` cleared.
   - A lower-numbered finished copy that kept pace for 30 s, or a named copy that is no longer a copy, is replaced
     through "sync off" in the same way, then named.
   - After its route's generation changes (the link frpc registered again), it posts its state again at the new
     generation; until the relay stored it, `relay_off` does not count.
   - The lease's sync flag is `copy` while `synchronous_standby_names` is set (no commit returns until the copy it
     names has it, once the barrier passed; before it the relay still holds "off"), `relay_off` while it is not and the
     relay holds "off" at the current generation, `alone` with no other data machine, and null otherwise; `mode()`
     says `lead` only with a flag. A keeper that starts reads the record and the setting it finds, runs the barrier
     again, and clears the setting only after "off" is stored.
10. **Losing whole-company scope** (spec 3.3). First, before anything new is written, each live machine of the person
    with the role `data` is cut from the leader's WAL: its walsender ended and its slot dropped (tried for up to 5 s,
    since its subscription may reconnect in between; else 503 "Try again in a minute."), so no row written after this,
    a new key above all, can reach it; a named sync copy makes the commits below wait until the controller has posted
    "off" and cleared it (ruling 9). Then, in the transaction of `PATCH /api/people/:id` that turns the person's
    `scope_kind` from `company` to `listed`, for each of those machines: `server_order` null, the role `worker`,
    `data_left_at` now, `upload_state` `waiting`, its certificates revoked, and `dropPeerSecrets`; after it commits,
    the link key changed (ruling 20), which retires the recovery key's match and raises plan 7's banner (the spec's
    renewed recovery pair), the visitor key renewed (`visitorKeyOf` with `force`), and the ranking run. The person's
    own leading machine is refused first: 409 `leader_scope` "<machine> runs the company server. Move the server to
    another machine first." until 9c brings the move. The ranking does the same for a data row whose person fails the
    scope check for any other reason (ruling 2). A disabled person's machines are disconnected as today (plan 5b), and
    a Disconnect of a data machine now cuts it the same way first, sets its `data_left_at`, and changes the link key
    (spec section 10), so it leaves holding nothing that opens the company's link. The card of a machine that left
    says "Stopped holding the company's data on <date>. If it may be in other hands, change the company secret and the
    API keys." (spec: "The card then offers a new company secret and API keys as the CEO's choice"; a line, as plan
    5b's Disconnect card).
11. **The upload and the wipe** (plan 8's 1b, spec 3.3). A machine whose row says `upload_state` `waiting` learns it
    from its view, or by its signed renewal once its `data` certificate is refused. Its follow keeper sets its mode
    `off`, disables its subscriptions at once, and asks its updater for an upload (`upload.json`): each table of
    `public`, `net` and `net_local` as CSV with a header (`COPY ... TO STDOUT (FORMAT csv, HEADER true)`), one file a
    table, in one gzip tar. The keeper puts it through `PeerLink.stream('PUT', '/peer/upload/<id>')` with its worker
    certificate. That path is the restricted keeper endpoint: the leading keeper's peer server takes it only from a
    machine its app names in `uploads` (rows `waiting`), one at a time, at most 3 times the leader's database plus 1
    GiB, into `/control/uploads/` (0600), and writes `load.json` for its updater. The updater never runs SQL that came
    from the machine: it unpacks at most 4 times the leader's database plus 1 GiB, takes only files named
    `<schema>.<table>.csv` for tables the leader has, makes `hornhoof_uploading_<first 16 hex of the network
    id>_<stamp>` with the leader's own schema, loads each file by `\copy` with the header's columns checked against that
    table, as data alone, under `session_replication_role = replica`, in one transaction, then renames the database
    `hornhoof_upload_...`; a failure drops it, and the machine, still `waiting`, uploads again 10 minutes later. The
    merger takes such a database as a source `upload:<name>`, with a fork bundle as plan 8 makes one for a kept
    database. The row goes `received` once the database exists and `kept` once that merge is `merged` (plan 8's
    completion check, spec 3.7) and its fork bundle is in `net.backups`; then the machine's view says `wipe` and its
    keeper writes `wipe.json`. The updater's wipe keeps `wipe.json` until every step is done, so a step that fails is
    tried again a minute later, also after a restart: it refuses a database with a `net_local.state` row (ruling 12),
    stops `db`, `migrate` and `app`, removes the database volume, `dumps/`, `restore/`, `schema/`, `uploads/`, the
    updater's own dumps, `replica.json` and the copy's files, and only then empties `HORNHOOF_SECRET`, `NODE_KEY`,
    `RELAY_URL` and `POSTGRES_PASSWORD`, removes `COMPOSE_PROFILES`, writes `HORNHOOF_ROLE=worker`, runs `up -d
    --no-build --remove-orphans` with that role in compose's environment, and writes `wiped.json` last; its role check
    then replaces the updater itself (ruling 5). The worker keeper's next report says `wiped`, and the row's
    `upload_state` becomes null; a worker's keeper, which holds no database, answers an upload request with `wiped` at
    once. It never receives anything new: it was cut from the WAL first (ruling 10), its certificate is a worker's, and
    its subscriptions were disabled. A `hornhoof_next` being made goes with the volume: it was read from the leader
    after the old one stopped, and never wrote. (Deviation in form: the spec says "uploading its database's unmerged
    rows"; it uploads every row and the merge finds what is unmerged, so the machine needs to know nothing of the
    leader's journal.)
12. **A returning copy, section 5 steps 1 and 2** (plan 8's 1d). Step 1 holds by construction: a follow keeper is
    fenced (no lease), its app reads, and it runs no link frpc. Step 2's bundle is needed only by a machine that wrote,
    which in this plan none does, since no copy ever leads before plan 9c. So the guard alone is here: a database
    whose `net_local.state` has a row (it once held a term) is never dropped by this plan's remake, swap or wipe; the
    card says "Copy: stopped" and the database stays until plan 10, which brings the old leader's return and its
    bundle, signed by a data machine that is not the leader, and says what becomes of such a copy (its entry in the
    overview). (Deviation, approved by the team lead on 2026-11-03.)
13. **Slots and WAL.** The leading keeper sets `max_slot_wal_keep_size` to the smaller of 20 GB and a quarter of its
    volume's free disk, in whole MB, by `ALTER SYSTEM` and a reload, at its first lead and every hour. Every minute it
    drops each slot `copy_<16 hex>_<n>` that no live row of the role `data` has those 16 hex for, or whose `n` is below
    the attempt in that row's reported `copy_name`, ending its walsender first; a slot of a later attempt than the
    report waits for the next report. A table sync slot (`pg_%_sync_%`) that has been inactive for 10 minutes in a row
    is dropped too: the attempt that made it was given up, or its copy sleeps and will make itself again. Other names
    are left alone. A slot whose `wal_status` is `lost` is reported to its copy, which makes itself again (ruling 14).
14. **Remaking into a side database** (spec 3.7). A copy makes itself again when the leader lists its slot `lost`, or no
    longer lists a slot it listed before, two views in a row, or when its subscription stopped on an error (`subenabled`
    false) and an `ENABLE` did not hold for 10 minutes, or when the leader's count of migrations is not the one its
    schema came with. It disables the old subscription and detaches it from its slot (`slot_name = NONE`), so the leader
    drops that slot (ruling 13), and makes a new copy into `hornhoof_next`, with the next attempt number, as ruling 7,
    while the old `hornhoof` goes on being read. Once that copy finished, it reports `old: { attempt }`; the leader's
    merger makes a merge `machine:<machine id>:<attempt>` and reads the copy's `hornhoof` through a door (ruling 6) as a
    `MergeSource` (`peerSource`); when that merge is `merged` (or `done`, ruling 15) the copy's view says so, and the
    copy swaps: `off`, the new subscription disabled, `hornhoof` renamed `hornhoof_old_<stamp>` and `hornhoof_next`
    renamed `hornhoof`, the new subscription enabled, the old one dropped, the old database dropped, the replica role's
    grants made on the new one, `read`. Each step is written to `<keeper dir>/copy-state.json` first, and a keeper that
    starts finishes a swap it finds half done. The leader drops the old slot by ruling 13.
15. **A copy's old database costs one id-set read** (spec 3.7: "A copy that never wrote still runs the compare; usually
    it finds nothing, at the cost of one id-set read"). For a `machine:` or `upload:` source whose `net_local.state` has
    no row (it never wrote) and that lacks no restore the leader has, the merge is `merged` once every journal id of the
    source at or after the leader's own horizon is on the leader or consumed, the source has no open conflict, and no
    `net.backups` row of it is missing on the leader. Every row of a copy that never wrote came from the leader with its
    journal row in the same transaction, so what it holds that the leader lacks is what the leader deleted since; ids
    older than the leader's horizon are the leader's own pruned history. This check reads only `net.journal`'s ids,
    `net.merge_consumed`, `net.backups`, `net.merge_conflicts`, `net.restores`, `net_local.state` and the leader's
    `net.merges` and `net.horizon`, by column, so it runs before plan 8's check that both sides have the same shape, and
    a copy of an older schema merges. Any other source goes plan 8's whole way. (Deviation, approved by the team lead on
    2026-11-03: plan 8 reads every row of a source, which for a copy across homes would cross hornhoof.org once more.) A
    restore is the one way the leader loses rows it did not delete itself, so a source that lacks a restore the leader
    has is compared row by row, as section 12 says, with one exception: when the CEO left out that restore's kept
    database (its merge has a `fork`, was never `merged`, and is `removing` or `done`), a copy that never wrote holds
    nothing that database did not hold, and its merge is `done` with the line "Left out with the database from before
    the restore of <time>.", so the CEO's choice is not undone by a copy. A kept database left out because it held no
    company (a total loss) does not count: the copy then compares, and brings back what only it held.
16. **The copy's lines** (section 2 and section 4's rows). A copy's state on its card, from the leader's view of its
    slot and its last report: "being made, <p>%", "being made again, <p>%", "up to date" (named sync, or keeping pace),
    "catching up" (connected, under a minute behind, not yet keeping pace), "<n> min behind" (connected, over a minute
    behind), "asleep since <time>" (no walsender, or no report for 2 minutes; the time is its `copyAt`), "stopped: disk
    full" (its report says so: its subscription stopped with under 1 GiB free), "stopped: the company's settings cannot
    be written here" (ruling 5), "stopped". The tab says "<leader> leads. <copy> keeps a copy and takes over if <leader>
    stops." (two copies: "<a> and <b> keep copies; <sync or a> takes over if <leader> stops."), and, while no copy is
    named sync or keeping pace and one has existed, "Only <leader> holds changes since <time>", the newest `copyAt` of
    the copies. The tab says "takes over" as the spec does: plan 10 makes it so, and nothing of the series ships before
    it.
17. **The lease renews as on one machine until plan 10** (deviation, approved by the team lead on 2026-11-03). Proofs
    (a) and (b) come with plan 10's takeover, and before it no copy takes over, so a lease renewed without proof cannot
    meet another leader. One rule of the spec is kept now: while a commit has waited on a silent copy for 10 s and the
    relay has not stored "off", the keeper stops renewing, so the lease ends, fence 4 ends the waiting sessions and
    their callers get an error (spec 3.4: "the leader fences after L and its commits wait"). It renews again once the
    relay stored "off" or the copy answers, and not before: ending the waiting sessions does not count, or each new
    lease would wait out the same 10 s again. Going on under a split term after 2 minutes (3.6) is plan 10's. Plan 3's
    ruling 6 is here too: at lease end with another data machine listed, the keeper stops its link frpc; it starts it
    again 30 s later while it does not lead, so it can hold its route and get "off" stored, which it needs to lead again
    (no copy takes the name over before plan 10, which sets that wait).
18. **Copies need the company's link** (deviation, approved by the team lead on 2026-11-03). The sync record lives at
    the link's name. The spec gives a company without a public link a hidden name; that, and a takeover by it, are plan
    10's. Here a company with no link gives no machine a copy, every qualifying machine's reason being "the company has
    no link at hornhoof.org; turn it on in Settings", and `PublicLinks.remove` is refused while another data machine is
    listed (409 `link_needed` "Machines keep copies of the company through its link, so it stays."). A rename keeps
    working: the controller follows the link's name and posts its state there. The overview's plan 10 entry gives a
    company with no link its hidden name and lifts `link_needed`; no company ships without copies for want of a link.
19. **What the other plans left here.** Plan 5's ruling 7 (a copy's app door passing to the leader): a copy's app door
    reaches its own app, and nothing needs more, since workers pick the leader by `hello` (deviation in form). Plan
    6's ruling 11 (a data machine that does not lead keeps its own computer access): the follow keeper runs plan 6's
    part as a worker's keeper does. Plan 7's ruling 1: the bundles' recipients follow the role `data` already, so
    copies get them; "Debian leads; restore there" needs nothing, since a copy's front door passes to the leader;
    `cutover.sql` drops the slots of the database it closes, after it ends its sessions, so a restore leaves no slot
    behind and every copy remakes (ruling 14), its old database covered by ruling 15. Plan 8's ruling 14: with other
    data machines the prune deletes only rows older than 7 days and older than the oldest `copyAt` among finished
    copies whose slot is not lost; a copy whose slot is lost never wrote and makes itself again, so it holds nothing a
    merge must prove and does not hold the horizon back (deviation in form from 3.7's "every data machine
    confirmed"). The relay's traffic counter and "Mac cannot reach Debian; copy stopped." (which
    needs the heartbeats) are 9c's and plan 10's.
20. **The link key changes by a key Hornhoof chooses** (deviation, approved by the team lead on 2026-11-03; plan 1 has
    an addendum for it). Plan 1's R6.1 makes the relay pick the new key and refuse the old one at once, so an answer
    lost on the way would leave the company with no key that works. This plan is the first to change the key by itself,
    so R6.1 takes an optional body `{ key }` (43 base64url characters) and sets that key. `PublicLinks.changeKey` first
    saves the new key, sealed as the key is, in `public_links.next_key_enc`; then asks the relay; on a 200 it makes it
    the key and clears `next_key_enc`; on any other end, the next try reads `route` with the next key first (it worked:
    adopt it) and then with the key (it did not: ask again). While `next_key_enc` is set, each ranking tries again. The
    relay's side is plan 1's addendum, Task A1, in the relay's repository: R6.1 still authenticated by the current key,
    the new key checked as 43 base64url characters (else 400 `invalid`), and a key equal to the current one refused (400
    `same_key`). The team lead runs it and deploys the relay with the rest of the series' relay work at the end, before
    the rehearsal. This plan's lab runs on the fake relay, so here only the fake relay, which answers as the addendum
    does, and plan 1's client `changeKey(name, key, next?)` change.
21. **A restore keeps who holds the company's data, and its link** (plan 7's ruling 14 carried further; approved by the
    team lead on 2026-11-03). A restore of an older bundle would bring back a machine's data role and the link key and
    stcp secrets of before, which a machine that left may know or which the relay no longer takes. So `carry.sql` also
    takes each machine's `role`, `data_left_at` and `upload_state`, the `public_links` row whole (its key and
    `next_key_enc` sealed as stored), and the `peer_secrets` rows, and `applyCarry` sets them on the restored database
    before the keeper or a machine reads it. The ranking's scope check (ruling 2) holds even without the carry, as after
    a total loss.

## Review Focus

1. A commit confirmed that the copy named at hornhoof.org lacks: sync cleared before the relay stored "off", "sync on"
   posted before the copy confirmed past W or before the setting held, a flag of `copy` or `relay_off` kept while
   neither holds, or a restart that clears the setting first. Tests in Task 7 (every row of `nextSyncStep`'s table,
   `never clears before off is stored`, `waits for the setting to hold`, `runs the barrier before W`) and Task 8
   (`confirms only what the copy holds`, `waits for the checkpointer before W`).
2. The company stuck: commits waiting for good on a sleeping copy, a lease that lapses while a copy is first made, a
   copy that cannot be made keeping the leader from writing, a keeper whose lease ended that can never get "off"
   stored, a copy judged silent by its clock. The silent copy is dropped within about 3 s; with the relay gone too the
   keeper fences within 20 s. Tests in Task 7 (`drops a silent copy`, `stops renewing when sync cannot be cleared`,
   `stays stopped until the copy answers`, `starts its link again to get off stored`, `times a reply by its own
   clock`) and Task 8 (`goes on alone when the copy stops`, `makes the first copy while the leader writes`).
3. Data where it must not be: a copy on a machine whose owner does not see the whole company, also after a restore; a
   worker or a machine that left holding a secret or rows; an upload left on either side or run as SQL on the
   leader. Tests in Task 2 (`gives data only to whole-company people's fit computers`), Task 3 (`takes the data away
   at once`), Task 9 (`keeps who holds the data and the link`) and Task 10 (`wipes the database, the dumps and the
   secrets`, `keeps no part`, `refuses what is not a table's data`).
4. A database thrown away before it is merged: a remade copy's old database dropped before its merge, a wiped
   machine's before its upload is merged and its fork bundle recorded, a database that once held a term dropped at
   all, a wipe that stops halfway and is forgotten. Tests in Task 9 (`swaps only after the merge`, `keeps a database
   that led`, `compares across a restore`) and Task 10 (`wipes only after the upload is kept`, `never wipes a database
   that led`, `goes on with a wipe that failed`).
5. A copy that drifts without anyone seeing it: rows that do not fit, a slot lost to `max_slot_wal_keep_size`, a
   restore on the leader, a migration on the leader, a copy behind shown as up to date. The copy remakes itself and
   its card says so. Tests in Task 8 (`loses a slot to the WAL limit`), Task 9 (`remakes after its slot is lost`,
   `remakes after a migration`), Task 11 (`catching_up` in `copies-view.test.ts`) and Task 12's restore step.

---

### Task 1: The columns and tables for copies

**Repo:** the `network` worktree, branch `network`. **Starts from:** plan 8's last task committed there. **Done when:**
from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/migrations.test.ts test/lease-store.test.ts
test/orchestrator-control.test.ts test/merge-rules.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`machines`, `publicLinks`), `apps/server/src/modules/merge/rules.ts`
  (`BOOKKEEPING`)
- Create: `apps/server/drizzle/0055_copies.sql` (and its `meta` entries, as drizzle-kit writes them)
- Test: `apps/server/test/migrations.test.ts`, `apps/server/test/lease-store.test.ts`,
  `apps/server/test/orchestrator-control.test.ts`, `apps/server/test/merge-rules.test.ts`

**Interfaces:**
- Produces, on `machines` in `schema.ts` (each with a one-line comment in the file's voice):
  ```ts
  serverOrder: integer('server_order'),                 // 1 to N, null for a machine with no number (spec 3.3)
  serverPin: text('server_pin'),                        // null, a place from 2, or 'none'; written by plan 9b
  serverWhy: text('server_why'),                        // a key the card turns into words: 'server', 'next'
  memory: bigint('memory', { mode: 'number' }),         // bytes Docker gives the machine, from its keeper's report
  cores: integer('cores'),
  copyState: text('copy_state', { enum: ['making', 'remaking', 'ready', 'stopped'] }),
  copyProgress: integer('copy_progress'),               // 0 to 99 while making
  copyError: text('copy_error', { enum: ['disk_full', 'apply', 'led', 'setup'] }),
  copyAt: timestamp('copy_at', { withTimezone: true }), // the leader's net.pulse.at the copy holds
  copyName: text('copy_name'),                          // its subscription's, slot's and application name
  copyOld: integer('copy_old'),                         // the attempt whose old database waits for its merge
  dataLeftAt: timestamp('data_left_at', { withTimezone: true }),
  uploadState: text('upload_state', { enum: ['waiting', 'received', 'kept'] }),
  ```
  with `uniqueIndex('machines_server_order').on(t.serverOrder)`, `uniqueIndex('machines_server_pin').on(t.serverPin)
  .where(sql\`server_pin <> 'none'\`)`, `check('machines_server_order_range', sql\`server_order >= 1\`)`,
  `check('machines_server_pin_value', sql\`server_pin = 'none' OR CASE WHEN server_pin ~ '^[1-9][0-9]{0,2}$' THEN
  server_pin::int >= 2 ELSE false END\`)` (the `CASE`, so `'x'` fails the check rather than the cast),
  `check('machines_copy_progress_range', sql\`copy_progress BETWEEN 0 AND 99\`)`, and one check each that
  `copy_state`, `copy_error` and `upload_state` are null or one of their values (drizzle's `enum` option types the
  column but makes no constraint). On `publicLinks`: `nextKeyEnc: text('next_key_enc')`, the key a change is under
  way to, sealed as `key_enc` is (ruling 20).
- The hand-written part of `0055_copies.sql`, after the generated statements:
  ```sql
  CREATE TABLE net.pulse (id boolean PRIMARY KEY DEFAULT true CHECK (id), at timestamptz NOT NULL);
  CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.pulse
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
  ALTER TABLE net.merges DROP CONSTRAINT merges_source_check;
  ALTER TABLE net.merges ADD CONSTRAINT merges_source CHECK (source ~ '^(kept|machine|upload):.+$');
  ALTER TABLE net.merges ADD COLUMN machine uuid;
  ```
  `merges_source_check` is the name Postgres gave plan 8's inline check; when the migrated database names it
  otherwise, the agent stops and reports.
- `BOOKKEEPING.machines` (plan 8's ruling 6) gains `server_order`, `server_why`, `memory`, `cores`, `copy_state`,
  `copy_progress`, `copy_error`, `copy_at`, `copy_name`, `copy_old`, `data_left_at` and `upload_state`: the leader
  recomputes or reports each, so none is ever a conflict. `server_pin` is compared, as the spec says.

- [ ] **Step 1: Write failing tests.**
  - `migrations.test.ts`, `migration 0055`, `adds the server order and the copy's columns`: after migrating fully, the
    columns exist; two rows with `server_order` 2 fail with `23505`, `server_order` 0 with `23514`; two with
    `server_pin` `'none'` both go in, two with `'2'` fail with `23505`, `'1'` and `'x'` fail with `23514`;
    `copy_state` `'other'`, `copy_error` `'other'`, `upload_state` `'other'` and `copy_progress` 100 fail with
    `23514`; a second `net.pulse` row fails; a `net.merges` row with the source `upload:hornhoof_upload_x` and a
    `machine` goes in, one with `other:x` fails with `23514`.
  - `lease-store.test.ts`, `names what keeps it from leading`: on the fixture `problems()` does not name `net.pulse`;
    after `DROP TRIGGER net_fence ON net.pulse` it has `net.pulse has no fence trigger`.
  - `orchestrator-control.test.ts`, `stays out of the pulse`: the orchestrator's `SELECT * FROM net.pulse` fails with
    `42501`.
  - `merge-rules.test.ts`, `never compares what the leader recomputes`: `BOOKKEEPING.machines` holds the twelve
    columns above and not `server_pin`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `schema.ts`, `npx drizzle-kit generate --name copies`, the hand-written part appended
  after a `--> statement-breakpoint`, and `rules.ts`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the server order's columns, the copy's report columns and the pulse".

### Task 2: Who may hold data, and the order

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/copies-order.test.ts test/network-routes.test.ts
test/network-join.test.ts test/keeper.test.ts test/worker-keeper.test.ts` passes, then the whole server suite; `npx
tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/copies/qualify.ts`, `apps/server/src/modules/copies/order.ts`
- Modify: `apps/server/src/modules/network/routes.ts` (the report), `apps/server/src/modules/network/join.ts`
  (`DataMachine`), the keeper's `Measures` (plan 5) and both keepers' reports, the place that starts and stops plan
  8's `Merger` with the app's lead (`apps/server/src/app.ts`: the `Ranking` beside it, `Ctx.ranking`)
- Test: `apps/server/test/copies-order.test.ts` (new), `apps/server/test/network-routes.test.ts`,
  `apps/server/test/network-join.test.ts`, `apps/server/test/keeper.test.ts`, `apps/server/test/worker-keeper.test.ts`

**Interfaces:**
- Consumes: Task 1's columns; `findThisMachine` (plan 5); `public_links`.
- Produces:
  ```ts
  // modules/copies/qualify.ts
  export const MEMORY_MIN = 3.5 * 2 ** 30;
  export const DISK_SPARE = 10 * 2 ** 30;
  export const FSYNC_MAX_MS = 50;
  export const REPORT_FRESH_MS = 120_000;
  export type Unfit =
    | { why: 'phone' } | { why: 'no_core' } | { why: 'scope'; person: string } | { why: 'no_link' }
    | { why: 'measuring' } | { why: 'memory'; memory: number } | { why: 'disk'; free: number; need: number }
    | { why: 'fsync'; p99: number };
  export type Candidate = { id: string; kind: string; networkId: string | null; server: boolean;
    role: MachineRole | null; createdAt: Date; reportAt: Date | null; memory: number | null; diskFree: number | null;
    fsyncP99Ms: number | null;
    owner: { isOwner: boolean; company: boolean; active: boolean; name: string } };
  //   server: machine_key starts with 'server:'
  export function unfit(m: Candidate, o: { dbSize: number; link: boolean; now: Date }): Unfit | null;
  //   ruling 3's checks in its order; need is 3 * dbSize + DISK_SPARE
  // modules/copies/order.ts
  export const COPIES = 2;                      // numbers 2 and 3
  export const RANK_EVERY_MS = 60_000;
  export type Ranked = { id: string; number: number | null; why: 'server' | 'next' | null; data: boolean;
    leave?: true };   // a data row whose person fails the scope check: no number; Task 3 takes its data away
  export function rankOf(all: Candidate[], o: { leader: string; dbSize: number; link: boolean; now: Date }): Ranked[];
  export function candidates(db: Db): Promise<Candidate[]>;     // the live machines with their owners
  export function rank(ctx: Ctx, now?: Date): Promise<{ changed: number }>;
  export class Ranking {
    constructor(ctx: Ctx, opts?: { everyMs?: number });
    start(): void;   // with the app's lead, as plan 8's Merger; ranks at once, then each everyMs
    stop(): void;
    now(): void;                                // a rank as soon as the one running ends; one more at most
  }
  // app.ts: Ctx gains ranking: Ranking
  // modules/network/join.ts: DataMachine gains number: number | null and copyName: string | null
  ```
- `rankOf`, pure: the leader's row is 1 with `why` `server` and `data` true. Then group one, the other live rows of the
  role `data` whose person passes the scope check (the others are `leave`), and group two, every other row `unfit`
  passes; each group by `owner.isOwner` first, then `owner.company`, then the older `createdAt`, then the id; numbers
  from 2 in that order, group one first. A row with a number of 2 or 3 is `data`; from 4 on `why` is `next`; an unfit
  row has no number. Rows of group one keep `data` whatever their number (at most 2 exist).
- `rank`: in one transaction, the live `machines` rows `FOR UPDATE`, `dbSize` from
  `pg_database_size(current_database())` and `link` from whether `public_links` has a row; `rankOf`; then every row
  whose `server_order`, `server_why` or role changes: first `server_order` null on all of them, then the new values, so
  two numbers that swap never meet the unique index. A row that becomes `data` gets the role `data` and nothing else
  here. `changed` counts the rows written. A throw is one log line; the next minute tries again.
- `POST /api/network/report` takes also `memory` (an integer of at least 0) and `cores` (1 to 4096). `Measures`'
  snapshot gains `memory: os.totalmem()` and `cores: os.availableParallelism()`, and both keepers send them.
- `GET /api/network/peers`' `data` items carry `number` (`server_order`) and `copyName`.

- [ ] **Step 1: Write failing tests.**
  - `copies-order.test.ts`, `rankOf` on candidates the test builds, with `dbSize` 1 GiB, `link` true and fresh reports
    (memory 8 GiB, disk 100 GiB, fsync 3 ms) unless a case says:
    - `numbers the leader 1 and fit machines from 2 by owner, then age`: the leader L; A of the CEO made on day 3, B of
      a whole-company person made on day 1, C of the CEO made on day 5: L 1 `server`, A 2, C 3, B 4 `next`; A and C
      `data`, B not.
    - `keeps the machines that hold a copy ahead`: B with the role `data` already: B 2, A 3, C 4.
    - `marks a copy whose person no longer sees the whole company`: B with the role `data` and a `listed` person: no
      number and `leave`; A 2, C 3.
    - `gives data only to whole-company people's fit computers`: one row per reason, each with no number and its
      `unfit`: a phone (`phone`), a computer with no `network_id` (`no_core`), a listed person's (`scope`, with the
      person's name), a report 3 minutes old (`measuring`), memory 3 GiB (`memory`), disk 12 GiB (`disk`,
      `need` 13 GiB), fsync 50 ms (`fsync`); a disabled person's machine is `scope`.
    - `takes 4 GB as Docker reports it`: memory 3.8 GiB passes.
    - `gives no copy without a link`: `link` false: only L has a number; the others `no_link`.
  - `copies-order.test.ts`, on `testApp` leading, with machines inserted for its people and fresh reports:
    - `writes only what changes`: `rank` gives the numbers above with `changed` 3, then `changed` 0; the rows of 2 and
      3 have the role `data`.
    - `swaps two numbers without a clash`: after A's `created_at` is made later than C's, `rank` answers without an
      error and gives C 2, A 3.
    - `ranks every minute while it leads`: a `Ranking` with `everyMs` 100 numbers a machine whose report turns fresh
      within 300 ms; stopped, it writes nothing more.
  - `network-routes.test.ts`, `stores memory and cores`: a report with both sets the columns; `cores` 0 answers 400.
  - `network-join.test.ts`, `names each data machine's number and copy`: a worker's view lists the leader with
    `number` 1 and `copyName` null.
  - `keeper.test.ts` and `worker-keeper.test.ts`, `reports memory and cores`: the row gets `os.totalmem()` and
    `os.availableParallelism()`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the two files, the report's fields, `Measures` and the `Ranking`'s start and stop.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Number the machines that may hold the company's data, and give the first three the data
  role".

### Task 3: Losing whole-company scope, and the link a copy needs

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/copies-scope.test.ts test/copies-order.test.ts
test/people.test.ts test/nodes.test.ts test/link.test.ts test/relay-client.test.ts test/fake-relay.test.ts` passes,
then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/copies/scope.ts`
- Modify: `apps/server/src/modules/people/routes.ts` (`PATCH /api/people/:id`),
  `apps/server/src/modules/nodes/disconnect.ts`, `apps/server/src/modules/link/link.ts` (`startKey`, `finishKey`,
  `remove`), `apps/server/src/modules/link/relay.ts` (`changeKey`'s `next`), `apps/server/test/fake-relay.ts` (R6.1's
  `key`), `apps/server/src/modules/copies/order.ts` (`rank` acts on `leave`), `apps/server/src/errors.ts` (reasons
  `leader_scope`, `link_needed`, `try_again`)
- Test: `apps/server/test/copies-scope.test.ts` (new), `apps/server/test/copies-order.test.ts`,
  `apps/server/test/people.test.ts`, `apps/server/test/nodes.test.ts`, `apps/server/test/link.test.ts`,
  `apps/server/test/relay-client.test.ts`, `apps/server/test/fake-relay.test.ts`

**Interfaces:**
- Consumes: `revokeMachineRows`, `dropPeerSecrets`, `visitorKeyOf`, `disconnectMachines` (plan 5b); `findThisMachine`
  (plan 5); the relay client's `changeKey` and `route` (plan 1); `Ranking.now`, `Ranked.leave` (Task 2).
- Produces:
  ```ts
  // modules/copies/scope.ts
  export const CUT_TRIES_MS = 5_000;
  export function leavingData(db: Db, personId: string): Promise<{ id: string; copyName: string | null }[]>;
  //   the person's live machines of the role data; throws ApiError(409, 'conflict', '<hostname> runs the company
  //   server. Move the server to another machine first.', 'leader_scope') when one is findThisMachine's row
  export function cutReplication(db: Db, machines: { id: string; copyName: string | null }[]): Promise<void>;
  //   for each slot copy_<that machine's 16 hex>_%: pg_terminate_backend of its active_pid, then
  //   pg_drop_replication_slot, again until none is left or CUT_TRIES_MS passed; then throws ApiError(503,
  //   'unavailable', 'Try again in a minute.', 'try_again')
  export function leaveData(tx: Tx, machineIds: string[], now: Date): Promise<void>;
  //   ruling 10's row changes, each certificate of theirs revoked, dropPeerSecrets(tx) when any, and
  //   links.startKey(tx)
  export function afterLeave(ctx: Ctx): Promise<void>;
  //   links.finishKey(), visitorKeyOf(ctx, { force: true }) and ranking.now(); each failure one log line
  // modules/link/link.ts: PublicLinks gains
  startKey(tx: Tx): Promise<void>;     // next_key_enc set to a new key (32 random bytes, base64url), sealed as key_enc,
                                       //   unless one is set already
  finishKey(): Promise<'done' | 'none' | 'later'>;   // ruling 20, one try; 'none' when no next_key_enc
  // modules/link/relay.ts: changeKey(name: string, key: string, next?: string): Promise<string>;
  //   body { key: next }
  // test/fake-relay.ts: POST /api/v1/links/:name/key takes an optional { key } (43 base64url) and sets it, as plan
  //   1's addendum: another form 400 invalid, the current key 400 same_key;
  //   loseAnswer: boolean (true: the key changes and the answer is a dropped connection)
  ```
- `PATCH /api/people/:id`, when the patch turns a person's `scope_kind` from `company` to `listed`: `leavingData` and
  `cutReplication` before its transaction; in it, `leaveData` after `saveAccess`; after it commits, `afterLeave` when
  any machine left. A disable goes on through `disconnectMachines`.
- `disconnectMachines`, for machines of the role `data`: `cutReplication` before its transaction; in it,
  `data_left_at` now and `links.startKey(tx)`; after it, `afterLeave`.
- `rank` (Task 2): each row `rankOf` marks `leave` goes through `cutReplication`, `leaveData` and `afterLeave` as
  above, after the ranking's own transaction; and while `public_links.next_key_enc` is set, `finishKey()` each time.
- `PublicLinks.remove`, before the relay: while a live row of the role `data` other than `findThisMachine`'s exists,
  `ApiError(409, 'conflict', 'Machines keep copies of the company through its link, so it stays.', 'link_needed')`.

- [ ] **Step 1: Write failing tests.**
  - `copies-scope.test.ts`, on `testApp` leading with the fake relay and a link, a whole-company person P with two
    machines, D of the role `data` (number 2, a live certificate, `copy_name` `copy_<d16>_1`) and W a worker, and
    another person's copy E; the replication catalogs read through a fake the test sets:
    - `takes the data away at once`: `PATCH` of P's access to one department answers 200; D has no number, the role
      `worker`, `data_left_at` and `upload_state` `waiting`, and its certificate's serial is in `revokedSerials`; no
      `peer_secrets` row of the kinds `data`, `app` or `visit` is left; the fake relay saw one `changeKey` with a body
      `key`, the stored key is that key and `next_key_enc` is null; it saw `visitorKey`; plan 7's `activeRecovery` is
      null.
    - `cuts the copy before anything new is written`: the fake saw D's walsender ended and `copy_<d16>_1` dropped
      before the transaction began, and the new key appears first in that transaction's `next_key_enc`.
    - `answers try again when the slot will not go`: a slot that stays active for `CUT_TRIES_MS`: 503, and P's scope,
      D's row and the secrets are as they were.
    - `leaves the rest alone`: W and E are as they were.
    - `refuses to take the server's scope`: with D made `findThisMachine`'s row (its `network_id` the app's machine
      id), the patch answers 409 `leader_scope` naming D's hostname, nothing was cut, and P's scope, D's row and the
      secrets are as they were.
    - `finishes a key change after a lost answer`: with `loseAnswer` once, the next `rank` reads the route with the new
      key, adopts it and clears `next_key_enc` without a second `changeKey`; with the relay down once, the next `rank`
      asks again.
  - `copies-order.test.ts`, `takes the data from a row a restore brought back`: a data row whose person is `listed`:
    `rank` cuts it and leaves it as above.
  - `people.test.ts`, `disables as before`: a disabled person's machines are disconnected, as plan 5b tests it.
  - `nodes.test.ts`, `changes the link key when a data machine is disconnected`: Disconnect of E cuts its slot first,
    sets its `data_left_at` and changes the key once; Disconnect of W does neither.
  - `link.test.ts`, `keeps the link while copies need it`: with E listed, removing the link answers 409
    `link_needed` and the relay saw nothing; with no other data machine it goes as today.
  - `relay-client.test.ts` and `fake-relay.test.ts`, `sets the key it is given`: `changeKey(name, key, next)` answers
    `next`, the old key is refused and `next` works; a `next` of 42 characters answers 400 `invalid` and the current
    key 400 `same_key`, each leaving the key as it was.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `scope.ts`, the routes' calls, `PublicLinks`, the client and the fake relay.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Take the data role away at once when a scope is lost, cut the machine first, and change the
  link key by a key chosen here".

### Task 4: The data link: doors, the replica role and the leader's dialer

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 3 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/db-door.test.ts test/peer-link.test.ts
test/peer-server.test.ts test/visit-client.test.ts test/keeper.test.ts test/network-routes.test.ts` passes, then the
whole server suite; from the worktree root `npm run test:real` passes; `npx tsc -p apps/server/tsconfig.json
--noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/net/db-door.ts`, `apps/server/src/modules/keeper/replica.ts`
- Modify: `apps/server/src/net/peer-link.ts` (`connectDb`), `apps/server/src/net/peer-server.ts` (`dbBytes`),
  `apps/server/src/modules/link/visit-client.ts` (the `data` kind), `apps/server/src/modules/keeper/keeper.ts` (the
  leading keeper's replica role, publication, dialer and doors; `KEEPER_PORTS.db`),
  `apps/server/src/modules/network/routes.ts` (`doors` in the own answer), `apps/server/src/app.ts` (`doorsWanted`)
- Test: `apps/server/test/db-door.test.ts` (new), `apps/server/test/peer-link.test.ts`,
  `apps/server/test/peer-server.test.ts`, `apps/server/test/visit-client.test.ts`, `apps/server/test/keeper.test.ts`,
  `apps/server/test/network-routes.test.ts`, `apps/server/test/real/replica.test.ts` (new)

**Interfaces:**
- Consumes: `PeerLink`, `DialTarget`, `visitConfigFor`, `visitClientFor`, `TunnelKeeper` (plans 2 and 5b);
  `PeerServer`, `DB_AUTHORITY` (plan 5); `keeperSql`, `Sql` (plan 3).
- Produces:
  ```ts
  // net/db-door.ts
  export const DB_DOOR_PORT = 7432;              // KEEPER_PORTS gains db: 7432
  export class DbDoor {
    constructor(opts: { connect: () => Promise<Duplex>; allowed: () => Promise<string[]>; log: (line: string) => void;
      host?: string; refreshMs?: number });
    //   allowed: read at listen and every refreshMs (60_000); host '0.0.0.0'
    listen(port: number): Promise<number>;       // answers the port
    close(): Promise<void>;                      // stops listening and destroys every open connection
  }
  export function composeAllowed(names?: string[]): () => Promise<string[]>;
  //   lookup(name, { all: true }) of each of names (['db', 'app']); a failed one adds none
  // net/peer-link.ts, PeerLink gains:
  connectDb(machine?: string): Promise<Duplex>;
  //   CONNECT db:5432 on that machine's session, else the leader's; 200 or it rejects
  // net/peer-server.ts, PeerServer gains:
  dbBytes(machine: string): number;              // bytes written to that machine on its CONNECT db streams since start
  // modules/link/visit-client.ts: VisitSettings gains dataSecret?: string; visitConfigFor and visitClientFor take
  //   kind?: 'app' | 'data' ('app'); 'data' visits `<name>-<target8>-data` with dataSecret, the visitor's name
  //   `<name>-<machine8>-to-<target8>-data`
  // modules/keeper/replica.ts
  export const REPLICA_ROLE = 'hornhoof_replica';
  export const PUBLICATION = 'hornhoof';
  export function replicaPassword(secret: Buffer): string;  // base64url of HMAC-SHA256 keyed by the secret's bytes
                                                            //   (Config.secret) over 'hornhoof-replica'
  export function scramVerifier(password: string, salt?: Buffer): string;
  //   'SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>' as RFC 7677 and Postgres make it; salt 16 random bytes
  export function replicaReady(sql: Sql): Promise<boolean>;
  //   the role exists and has USAGE on each of public, net, net_local and drizzle that this database has
  export function ensureReplica(connect: () => Promise<Sql>, password: string): Promise<void>;
  //   on a connection of its own, closed at the end whatever happens
  export function ensurePublication(sql: Sql): Promise<void>;
  // app.ts: Ctx gains doorsWanted(): Promise<string[]>, the network ids of the machines whose database a merge
  //   reads; [] until Task 9
  // KeeperOptions gains: dial?: PeerLink | null (made by keeper.ts); doorHost?: string ('0.0.0.0'); replicaEveryMs?:
  //   number (60_000); allowed?: () => Promise<string[]> (composeAllowed())
  ```
- `DbDoor`: each accepted socket whose remote address is not in the last `allowed()` answer is destroyed at once;
  else `connect()`, then both ways piped; a rejected connect destroys the socket with one log line, at most once a
  minute. Neither side's bytes are read or logged.
- `ensureReplica`, one `DO` block that holds `scramVerifier(password)`, never the password, quoted by `format('%L',
  ...)`: the role `LOGIN REPLICATION BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE` made when missing, else its
  password and those attributes set; `GRANT USAGE` on each of `public`, `net`, `net_local` and `drizzle` that exists,
  `GRANT SELECT ON ALL TABLES IN SCHEMA` of each, and `ALTER DEFAULT PRIVILEGES FOR ROLE <the database's owner> IN
  SCHEMA <each> GRANT SELECT ON TABLES TO hornhoof_replica`. `BYPASSRLS`, since the tables of `HIDDEN` keep row level
  security with no policy (plan 5's ruling 14) and a copy's first copy of them would else be empty.
- `ensurePublication`: `CREATE PUBLICATION hornhoof FOR TABLES IN SCHEMA public, net` when `pg_publication` lacks it.
- The leading keeper, while it leads: `ensureReplica` with `replicaPassword(config.secret)` at its first lead, then
  every `replicaEveryMs` when `replicaReady` is false; `ensurePublication` at the same times. With `dial`, it gives
  `dial.use` the data machines of its own `GET /api/network/peers` answer but its own row, each with `relayPort` from a
  visitor frpc (`TunnelKeeper`, kind `data`, the link's `dataSecret`) while the link is set. For each machine id in the
  answer's new `doors` it keeps one `DbDoor` on `doorHost` port 0 whose `connect` is `dial.connectDb(machine)`, closes
  the doors of ids no longer named, and writes `keeper.json`'s new `doors: Record<string, number>`. The own answer of
  `GET /api/network/peers` gains `doors: string[]`, from `ctx.doorsWanted()`.

- [ ] **Step 1: Write failing tests.**
  - `db-door.test.ts`, with a TCP echo as what `connect` reaches:
    - `passes what an allowed address sends`: from `127.0.0.1`, allowed, bytes come back.
    - `drops anyone else at once`: with `allowed` answering `['192.0.2.1']`, the socket closes before any byte, and
      `connect` was never called.
    - `closes when the far side is gone`: a `connect` that rejects closes the client's socket and logs one line; a
      second within the minute logs none.
    - `closes everything on close`: an open connection ends when `close()` resolves.
  - `peer-link.test.ts`, `reaches a data machine's db`: with plan 5's `PeerServer` of a data machine whose `db` is a
    TCP echo, a link holding a `data` certificate echoes through `connectDb()`; with `machine` naming a second data
    machine that does not lead, through that one's echo; a link holding a `worker` certificate gets a rejection
    (plan 5's 403).
  - `peer-server.test.ts`, `counts the bytes to each machine's db`: after 2 MiB echoed for a data machine M,
    `dbBytes(M)` is at least 2 MiB and `dbBytes` of another id 0.
  - `visit-client.test.ts`, `visits a data service with the data secret`: kind `data` writes `serverName =
    "<name>-<target8>-data"` and `secretKey` the data secret; kind `app` as before.
  - `keeper.test.ts`, `opens a door to a copy its app names`: a leading keeper with `dial` a `PeerLink` and an answer
    whose `doors` names M, whose `PeerServer` has a TCP echo as `db`: within 2 s `keeper.json`'s `doors[M]` is a port
    that echoes; with M no longer named, the door closes and `doors` is `{}`.
  - `network-routes.test.ts`, `names the doors its app wants`: the own answer has `doors` equal to `ctx.doorsWanted()`.
  - `real/replica.test.ts`, on a `realDatabase()` migrated:
    - `lets a copy read every table and write none`: after `ensureReplica(connect, pw)` twice, the role logs in with
      `pw`, reads rows of `companies`, `net.journal` and `authority` (row level security on, rows inserted as the
      owner), and its `INSERT` into `teams` fails with `42501`; `rolsuper` and `rolcreaterole` are false; after
      `ensureReplica(connect, pw2)` the old password fails; `pg_authid.rolpassword` starts `SCRAM-SHA-256$4096:`.
    - `publishes the company's schemas`: after `ensurePublication` twice, `pg_publication_namespace` of `hornhoof`
      names `public` and `net` and nothing else.
    - `keeps the password out of logs`: with `log_statement = 'all'` on the server, after a call that succeeds and one
      the observer ends midway (`pg_terminate_backend`), `pw` is in no line the keeper logged, in no line of the
      server's log, and in no `pg_stat_activity.query` read from a separate observer connection; the role still logs in
      with `pw`.
    - `knows when a database lacks the grants`: `replicaReady` is false in a new database of the same cluster where the
      role exists, and true after `ensureReplica` there.
    - `publishes only tables a copy can follow`: every table of `public` and `net` has a primary key; the test names
      any that lacks one, and the agent stops and reports rather than adding one.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the two files and the changes above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Carry a machine's database connections over the peer link, with a replica role that only
  reads".

### Task 5: Becoming a data machine

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 4 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/copies-routes.test.ts test/become.test.ts
test/worker-keeper.test.ts test/migrate.test.ts test/updater.test.ts test/compose.test.ts` passes, then the whole
server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing; `bash -n` and `shellcheck` on
`apps/updater/updater.sh` print nothing.

**Files:**
- Create: `apps/server/src/modules/copies/routes.ts`, `apps/server/src/modules/keeper/become.ts`
- Modify: `apps/server/src/app.ts` (`copiesRoutes`), `apps/server/src/modules/keeper/worker.ts` (runs `Becoming`),
  `apps/server/src/modules/network/join.ts` (`WorkerLink.dataSecret`), `apps/server/src/modules/network/routes.ts` (the
  certificate's role), `apps/server/src/errors.ts` (reasons `not_data`, `no_age_key`), `apps/server/src/migrate.ts`,
  `apps/updater/updater.sh`, `compose.yaml` (`migrate` mounts the control folder), `compose.worker.yaml`
- Test: `apps/server/test/copies-routes.test.ts` (new), `apps/server/test/become.test.ts` (new),
  `apps/server/test/worker-keeper.test.ts`, `apps/server/test/migrate.test.ts`, `apps/server/test/updater.test.ts`
  and its stubs, `apps/server/test/compose.test.ts`

**Interfaces:**
- Consumes: `askerOf`, `VIA`, `certFacts` (plan 5); `BundleSecrets`, `ageKey` and the `age-encryption` use of plan 7;
  `WorkerView`, `CertificateKeeper.renewNow` and `onChange`, `PeerLink.request`; `updater.sh`'s `env_value`,
  `owned`, `swap_updater`, `say` and plan 7's check of each bundle secret.
- Produces:
  ```ts
  // modules/copies/routes.ts
  export function copiesRoutes(app: FastifyInstance, ctx: Ctx): void;
  //   POST /api/network/secrets, through the peer link only (askerOf with VIA): a data certificate of a live row
  //   whose role is data, whose person passes Task 2's scope check and whose age_key is set answers 200 { sealed }
  //   (base64 of the age file of BundleSecrets as JSON, to that age_key alone); any other certificate 403 'not_data';
  //   no age_key 409 'no_age_key'; outside lead 503 as every write
  // modules/network/routes.ts: POST /api/network/certificate issues a data certificate only to a row of the role
  //   data whose person passes the scope check, a worker one otherwise
  // modules/keeper/become.ts
  export const REPLICA_FILE = 'replica.json';   // control folder: { since }, 0644; this machine keeps a copy
  export const ROLE_FILE = 'role.json';         // control folder: { id, secrets }, 0600, for the updater's become_data
  export const ROLE_FAILED = 'role.failed';     // control folder: one line from the updater
  export const ROLE_RETRY_MS = 3_600_000;
  export class Becoming {
    constructor(opts: { controlDir: string; link: PeerLink; certificates: CertificateKeeper;
      age: () => Promise<{ identity: string }>; log: (line: string) => void; now?: () => Date; retryMs?: number });
    step(view: WorkerView): Promise<'idle' | 'renewing' | 'asked' | 'failed'>;
    failure(): string | null;                   // role.failed's line until the next try, for the report
  }
  // migrate.ts
  export function migrateOrFollow(env: NodeJS.ProcessEnv, run: () => Promise<void>): Promise<'migrated' | 'follows'>;
  //   'follows' without calling run when <HORNHOOF_CONTROL_DIR or /control>/replica.json exists, after one line
  // modules/network/join.ts: WorkerLink gains dataSecret: string | null, set only in the view of a row whose role is
  //   data, asked with a data certificate
  ```
- `Becoming.step`, called with each merged view by a worker keeper only (the `WorkerKeeper` inside a follow keeper of
  Task 6 has no `Becoming`):
  - The view's `role` is not `data`, or `role.json` or `replica.json` is there: `idle`.
  - `role.failed` there: its line kept for `failure()`, the file removed, `failed`; nothing more until `retryMs` has
    passed since.
  - The held certificate's role is not `data`: `renewNow()` once per view, `renewing`.
  - Else `POST /api/network/secrets`, the answer opened with the keeper's age identity, each of the three checked as
    plan 7 checks a bundle's, then `replica.json` and after it `role.json` written (each whole, then moved), `asked`.
    A failure is one log line, and the next view tries again.
- `updater.sh` `become_data`, run by the loop after `handle_request` when `role.json` is there:
  1. `.env` copied to `.env.before-data` (0600).
  2. Each of the three secrets checked, then written into `.env`.
  3. `POSTGRES_PASSWORD` written when the line is missing or empty: 24 characters of `[A-Za-z0-9]` from
     `/dev/urandom`.
  4. `HORNHOOF_ROLE=data` and `COMPOSE_PROFILES=data` written, `role.json` removed.
  5. `HORNHOOF_ROLE=data compose up -d --no-build` naming every service of `compose config --services` but `updater`
     (the role set for compose itself, since the updater's environment holds the one it was started with and would
     win over `.env`).
  6. `swap_updater "$(own_image)"`, then `.env.before-data` removed.
  A failed check or `up` puts `.env.before-data` back as `.env`, removes `role.json` and `replica.json`, runs `compose
  rm -sf db migrate app` and `HORNHOOF_ROLE=worker compose up -d --no-build front keeper`, and writes `role.failed`
  "The company's settings cannot be written here, so this machine stays a worker." (0600), with one `say` line naming
  the step. No secret goes into a `say` line or `install.log`. At the loop's start, a `.env.before-data` left by an
  updater that stopped midway is finished: with `.env` saying `HORNHOOF_ROLE=data`, steps 5 and 6 again; else the
  failure's steps.
- `swap_updater` takes the image as its argument (an Update passes the pinned one as before); `own_image` answers the
  image of the updater's own container (`docker inspect` of its `hostname`). Each round, when the updater's own
  `HORNHOOF_ROLE` differs from `.env`'s, it runs `swap_updater "$(own_image)"`, at most once a minute, so a swap that
  failed is tried again.
- `update`, `pull_images` and `services_without_node` treat a machine as a worker (plan 5b) also while `replica.json`
  is there: no backup, no migrations, the turn waited for. Plan 9c brings a copy's own update order (ruling 1).
- `compose.worker.yaml`: `node` moves to `profiles: ["builtin"]` with a comment saying a copy runs no built-in node
  until each machine has its own node identity. `compose.yaml`: `migrate` mounts the control folder read-only at
  `/control` and gets `HORNHOOF_CONTROL_DIR: /control`.
- `migrate.ts`'s entry calls `migrateOrFollow(process.env, ...)`, whose line is "This machine keeps a copy; its schema
  comes from the company server." and exit code 0.

- [ ] **Step 1: Write failing tests.**
  - `copies-routes.test.ts`, on `testApp` leading, with a data machine D (an age key made at run time) and a worker W:
    - `seals the secrets to a copy alone`: D's data certificate through the peer link's headers gets `sealed`, which
      D's identity opens to the app's `HORNHOOF_SECRET`, `NODE_KEY` and `RELAY_URL`; another identity cannot open it.
    - `refuses everyone else`: W's certificate 403 `not_data`; D's row made `worker` with its old data certificate 403;
      D's person made `listed`, 403; a revoked D 401 as plan 5's asker says; no certificate 401; D without `age_key` 409
      `no_age_key`; the answer to each holds no secret.
  - `become.test.ts`, with a fake `PeerLink` and `CertificateKeeper` and a control folder in a temp dir:
    - `asks for a data certificate first`: a view with role `data` and a worker certificate held: `renewNow` once,
      `renewing`, no request.
    - `writes the marker before the request`: with a data certificate: `replica.json` exists, then `role.json` with
      the three secrets, mode 0600; the log holds none of them.
    - `waits an hour after a failure`: with `role.failed` there: `failed`, the file gone, `failure()` its line; a view
      30 minutes later does nothing; 61 minutes later it asks again.
    - `does nothing for a worker`: role `worker`: `idle`, no file.
    - `asks once`: with `role.json` or `replica.json` already there: `idle`, no request.
  - `worker-keeper.test.ts`, `becomes a data machine when its row says so`: a view with role `data` and a data
    certificate leads to `role.json` within 2 views.
  - `migrate.test.ts`, `leaves a copy's schema alone`: with `replica.json` in the control folder, `migrateOrFollow`
    answers `follows` and `run` was not called; without it, `migrated` after `run`.
  - `updater.test.ts` (its stubs):
    - `makes a worker a data machine`: `role.json` with three valid secrets: `.env` has them, a 24 character
      `POSTGRES_PASSWORD`, `HORNHOOF_ROLE=data`, `COMPOSE_PROFILES=data`; with the updater's own environment holding
      `HORNHOOF_ROLE=worker`, the compose stub saw `up -d --no-build` with `front`, `keeper`, `db`, `migrate` and `app`,
      not `updater`, and `HORNHOOF_ROLE=data` in its environment; then the helper's `up -d --no-build updater` on the
      image `docker inspect` gave for its own container (no Update ran before); `role.json` and `.env.before-data` are
      gone; no secret is in the log.
    - `keeps a password that is there`: a `.env` with `POSTGRES_PASSWORD=abc` keeps it.
    - `stays a worker when it cannot`: a `NODE_KEY` that fails plan 7's check, then `up` failing (`STUB_UP=fail`):
      each leaves the `.env` of before byte for byte, no `role.json` or `replica.json`, `role.failed` with the line,
      and the stub saw `rm -sf db migrate app`, then `up -d --no-build front keeper` with `HORNHOOF_ROLE=worker`.
    - `finishes what a restart cut short`: a `.env.before-data` and a `.env` saying `HORNHOOF_ROLE=data` at the loop's
      start: the `up` and the swap run, then the file goes; with a `.env` still a worker's: the failure's steps.
    - `swaps itself when its role is not the file's`: own `HORNHOOF_ROLE=worker`, `.env` `data`: one swap; a second
      round within the minute none.
    - `updates a copy as a worker`: with `replica.json`, an update makes no backup and waits its turn.
  - `compose.test.ts`: `compose.worker.yaml` gives `db`, `migrate` and `app` the profile `data` and `node` the profile
    `builtin`; `migrate` mounts the control folder read-only.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the files and changes above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let a worker become a data machine: its secrets sealed to it, its database started, no
  schema of its own".

### Task 6: The follow keeper and the first copy

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/follow-keeper.test.ts test/copy-maker.test.ts
test/keeper-role.test.ts test/worker-keeper.test.ts test/network-routes.test.ts test/network-join.test.ts
test/app-mode.test.ts test/updater.test.ts` passes, then the whole server suite; from the worktree root `npm run
test:real` passes; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing; `bash -n` and `shellcheck` on
`apps/updater/updater.sh` print nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/follow.ts`, `apps/server/src/modules/keeper/copy.ts`
- Modify: `apps/server/src/keeper.ts` (the role choice), `apps/server/src/modules/keeper/worker.ts` (its options and
  `parts()`), `apps/server/src/modules/keeper/worker-config.ts` (`followConfig`),
  `apps/server/src/modules/keeper/app-mode.ts` (`onChange`), `apps/server/src/modules/network/routes.ts` (the
  report's `copy`), `apps/server/src/modules/network/join.ts` (`WorkerView.copy`), `apps/server/src/main.ts` and
  `apps/server/src/db/agent-sql.ts` (grants and the start lines once the mode is not `off`), `apps/updater/updater.sh`
  (`schema_request`), `apps/server/test/real/pg.ts` (`realCluster`)
- Test: `apps/server/test/follow-keeper.test.ts` (new), `apps/server/test/copy-maker.test.ts` (new),
  `apps/server/test/keeper-role.test.ts` (new), `apps/server/test/worker-keeper.test.ts`,
  `apps/server/test/network-routes.test.ts`,
  `apps/server/test/network-join.test.ts`, `apps/server/test/app-mode.test.ts`, `apps/server/test/updater.test.ts`,
  `apps/server/test/real/copy.test.ts` (new), `apps/server/test/real/pair.ts` (new)

**Interfaces:**
- Consumes: `WorkerKeeper`, `workerConfig`, `CertificateKeeper` (plan 5b); `PeerServer`, `PeerServices`, `peerClientFor`
  (plan 5); `DbDoor`, `ensureReplica`, `replicaReady`, `replicaPassword`, `PUBLICATION`, `PeerLink.connectDb`, the
  `data` visit kind (Task 4); `REPLICA_FILE` (Task 5); `writeKeeperState`, `AppMode` (plan 2).
- Produces:
  ```ts
  // modules/keeper/copy.ts
  export const SCHEMA_FILE = 'schema.json';       // control folder: { attempt, database, port, password }, 0600
  export const COPY_STATE = 'copy-state.json';    // keeper dir: { attempt, database, phase, migrations?, stamp? },
                                                  //   0600
  export const ENABLE_FOR_MS = 600_000;           // a stopped subscription is enabled again for this long
  export const DISK_FULL = 2 ** 30;
  export type CopyReport = { state: 'making' | 'remaking' | 'ready' | 'stopped'; progress: number | null;
    error: 'disk_full' | 'apply' | 'led' | 'setup' | null; at: string | null; name: string | null;
    old: { attempt: number } | null };
  export type CopyOrder = { slot: 'ok' | 'lost' | 'missing' | null; leaderSize: number | null;
    migrations: number | null; old: 'waiting' | 'merged' | 'done' | null; upload: 'waiting' | 'wipe' | null };
  //   migrations: the rows of the leader's drizzle.__drizzle_migrations; old is Task 9's and upload Task 10's;
  //   until then null
  export function copyName(networkId: string, attempt: number): string;   // copy_<first 16 hex>_<attempt>
  export class CopyMaker {
    constructor(opts: { admin: Sql; db: (database: string) => Sql; controlDir: string; dir: string; networkId: string;
      password: string; diskFree: () => number | null; log: (line: string) => void; now?: () => Date;
      publisher?: { host: string; port: number } });
    //   admin: the owner's connection to the database postgres; db: a new connection of the owner's to a named one,
    //   ended by the caller; publisher: { host: 'keeper', port: 7432 } unless a test names the leader itself
    tick(order: CopyOrder | null): Promise<void>;   // one step of the work below; the keeper calls it each second
    report(): CopyReport;
    mode(): 'off' | 'read';
  }
  // modules/keeper/follow.ts
  export const OWN_APP_AFTER_MS = 60_000;
  export class FollowKeeper {
    constructor(opts: { config: FollowConfig; frontHost: string; appHost: string; log: (line: string) => void;
      now?: () => Date; worker?: Partial<ConstructorParameters<typeof WorkerKeeper>[0]>; ownAppAfterMs?: number });
    //   worker: the test's options for the WorkerKeeper inside it
    start(): Promise<{ front: number; door: number }>;
    status(): WorkerStatus & { copy: CopyReport };
    stop(): Promise<void>;
  }
  // modules/keeper/worker-config.ts
  export type FollowConfig = WorkerConfig & { secret: Buffer; databaseUrl: string };
  export function followConfig(env: NodeJS.ProcessEnv): FollowConfig;
  //   workerConfig plus HORNHOOF_SECRET, decoded and checked as loadConfig does, and DATABASE_URL, each required with
  //   a line
  // keeper.ts
  export function keeperRole(env: NodeJS.ProcessEnv, controlDir: string, hasSubscription: () => Promise<boolean>):
    Promise<'worker' | 'follow' | 'lead'>;
  //   HORNHOOF_ROLE worker: worker; else replica.json there or an enabled subscription in its database: follow;
  //   else lead
  // modules/keeper/worker.ts: WorkerKeeper's options gain role?: 'worker' | 'data' ('worker'); visitKind?: 'app' |
  //   'data' ('app'); ownApp?: { connect: () => Promise<Duplex>; afterMs: number }; extraReport?: () => object;
  //   onView?: (view: WorkerView) => void; and it gains parts(): { link: PeerLink; certificates: CertificateKeeper },
  //   the ones it runs, the same objects on each call after start
  // modules/keeper/app-mode.ts: AppMode gains onChange(hook: (from: Mode, to: Mode) => unknown): void, run on every
  //   change in the order registered, a throwing hook one log line, as whenLead's
  // test/real/pg.ts
  export function realCluster(opts: { network: string; name: string }): Promise<{ url: string; admin: pg.Client;
    host: string; exec(args: string[], stdin?: string): Promise<string>; close(): Promise<void> }>;
  //   a Postgres container of its own named name, of the image and command of compose's db (read from compose.yaml),
  //   on that Docker network and published on 127.0.0.1; host: its name there; exec: docker exec in it as postgres,
  //   stdin piped; close: docker rm -f
  // modules/network/join.ts: WorkerView gains copy: CopyOrder | null (null for a worker)
  ```
- `copyName` takes the network id's first 16 hex characters, lower case; it names the subscription, its slot and its
  walsender's application name.
- `CopyMaker.tick`, from `copy-state.json` (attempt 1 and database `hornhoof` when missing):
  1. The database named has a row in `net_local.state`: `stopped`, error `led`, nothing more (ruling 12). A database
     without that table has no row.
  2. Phase `schema`: when the database has a table in `public`, phase `grant`. Else `schema.json` with the attempt,
     the database, the publisher's port and `password`, unless one is there; then `schema/<attempt>.done` moves to
     phase `grant`, and `.failed` is one log line, the next attempt number, and a new `schema.json` 10 minutes later.
     Leaving the phase, its count of `drizzle.__drizzle_migrations` rows goes into `copy-state.json` as `migrations`.
  3. Phase `grant`: `ensureReplica(() => db(database), password)`, so a merge can read that database (ruling 6);
     phase `subscribe`.
  4. Phase `subscribe`: `ALTER SYSTEM SET wal_receiver_status_interval = '1s'`, `pg_reload_conf()`, then `CREATE
     SUBSCRIPTION <copyName> CONNECTION 'host=<publisher host> port=<its port> dbname=hornhoof user=hornhoof_replica
     passfile=<data_directory>/replica.pgpass' PUBLICATION hornhoof WITH (copy_data = true, synchronous_commit =
     'local', binary = false, streaming = off, disable_on_error = true)`, `data_directory` by `SHOW`, each name and
     literal quoted by `format`; phase `sync`. A subscription of that name already there counts as made.
  5. Phase `sync`: `making` with `progress` the database's `pg_database_size` over `order.leaderSize`, floored, at most
     99; every row of `pg_subscription_rel` for it at `r`: phase `ready`.
  6. Phase `ready`: `at` is `net.pulse.at`. A subscription with `subenabled` false: `ALTER SUBSCRIPTION ... ENABLE`
     once a minute; the report `stopped` with `disk_full` while `diskFree()` is under `DISK_FULL`, else `apply`;
     enabled again and holding, `ready`. Over `ENABLE_FOR_MS` disabled: Task 9's remake.
  7. Giving an attempt up, in phase `sync` when its subscription stayed disabled for `ENABLE_FOR_MS` (`ENABLE` once a
     minute, as in phase `ready`) or the order's `slot` is `lost`: the next attempt number and phase `drop` go into
     `copy-state.json` first; then, each skipped when done, `ALTER SUBSCRIPTION ... DISABLE`, `ALTER SUBSCRIPTION ...
     SET (slot_name = NONE)` and `DROP SUBSCRIPTION`; the maker's connections to the database ended; `DROP DATABASE
     ... WITH (FORCE)` when it holds no `net_local.state` row, and `CREATE DATABASE` of that name; phase `schema`,
     whose `schema.json` waits 10 minutes from the giving up. The leader drops the detached slot and the attempt's
     table sync slots (Task 7).
  - `mode()`: `off` until the first `ready`, then `read`; Task 9 adds the swap. `report().name` is the attempt's
    `copyName` from phase `schema` on, so the leader never takes a new slot for a stale one.
- `updater.sh` `schema_request`, after `become_data` in the loop, when `schema.json` names an attempt with no
  `schema/<attempt>.done` or `.failed`: `schema/` made 0700; `pg_dump -h keeper -p <port> -U hornhoof_replica
  --schema-only --no-owner --no-publications --no-subscriptions --no-privileges hornhoof` and `pg_dump ... --data-only
  --table=drizzle.__drizzle_migrations hornhoof`, both in `db` with `-e PGPASSWORD` (the name only, the value in that
  one command's environment), into one file under umask 077; the database named counted for tables in `public` (any:
  `.failed` "The database is not empty."); `psql -1 -v ON_ERROR_STOP=1 -d <database>` with the file; the file
  removed; the passfile `"$PGDATA/replica.pgpass"` written in `db` as `postgres` under umask 077 from standard input,
  the line `*:*:*:hornhoof_replica:<password>`; `.done` or `.failed` with the reason (0600); `schema.json` removed.
  The password is in no argument, `say` line or file but `schema.json` and the passfile.
- `FollowKeeper.start`, in order: `ensureReplica` with `replicaPassword(config.secret)` on the database it reads, at
  start and then each minute while `replicaReady` is false there (a failure is one log line); a `WorkerKeeper` with
  `role: 'data'`, `visitKind: 'data'`, `ownApp` (the own `app:8080` after `OWN_APP_AFTER_MS` with no leader),
  `extraReport` (`{ copy: maker.report() }`) and `onView` (the view's `copy` kept for the maker); a `PeerServer` as
  the data keeper's of plan 5, on the certificates of `worker.parts()`, with `hello` `lead: false` and `CONNECT db`
  and `app` to its own; a peer frpc of its own `-data` and `-app` services with the view's link secrets; a `DbDoor`
  on `KEEPER_PORTS.db` whose `connect` is `worker.parts().link.connectDb()`; the maker's `tick` each second;
  `keeper.json` each second with the maker's `mode()` and `link: null`. It never takes a lease and never runs the
  link frpc.
- The worker keeper's report carries `copy` `{ state: 'stopped', progress: null, error: 'setup', at: null, name:
  null, old: null }` while `Becoming.failure()` has a line.
- `POST /api/network/report` takes `copy` (the `CopyReport` shape, zod) only from a data certificate and writes
  `copy_state`, `copy_progress`, `copy_error`, `copy_at`, `copy_name` and `copy_old`; from a worker it is dropped.
  `workerView` of a data row gains `copy`: `slot` from `pg_replication_slots` by the row's `copy_name` (`missing`
  without one, `lost` when `wal_status` is `lost`), `leaderSize` from `pg_database_size`, `migrations` the count of
  `drizzle.__drizzle_migrations`.
- The app with a keeper: `openAgentSql`'s grants and revokes run on each change of `ctx.mode` from `off` to another
  mode (`onChange`), not at process start, and the agent tools answer `starting` until the first run ends. `main.ts`'s
  `Hornhoof is running at` line and `setupLink` run once, at the first such change, not after `listen`, so an app on
  an empty database waits in `off` and does not exit. Without a keeper all of them run as today.

- [ ] **Step 1: Write failing tests.**
  - `keeper-role.test.ts`: `worker` for `HORNHOOF_ROLE=worker` whatever else; `follow` with `replica.json`, and with
    an enabled subscription and no file; `lead` with neither.
  - `copy-maker.test.ts`, with `createTestSql` and fakes for the subscription's catalogs:
    - `asks for the schema once`: an empty `hornhoof`, with no `net_local` schema: `schema.json` with attempt 1, port
      7432, mode 0600; a second tick writes nothing new; `report()` is `making`, `name` `copy_<16 hex>_1`, mode `off`.
    - `tries again with the next attempt`: `schema/1.failed`: a log line; at 10 minutes `schema.json` with attempt 2.
    - `subscribes with these options`: after `schema/1.done`, the statements run are `ensureReplica`'s, `ALTER SYSTEM
      SET wal_receiver_status_interval = '1s'`, `SELECT pg_reload_conf()` and `CREATE SUBSCRIPTION` with the five
      options, `user=hornhoof_replica` and `passfile=`; no statement and no log line holds the password;
      `copy-state.json` has the database's count of migrations.
    - `counts its progress`: a database at 3 MiB and `leaderSize` 4 MiB: 75; at 5 MiB: 99.
    - `finishes when every table is ready`: `ready` and mode `read` once every `pg_subscription_rel` row is `r`.
    - `tells a full disk from a broken apply`: a disabled subscription with `diskFree` 500 MiB: `stopped`,
      `disk_full`; with 50 GiB: `apply`; `ENABLE` tried once a minute.
    - `never touches a database that led`: a `net_local.state` row: `stopped`, `led`, no statement but reads.
    - `gives a failed attempt up whole`: in phase `sync`, a subscription disabled for 10 minutes: `copy-state.json`
      has attempt 2 and phase `drop` before the first statement, then `DISABLE`, `SET (slot_name = NONE)`, `DROP
      SUBSCRIPTION`, `DROP DATABASE ... WITH (FORCE)` and `CREATE DATABASE`, in this order; a maker made again over
      the same files after the `DISABLE` goes on from the `SET`; `schema.json` with attempt 2 only 10 minutes later.
  - `follow-keeper.test.ts`, with plan 5b's worker fixture and a temp control folder:
    - `takes no lease and runs no link`: after start, no lease row, no link frpc child, `keeper.json` says `off`.
    - `opens a door to the leader's database`: a TCP connection to the door from `127.0.0.1` reaches the leader's
      `db` echo through `connectDb`.
    - `reads by itself when the leader is gone`: with no leader for `OWN_APP_AFTER_MS` (100 ms in the test), a page
      request through the front door reaches the own app's echo; with the leader back, the leader's.
    - `reports its copy`: the report body has `copy` from the maker.
  - `network-routes.test.ts`, `keeps the copy's report`: a data certificate's `copy` sets the six columns; a worker's
    sets none; `progress` 100 answers 400.
  - `worker-keeper.test.ts`, `says when it could not become a data machine`: with `role.failed` there, the next
    report's `copy` is `stopped` with `setup`; `shows its parts`: after start, two calls of `parts()` give the same
    link and certificate keeper, and the link is the one its reports went through.
  - `network-join.test.ts`, `tells a copy about its slot`: a data row with `copy_name` and no slot: `slot` `missing`;
    a worker's view has `copy` null and `dataSecret` null.
  - `app-mode.test.ts`, `grants once the keeper speaks`: with a keeper, no grant runs before the first `read`; after
    it the agent role reads `tasks`; a second `off` and `read` runs them again; `onChange` hooks get `from` and `to`,
    in the order registered, and one that throws is a log line that stops neither the next nor the change.
  - `updater.test.ts`, `loads a copy's schema`: `schema.json` naming attempt 1: the stub saw both `pg_dump` with
    `-h keeper -p 7432 -U hornhoof_replica` and the flags above, `psql -1 -v ON_ERROR_STOP=1`; `schema/1.done`;
    `schema.json` and the dump file gone; the passfile's line went in on standard input; the password in no
    argument the stub saw and no log line; with the stub's table count 1, `.failed` "The database is not empty." and
    no `psql`.
  - `real/pair.ts`: `pair()` starts two `realCluster`s on a Docker network of its own, migrates the first, makes the
    replica role and the publication there, plays the updater's `schema_request` on the second by `exec` for each
    `schema.json` its `CopyMaker` writes in a temp control folder (the two `pg_dump` lines, `psql`, the passfile), and
    gives that `CopyMaker` on the second the `publisher` the first's `host` and port 5432, not a door (the door's path
    is the lab's, Task 12); `close()` removes both and the network. `real/copy.test.ts`, `makes a copy that holds
    every row`: within 60 s every `pg_subscription_rel` row is `r` and every table's rows equal the first's, the
    `HIDDEN` tables included; an insert into `tasks` on the first is on the second within 2 s; the second's
    `net.journal` has no row the first lacks, and its `net_local.state` none; `hornhoof_replica` with its password
    reads `net.journal` and `net_local.state` on the second.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the files and changes above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Run a data machine that does not lead as a follower, which copies the company's database and
  keeps it".

### Task 7: The sync controller

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 6 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/sync-step.test.ts test/sync.test.ts
test/keeper.test.ts test/lease-store.test.ts test/slots.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/sync-step.ts`, `apps/server/src/modules/keeper/sync.ts`,
  `apps/server/src/modules/keeper/slots.ts`
- Modify: `apps/server/src/modules/keeper/keeper.ts` (the controller, the pulse, the slots, the flag, the link frpc at
  lease end, `keeper.json` `copies`), `apps/server/src/modules/keeper/lease-store.ts` (`take`, `renew`, `prune`),
  `apps/server/test/fake-lease.ts` (`take` and `renew` record their `sync`)
- Test: `apps/server/test/sync-step.test.ts` (new), `apps/server/test/sync.test.ts` (new),
  `apps/server/test/slots.test.ts` (new), `apps/server/test/keeper.test.ts`, `apps/server/test/lease-store.test.ts`

**Interfaces:**
- Consumes: the relay client's `route` and `setSync`, `Route`, `SyncRecord`, `SyncPost` (plan 1); `LeaseStore`,
  `LeaseSync`, `keeperSql`, `nextLeaseStep`, `fakeLease` (plan 3); `othersHoldData` (plan 5); `PeerServer.dbBytes` (Task
  4); `copyName` (Task 6).
- Produces:
  ```ts
  // modules/keeper/sync-step.ts
  export const SAMPLE_EVERY_MS = 250;
  export const SILENT_REPLY_MS = 2_000;
  export const SLOW_WAIT_MS = 1_000;
  export const SLOW_FOR_MS = 5_000;
  export const SLOW_BYTES = 1_048_576;
  export const PACE_MS = 1_000;
  export const PACE_FOR_MS = 30_000;
  export const STOP_RENEW_MS = 10_000;
  export type Flag = LeaseSync | null;
  export type CopySample = { machine: string; networkId: string; number: number; name: string; finished: boolean;
    keptPaceMs: number; replyAgeMs: number | null; confirmed: string | null; syncState: string | null };
  //   confirmed: the slot's LSN; replyAgeMs: the leader's monotonic ms since it saw reply_time change, null with no
  //   walsender; syncState: pg_stat_replication.sync_state
  export type SyncSample = { now: number; others: CopySample[]; listed: number; setting: string | null;
    route: { client: string; generation: number } | null; record: SyncRecord | null; oldestWaitMs: number | null;
    slowForMs: number; namedBytes5s: number };
  //   listed: the other live data rows, finished or not; others: those of them with a copy name; setting: the name
  //   in synchronous_standby_names, or null; record: the relay's record as last read or stored
  export type SyncMemory = { w: string | null; posting: boolean; flag: Flag; checkpointed: boolean; blocked: boolean };
  export function lsnAtLeast(a: string, b: string): boolean;   // 'X/Y' positions compared as 64-bit numbers
  export type SyncAction =
    | { do: 'none' } | { do: 'post'; state: 'off' } | { do: 'post'; state: 'on'; copy: string }
    | { do: 'set'; name: string } | { do: 'clear' } | { do: 'checkpoint' } | { do: 'read_w' };
  export function nextSyncStep(s: SyncSample, m: SyncMemory): { action: SyncAction; flag: Flag; memory: SyncMemory;
    renew: boolean };
  // modules/keeper/sync.ts
  export class SyncController {
    constructor(opts: { sql: Sql; relay: { route(name: string, key: string): Promise<Route>; setSync(name: string,
      key: string, post: SyncPost): Promise<SyncResult> };
      link: () => { name: string; key: string; client: string } | null;
      dbBytes: (machine: string) => number; log: (line: string) => void; now?: () => number; everyMs?: number });
    start(): Promise<void>;     // reads the record and the setting it finds; never clears before off is stored
    stop(): Promise<void>;
    flag(): Flag;
    renew(): boolean;           // !memory.blocked
    copies(): { name: string; state: 'sync' | 'pace' | 'behind' | 'silent' }[];   // for keeper.json
  }
  // modules/keeper/slots.ts
  export const SLOTS_EVERY_MS = 60_000;
  export const KEEP_SIZE_EVERY_MS = 3_600_000;
  export function keepSize(diskFree: number): number;   // MB: min(20480, floor(diskFree / 4 / 2 ** 20))
  export function sweepSlots(sql: Sql, log: (line: string) => void, inactiveSince: Map<string, number>, now: number):
    Promise<string[]>;
  //   the names dropped; inactiveSince: when each table sync slot was first seen inactive, kept by the caller
  // lease-store.ts: take(kind: LeaseKind, until: Date, sync: LeaseSync): Promise<Term>; renew(term: Term, kind:
  //   LeaseKind, until: Date, endSessions: boolean, sync: LeaseSync): Promise<boolean>, which sets the lease's sync in
  //   its one UPDATE; prune gains the bound copiesAt: Date | null (below)
  ```
- `nextSyncStep`, the first row that matches; `setting` names a copy C when it equals C's `name`; "off stored" means
  `record.state` `off` with `record.generation` the route's `generation`; "on C stored" likewise with `copy` C's
  network id; C is listed when it is in `others`:

  | When | Action | Flag |
  |---|---|---|
  | `posting` | none | `memory.flag` |
  | `listed` 0, `setting` set, off stored | `clear` | `relay_off` |
  | `listed` 0, `setting` set | post off | `copy` |
  | `listed` 0, record `on` | post off | `alone` |
  | `listed` 0 | none | `alone` |
  | `setting` set and names no listed copy, off stored | `clear` | `relay_off` |
  | `setting` set and names no listed copy | post off | `copy` |
  | `setting` C, C silent, off stored | `clear` | `relay_off` |
  | `setting` C, C silent | post off | `copy` |
  | `setting` C, a lower-numbered finished copy kept pace `PACE_FOR_MS`, off stored | `clear` | `relay_off` |
  | `setting` C, a lower-numbered finished copy kept pace `PACE_FOR_MS` | post off | `copy` |
  | `setting` C, `w` null, C's `syncState` not `sync` | none | `copy` |
  | `setting` C, `w` null, not `checkpointed` | `checkpoint` | `copy` |
  | `setting` C, `w` null | `read_w` | `copy` |
  | `setting` C, `lsnAtLeast(C's confirmed, w)`, on C not stored | post on C | `copy` |
  | `setting` C | none | `copy` |
  | off stored, a finished copy kept pace `PACE_FOR_MS` | `set` the lowest-numbered such | `relay_off` |
  | off stored | none | `relay_off` |
  | otherwise | post off | null |

  C is silent when `replyAgeMs` is null or over `SILENT_REPLY_MS`, or when `slowForMs` is at least `SLOW_FOR_MS` and
  `namedBytes5s` under `SLOW_BYTES`. `set` and `clear` reset `w` to null and `checkpointed` to false; the controller
  sets `checkpointed` once its `CHECKPOINT` ended and `w` once read; a post's answer sets `posting` false. The flag
  of the row is kept in `memory.flag`. `blocked` turns true when `oldestWaitMs` is at least `STOP_RENEW_MS`, the
  setting is set, the copy it names is silent or not listed, and off is not stored; it turns false only once off is
  stored or the copy the setting names is listed and not silent, so sessions ended at lease end do not lift it.
  `renew` is `!blocked`; a commit waiting on a copy that keeps receiving (a big transaction) never stops the lease.
- `SyncController`, every `everyMs` (`SAMPLE_EVERY_MS`), on the keeper's `keeperSql` session:
  - The sample: other live data rows from `machines`; for each, its slot by `copyName` in `pg_replication_slots`
    (`confirmed_flush_lsn`) and its walsender in `pg_stat_replication` by `application_name` (`reply_time`,
    `sync_state`, `pid`); `replyAgeMs` by `performance.now()` since the sample that first saw this `reply_time`, a
    walsender seen first or with a new `pid` starting its clock then (`reply_time` is the copy's clock, never
    compared with the leader's);
    `keptPaceMs` since when `confirmed` has been at or past the `pg_current_wal_lsn()` sampled `PACE_MS` before;
    `finished` from the row's `copy_state` `ready`; `setting` from `SHOW synchronous_standby_names`; the oldest
    `pg_stat_activity` row with `wait_event` `SyncRep`; `slowForMs` since when every sample saw it over
    `SLOW_WAIT_MS`; `namedBytes5s` from `dbBytes` of the named copy; `route` as the keeper last read it, null unless
    it is `held` by the keeper's own link client.
  - `post`: `route` read again, then `setSync(name, key, { client, generation, state, copy, epoch: record.epoch + 1 })`
    with the keeper's own client and the generation just read;
    `stored: true` updates the record; anything else is one log line and the next sample decides again.
  - `set`: `ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 ("<name>")'` and `pg_reload_conf()`; `clear`:
    `ALTER SYSTEM RESET synchronous_standby_names` and `pg_reload_conf()`; each on a session with `synchronous_commit
    = local`. `checkpoint`: `CHECKPOINT` on such a session, which the checkpointer runs only after the reload it was
    signalled before (ruling 9). `read_w`: `pg_current_wal_lsn()`.
  - It samples from the keeper's first lead on, leading or not, so a keeper whose lease ended can get off stored.
  - The flag is what the keeper gives `LeaseStore.take` and `renew` as their `sync`, in place of plan 3's `alone`;
    with no flag it neither takes nor renews, and while `renew()` is false it does not renew, so the lease ends as
    plan 3's does; `mode()` says `lead` only with a flag. Plan 5's guard stays: while `othersHoldData()` last answered
    true, `alone` counts as no flag.
- The pulse: while `listed` is above 0 and the keeper leads, `INSERT INTO net.pulse (at) VALUES (clock_timestamp()) ON
  CONFLICT (id) DO UPDATE SET at = excluded.at` each second on a session with `synchronous_commit = local`.
- Slots: `ALTER SYSTEM SET max_slot_wal_keep_size = '<keepSize>MB'` and a reload at the first lead and every
  `KEEP_SIZE_EVERY_MS`, with the volume's free disk from `Measures`. `sweepSlots` each `SLOTS_EVERY_MS`: each slot
  `copy_<16 hex>_<n>` is dropped when no live data row's network id starts with those 16 characters, or when that
  row's `copy_name` has a higher `n`; a table sync slot (`pg_%_sync_%`) once it was inactive at every sweep for 10
  minutes; each one's walsender ended first by `pg_terminate_backend`; other names left alone.
- At lease end, with `listed` above 0, the keeper stops its link frpc (plan 3's ruling 6) and starts it again 30 s
  later while it does not lead, so its route is held and off can be stored.
- `keeper.json` gains `copies` from `copies()`.
- `LeaseStore.prune`, with other data machines listed: only rows older than 7 days and older than `copiesAt`, the
  oldest `copy_at` among rows with `copy_state` `ready` whose slot is not `lost`; with none, nothing older than 7 days
  is kept from going as plan 8 says.

- [ ] **Step 1: Write failing tests.**
  - `sync-step.test.ts`: one test per row of the table, named by its When, each asserting the action, the flag and
    `renew`; and:
    - `never clears before off is stored`: over every sample built from `setting` set and the record `on` at either
      generation, no action is `clear`.
    - `posts on only past W`: `setting` C, `w` 0/3000000, C's `confirmed` 0/2FFFFFF: no post; 0/3000000: post on.
    - `posts again at a new generation`: on C stored at generation 4, the route at 5: post on C, flag `copy`.
    - `takes no flag without the relay`: listed 1, no setting, record off at an older generation: post off, flag null.
    - `stays alone when the last copy goes`: listed 0, record `on` naming a machine that left: post off, flag `alone`.
    - `drops a silent copy`: `replyAgeMs` 2001: post off; null: post off; `slowForMs` 5000 with 900000 bytes: post
      off; with 2000000 bytes: none.
    - `stops renewing when sync cannot be cleared`: C silent, `oldestWaitMs` 10000, off not stored: `renew` false; at
      9999: true; off stored: true.
    - `stays stopped until the copy answers`: after `renew` turned false, `oldestWaitMs` null (the sessions ended)
      with C still silent: false; C not silent: true; from false again, off stored: true.
    - `waits for the setting to hold`: `setting` C, `w` null, C's `syncState` `potential`: none; `sync`: `checkpoint`;
      `checkpointed`: `read_w`; after a `set` or a `clear`, `w` is null and `checkpointed` false.
    - `never clears an empty setting`: `listed` 1, `others` empty, no setting, off stored: none, flag `relay_off`; not
      stored: post off, flag null.
  - `sync.test.ts`, on `createTestSql` with fakes for the catalogs and the fake relay:
    - `names the copy, then says so at the relay`: a finished copy kept pace for 30 s: the setting names it, then once
      its slot confirmed W the fake relay's record is `on` with its network id at epoch one above.
    - `never clears before off is stored`: with the fake relay failing `setSync`, a silent copy keeps the setting;
      once it stores, the setting is reset.
    - `starts from what it finds`: started with the setting naming C and the record `on` C: no clear, no post until
      C confirms W, then none; `CHECKPOINT` ran before W was read.
    - `runs the barrier before W`: after the `set`, the statements are the setting, `pg_reload_conf()`, a
      `pg_stat_replication` read showing `sync`, `CHECKPOINT`, then `pg_current_wal_lsn()`, in this order.
    - `times a reply by its own clock`: a walsender whose `reply_time` is 5 s behind the leader's clock, and another
      5 s ahead, each changing each second: neither silent; one whose `reply_time` stays the same for 2.1 s: silent;
      a new `pid` starts its clock again.
  - `slots.test.ts`: `keepSize` of 40 GiB free is 10240, of 200 GiB 20480; `sweepSlots` drops `copy_<a>_1` when A's
    `copy_name` is `copy_<a>_2`, keeps `copy_<a>_3`, drops `copy_<z>_1` of no machine; keeps `pg_16384_sync_1_7`
    while it is active and while it has been inactive for 9 minutes, drops it at 10; keeps a slot of another name.
  - `keeper.test.ts`: `beats the pulse while copies exist`: with a data row listed, `net.pulse.at` advances each second;
    with none, it is not written; `stops its link at lease end with copies`: the link frpc child stops when the lease
    ends and another data row is listed, and not when none is; `starts its link again to get off stored`: 30 s after
    that lease end the link frpc child runs again while the keeper does not lead, and with the fake relay storing off
    the keeper takes a lease with sync `relay_off`; `leads alone only when alone`: with `othersHoldData` true and the
    flag `alone`, `fakeLease` gets no `take`.
  - `lease-store.test.ts`, `prunes only what every copy holds`: rows 8 days old with a copy's `copy_at` 9 days ago
    stay; with `copy_at` now they go; a copy whose slot is `lost` does not hold them back.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the three files and the keeper's changes.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Confirm commits only once the sync copy holds them, and drop a silent copy from sync only
  after the relay knows".

### Task 8: Real pairs of Postgres, on two architectures

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 7 committed. **Done when:** from the worktree
root, `npm run test:real` passes on the team lead's Mac (both architectures through Docker Desktop's emulation) and the
whole suite passes; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/test/real/pairs.test.ts`
- Modify: `apps/server/test/real/pg.ts` (`realCluster`'s `platform`), `apps/server/test/real/pair.ts` (platforms,
  the controller, pause and resume, the checkpointer held), `.github/workflows/images.yml` (the job that runs
  `test:real`)
- Test: the two files above

**Interfaces:**
- Consumes: `migrateDb`, `openDb` (plan 3); `realCluster`, `pair()` (Task 6); `DbDoor`, `ensureReplica`,
  `ensurePublication` (Task 4); `CopyMaker` (Task 6) with the updater's `schema_request` played by `pair.ts`;
  `SyncController`, `LeaseStore`
  (Task 7).
- Produces:
  ```ts
  // test/real/pg.ts: realCluster's opts gain platform?: Platform ('linux/amd64' | 'linux/arm64'), docker run's
  //   --platform, the host's when not given
  // test/real/pair.ts
  export function pair(opts?: { leader?: Platform; copy?: Platform }): Promise<{ leader: Real; copy: Real;
    controller: SyncController; maker: CopyMaker; pause(): Promise<void>; resume(): Promise<void>;
    holdCheckpointer(): Promise<void>; releaseCheckpointer(): Promise<void>; close(): Promise<void> }>;
  //   each platform the host's when not given, so Task 6's pair() holds; pause/resume: docker pause and unpause of
  //   the copy's container; hold/release: kill -STOP and -CONT, by exec, of the leader's process whose
  //   pg_stat_activity.backend_type is checkpointer
  ```
- `images.yml`: the job that runs `test:real` gains, before it, the step `uses:
  docker/setup-qemu-action@99012661954931238ded8c8b007157a8430204e1 # v4.4.0` with `platforms: arm64`. Every case below
  runs twice, the leader on `amd64` and the copy on `arm64`, then the other way.

- [ ] **Step 1: Write the tests** in `pairs.test.ts`, each with a `testTimeout` of 300000:
  - `confirms only what the copy holds`: once named and `on` stored, 200 inserts into `tasks` each committed on the
    leader; then the copy paused; a commit started after the pause does not return within 1 s; after the copy is
    resumed, every row the leader confirmed is on the copy.
  - `waits for the checkpointer before W`: with the leader's checkpointer held, the copy named: no `on` is posted
    within 5 s; released: `on` is posted, and then, the copy paused, a new commit does not return within 1 s.
  - `goes on alone when the copy stops`: with the copy named, its subscription disabled (fence 3), and in a second run
    its container stopped: within 3 s the setting is cleared after the fake relay stored off, a commit returns, and
    the flag is `relay_off`.
  - `carries files and the journal, not sequences`: a 50 MB `bytea` attachment row is on the copy, equal; each
    `net.journal` row of a transaction arrives with it; the copy's `task_events` sequence is where its schema left it.
  - `revokes back on a new copy`: before `openAgentSql` runs on the copy, as its app does on its first `read`, the
    copy's app is `off`; after it, the agent role reads `tasks` and cannot read `applied` or `tool_calls` or use
    anything in `net` but `assert_lease`.
  - `waits when neither the copy nor the relay answers`: the copy paused and the fake relay down: commits wait, `renew`
    is false within 11 s, and at the lease's end a waiting session is ended and its caller gets an error (fence 4).
  - `makes the first copy while the leader writes`: 20 inserts a second throughout the making; the leader's lease is
    renewed every time; the copy finishes and holds every row.
  - `loses a slot to the WAL limit`: `max_slot_wal_keep_size` 1 MB on the leader, the copy paused while 64 MB is
    written, then a `CHECKPOINT` run and awaited (the limit is kept at checkpoints): the slot reads `lost`, and the
    `copy` of the copy's next view says `lost` (Task 9 makes the remake).
  - `drops a stale slot even while its copy reads`: `sweepSlots` with the copy's row naming a later attempt ends the
    walsender and drops the slot.
  - `keeps fence 3`: a write as the agent role is refused on the leader once its lease's `sync` is set to null, and
    on the copy, which holds no lease.
- [ ] **Step 2: Run** `npm run test:real`. Expected: the cases fail only where the plan's code is wrong; a fault in
  `pair.ts` is fixed there first.
- [ ] **Step 3: Fix** what fails in the task that owns it, in this task's commit, with a line in its message.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Test copies and synchronous commits on real Postgres pairs of both architectures".

### Task 9: Making a copy again, and merging its old database

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 8 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/copy-maker.test.ts test/follow-keeper.test.ts
test/merge-peer.test.ts test/merge-kept.test.ts test/network-join.test.ts test/network-routes.test.ts
test/updater.test.ts test/carry.test.ts test/restore.test.ts` passes, then the whole server suite; from the worktree
root `npm run test:real` passes; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing; `bash -n` and
`shellcheck` on `apps/updater/updater.sh` print nothing.

**Files:**
- Modify: `apps/server/src/modules/keeper/copy.ts` (the remake and the swap), `apps/server/src/modules/keeper/follow.ts`
  (the replica role after a swap), `apps/server/src/modules/merge/source.ts` (`peerSource`),
  `apps/server/src/modules/merge/merger.ts` (`machine:` sources, `fastWay` first),
  `apps/server/src/modules/merge/check.ts` (`fastWay`), `apps/server/src/modules/network/join.ts` (`CopyOrder.old`),
  `apps/server/src/app.ts` (`doorsWanted`), `apps/updater/cutover.sql`, `apps/updater/carry.sql`,
  `apps/server/src/modules/backups/types.ts` (`Carry`), `apps/server/src/modules/backups/restore.ts` (`applyCarry`)
- Test: `apps/server/test/copy-maker.test.ts`, `apps/server/test/follow-keeper.test.ts`,
  `apps/server/test/merge-peer.test.ts` (new), `apps/server/test/merge-kept.test.ts`,
  `apps/server/test/network-join.test.ts`, `apps/server/test/updater.test.ts`, `apps/server/test/carry.test.ts`,
  `apps/server/test/restore.test.ts`, `apps/server/test/real/pairs.test.ts`

**Interfaces:**
- Consumes: `MergeSource`, `runMerge`, `complete`, `Merger`, `restoresOf`, `horizonOf`, `journalIds`, `net.merges`
  (plan 8); `Carry`, `applyCarry`, `carry.sql` (plan 7); `readKeeperState`
  and `keeper.json`'s `doors` (Task 4); `CopyMaker`, `CopyOrder` (Task 6); `sweepSlots` (Task 7).
- Produces:
  ```ts
  // modules/merge/source.ts
  export const MACHINE_SOURCE: RegExp;     // /^machine:([0-9a-f-]{36}):([1-9][0-9]{0,8})$/
  export function peerSource(config: Config, port: number, password: string, label: string): Promise<MergeSource>;
  //   new Client({ host: 'keeper', port, database: 'hornhoof', user: 'hornhoof_replica', password,
  //   application_name: 'hornhoof-merge', options: '-c default_transaction_read_only=on' }); BEGIN ISOLATION LEVEL
  //   REPEATABLE READ READ ONLY, then SELECT current_database() first, as keptSource
  // app.ts: doorsWanted() answers the network ids of the machines whose machine: merge is pending or applied
  // modules/merge/check.ts
  export type FastWay = 'fast' | 'left_out' | 'whole';
  export function fastWay(db: Db, source: MergeSource): Promise<{ way: FastWay; restoreAt: Date | null }>;
  //   reads by column only, so it runs before factsOf and sameShape: net_local.state (a missing table has no row),
  //   net.restores of both sides, the leader's net.merges and net.horizon, journal ids, net.merge_consumed,
  //   net.merge_conflicts and net.backups. whole: the source has a state row, or lacks a leader's restore that was
  //   not left out, or the id check below fails. left_out: no state row, and every leader's restore it lacks has a
  //   kept:<name> merge with a fork, merged_at null and the status removing or done; restoreAt the newest of them.
  //   fast: no state row, no restore lacking, every journal id of the source at or after the leader's horizon on
  //   the leader or in net.merge_consumed, no open conflict of the source, no net.backups row of it missing there
  // modules/backups/types.ts: Carry's machines gain role: 'data' | 'worker', dataLeftAt: string | null and
  //   uploadState: string | null; Carry gains link: { name: string; url: string; keyEnc: string; nextKeyEnc: string |
  //   null; tunnelEnc: string | null; createdAt: string } | null and peerSecrets: { kind: string; secretEnc: string }[]
  // modules/keeper/copy.ts
  export const NEXT_DB = 'hornhoof_next';
  export const MISSING_VIEWS = 2;
  export type SwapStep = 'off' | 'disable' | 'rename' | 'enable' | 'drop_sub' | 'drop_db' | 'read';
  ```
- The remake, in `CopyMaker.tick` from phase `sync` or `ready`, when `order.slot` is `lost`, or `missing` in
  `MISSING_VIEWS` views in a row after an `ok`, or the subscription has been disabled for `ENABLE_FOR_MS`, or
  `order.migrations` is set and not `copy-state.json`'s `migrations`: the old subscription disabled and detached
  (`slot_name = NONE`); a `hornhoof_next` already there given up as Task 6's step 7 gives up an attempt (its
  subscription disabled, detached and dropped first, then the database dropped when it holds no `net_local.state` row),
  then made; the next attempt in phase `schema` on `hornhoof_next`, as Task 6 makes a copy; the report `remaking` with
  its progress, `at` the old database's pulse; the mode stays `read` on the old one. Finished, the report's `old` is `{
  attempt: <the old attempt> }`. When `order.old` is `merged` or `done`, the swap, each step written to
  `copy-state.json` as `swap:<step>` before it runs and each one that finds its work done going on:
  1. `off`: the mode `off`, and 2 s for the app to read it.
  2. `disable`: the new subscription disabled.
  3. `rename`: every other session on `hornhoof` and `hornhoof_next` ended (`pg_terminate_backend`), `hornhoof`
     renamed `hornhoof_old_<stamp>` and `hornhoof_next` renamed `hornhoof`.
  4. `enable`: the new subscription enabled.
  5. `drop_sub`: on the old database, the old subscription's `slot_name` set to `NONE`, then the subscription dropped.
  6. `drop_db`: the old database dropped, only when it holds no `net_local.state` row (ruling 12; else the report
     `stopped`, `led`, and it stays).
  7. `read`: `ensureReplica` in full on the new `hornhoof` (its grants are per database), the mode `read`, `old` null.
  A keeper that starts with a `swap:<step>` state goes on from that step.
- The merger, at each `discover`: for each live row of the role `data` (or with `upload_state` set) whose `copy_old`
  has no `net.merges` row `machine:<row id>:<copy_old>`, a row with that source, `machine` the row's id, `fork` null,
  the label "<hostname>'s copy from before it was made again", status `pending`. At `tick`, such a merge runs only
  when `keeper.json`'s `doors` has its machine's network id, through `peerSource` with that port and
  `replicaPassword(config.secret)`; else it waits, with no `tries` counted.
  - Before plan 8's `runMerge`, a `machine:` or `upload:` merge takes `fastWay` (ruling 15): `fast`, the merge
    `merged` with `merged_at`, nothing written; `left_out`, `done` with `done_at` and `error` "Left out with the
    database from before the restore of <time>."; `whole`, plan 8's `runMerge` and `complete`. A source compared
    whole across two shapes waits with plan 8's "The two databases are of different versions.", and its copy goes on
    reading its old database; plan 9c's updates across machines take that case.
  - A `merged` `machine:` merge is `done` once its row's `copy_old` is no longer its attempt, or its row is no longer
    live: `done_at`; nothing is dropped by the leader.
  - A `machine:` merge whose row stopped being live before it ran: `done` with `error` "<hostname> left before its
    old copy was read."
- `workerView`'s `copy.old`: the status of the merge `machine:<row id>:<copy_old>`, `waiting` while it is `pending` or
  `applied`, null without `copy_old`.
- The carry (ruling 21): `carry.sql` also answers each machine's `role`, `data_left_at` and `upload_state`, the
  `public_links` row (null without one) and the `peer_secrets` rows, each secret as stored, sealed; `applyCarry` sets
  each machine's three as the carry's, writes the link row whole (a null `link` deletes the restored one) and
  replaces `peer_secrets` with the carry's, in its one pass.
- `cutover.sql`, after it ends the sessions of the database it closes: `SELECT pg_drop_replication_slot(slot_name)
  FROM pg_replication_slots WHERE database = <that database> AND NOT active`, after the walsenders of those slots are
  ended.

- [ ] **Step 1: Write failing tests.**
  - `copy-maker.test.ts`:
    - `remakes when its slot is lost`: `ready`, then a view with `slot` `lost`: the old subscription disabled and its
      `slot_name` `NONE`, `hornhoof_next` made, `schema.json` with attempt 2 and the database `hornhoof_next`; the
      report `remaking`, mode `read`.
    - `remakes after two views without its slot`: one `missing` view after `ok`: nothing; two: the remake.
    - `remakes after a stop that does not mend`: disabled for `ENABLE_FOR_MS`: the remake; enabled again at 9 minutes:
      none.
    - `remakes after a migration`: `copy-state.json`'s `migrations` 55 and `order.migrations` 56: the remake; null:
      none.
    - `gives up an earlier side database whole`: a `hornhoof_next` with a subscription: `DISABLE`, `SET (slot_name =
      NONE)` and `DROP SUBSCRIPTION` run before its `DROP DATABASE`.
    - `swaps only after the merge`: finished in `hornhoof_next`, `old` `{ attempt: 1 }`; views with `order.old`
      `waiting`: no rename; `merged`: the seven steps' statements in order, `hornhoof_old_<stamp>` dropped, mode `off`
      during them and `read` after.
    - `finishes a half-done swap`: started with `swap:enable` in `copy-state.json` and the databases as after
      `rename`: it runs steps 4 to 7 and nothing before.
    - `keeps a database that led`: the old database with a `net_local.state` row: no `DROP DATABASE`, the report
      `stopped`, `led`.
  - `merge-peer.test.ts`, on Task 5's merge fixture of plan 8 with the source read through a fake `MergeSource`:
    - `merges a copy that never wrote by its ids`: a source whose journal ids the leader all holds and no state row:
      `merged`, and no table but `net.journal`, `net.backups`, `net.merge_conflicts`, `net.restores`,
      `net.merge_consumed`, `net_local.state` and the leader's `net.merges` and `net.horizon` was read; the same with
      the source's `tasks` lacking a column: `merged`, and `sameShape` never ran.
    - `does not bring back what the leader deleted`: the source holds a task whose insert and later delete journal
      rows are both on the leader, and only the insert on the source: `merged` by `fastWay`'s `fast`, and the task is
      still absent on the leader.
    - `reads every row of a copy that wrote`: the same with a state row: plan 8's whole check runs.
    - `compares across a restore`: the leader has a restore the source lacks, with a task only the source holds;
      that restore's `kept:` merge `done` with `merged_at` set: plan 8's compare, and the task is on the leader; with
      a `fork`, `merged_at` null and `removing`: `done` with "Left out with the database from before the restore of
      <time>." and no row added; with `fork` null (a total loss): plan 8's compare; `pending`: plan 8's compare.
    - `waits for its door`: no `doors` entry: the merge stays `pending` with `tries` 0; with it, it runs.
    - `ends when the machine left`: the row revoked before the merge ran: `done` with the line.
  - `merge-kept.test.ts`, `names the doors it needs`: `doorsWanted()` holds a machine's network id while its merge is
    `pending` or `applied` and not after `merged`.
  - `network-join.test.ts`, `tells a copy when its old database is merged`: `copy.old` follows the merge's status.
  - `carry.test.ts`, `takes who holds the data and the link`: with a data machine, a worker with `data_left_at`, a
    link with a `next_key_enc` and both `peer_secrets` rows, `carry.sql`'s line names each as it is.
  - `restore.test.ts`, `keeps who holds the data and the link`: on a database where a machine is `data`, the link's
    key is an older one and `peer_secrets` hold older secrets, `applyCarry` of a carry where that machine is a
    `worker` with `data_left_at` sets both, and the link's `key_enc` and `next_key_enc` and the secrets are the
    carry's; a carry with `link` null removes the link row.
  - `updater.test.ts`, `drops the slots of the database it closes`: `cutover.sql` run on a stub that lists two slots
    of `hornhoof` and one of another database: the two dropped.
  - `real/pairs.test.ts`, `remakes after its slot is lost`: after Task 8's lost slot, the copy remakes, the leader's
    merge of its old database is `merged` by the fast check within 2 minutes, the swap leaves one database
    `hornhoof` on the copy that holds every row of the leader, and no `hornhoof_old_*` and no `copy_%` slot of attempt
    1 are left.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Make a broken copy again beside the old one, and drop the old one only after the leader
  merged it".

### Task 10: The upload and the wipe

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 9 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/uploads.test.ts test/follow-keeper.test.ts
test/worker-keeper.test.ts test/merge-kept.test.ts test/network-routes.test.ts test/network-join.test.ts
test/updater.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing; `bash -n` and `shellcheck` on `apps/updater/updater.sh` print nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/uploads.ts`
- Modify: `apps/server/src/net/peer-server.ts` (`uploads`), `apps/server/src/modules/keeper/keeper.ts` (the leading
  keeper's taker), `apps/server/src/modules/keeper/follow.ts` (the upload and the wipe),
  `apps/server/src/modules/keeper/worker.ts` (`wiped` in the report), `apps/server/src/modules/merge/merger.ts` and
  `apps/server/src/modules/merge/source.ts` (`upload:` sources), `apps/server/src/modules/network/routes.ts` (the own
  answer's `uploads`, the report's `wiped`), `apps/server/src/modules/network/join.ts` (`CopyOrder.upload`),
  `apps/updater/updater.sh` (`upload_request`, `load_request`, `wipe_request`)
- Test: `apps/server/test/uploads.test.ts` (new), `apps/server/test/follow-keeper.test.ts`,
  `apps/server/test/worker-keeper.test.ts`, `apps/server/test/merge-kept.test.ts`,
  `apps/server/test/network-routes.test.ts`, `apps/server/test/network-join.test.ts`,
  `apps/server/test/updater.test.ts`

**Interfaces:**
- Consumes: `PeerLink.stream`, `Peer`, `PeerServerOptions` (plan 5); plan 7's peer paths; `keptDatabases`, the fork
  bundle (plan 8); `swap_updater`, `own_image` and the updater's role check (Task 5); `MACHINE_SOURCE`, `fastWay`
  (Task 9).
- Produces:
  ```ts
  // modules/keeper/uploads.ts
  export const UPLOAD_PATH = /^\/peer\/upload\/([0-9a-f-]{36})$/;
  export const UPLOAD_FILE = 'upload.json';  // control folder of the copy: { id }, 0600
  export const LOAD_FILE = 'load.json';      // control folder of the leader: { id, machine, file, database,
                                             //   unpackMax }, 0600
  export const UPLOAD_SPARE = 2 ** 30;
  export const RETRY_UPLOAD_MS = 600_000;
  export const WIPE_FILE = 'wipe.json';      // control folder: { id, step? }, written by the follow keeper
  export const WIPED_FILE = 'wiped.json';    // control folder: { id, at }, written by the updater
  export type UploadAllowed = { machine: string; networkId: string; max: number; unpackMax: number };
  export type PeerUploads = { put(peer: Peer, id: string, body: Readable): Promise<201 | 403 | 409 | 413> };
  export class UploadTaker {
    constructor(opts: { controlDir: string; allowed: () => UploadAllowed[]; log: (line: string) => void;
      now?: () => Date });
    start(): void;          // removes every uploads/*.part, left by a keeper that stopped
    peer(): PeerUploads;
  }
  // net/peer-server.ts: PEER_PATHS gains upload: '/peer/upload/'; PeerServerOptions gains uploads?: PeerUploads
  // modules/merge/source.ts
  export const UPLOAD_NAME: RegExp;   // /^hornhoof_upload_[0-9a-f]{16}_[0-9]{8}t[0-9]{6}$/
  // GET /api/network/peers' own answer gains uploads: UploadAllowed[]: the rows with upload_state waiting; max
  //   3 * pg_database_size + UPLOAD_SPARE, unpackMax 4 * pg_database_size + UPLOAD_SPARE
  // POST /api/network/report takes wiped?: true
  ```
- `UploadTaker.put` (ruling 11): `peer.machine` must be the `machine` of an `allowed()` record, else 403; the network
  id is that record's. One upload at a time: the slot is taken before the body's first byte is read, a second `put`
  meanwhile gets 409, and it is given back when the body fails or when the updater wrote `uploads/<id>.done` or
  `.failed`. The body goes into `<controlDir>/uploads/<networkId>-<id>.tar.gz.part` (folder 0700, file 0600, umask
  077); past `max` bytes, 413 and the part removed; a broken stream removes the part; at its end, renamed without
  `.part`, then `load.json` with `database` `hornhoof_upload_<first 16 hex of the network id>_<UTC stamp
  YYYYMMDDtHHMMSS>` and the record's `unpackMax`; 201.
- `updater.sh`:
  - `upload_request`, on a copy, when `upload.json` names an id with no `uploads/<id>.done` or `.failed`: in a 0700
    folder under umask 077, for each base table of `public`, `net` and `net_local` of `hornhoof`
    (`information_schema.tables`), `COPY <schema>.<table> TO STDOUT (FORMAT csv, HEADER true)` by `psql` in `db` into
    `<schema>.<table>.csv`; `tar -czf uploads/<id>.tar.gz` of those files; the folder removed; `.done` or `.failed`
    with the reason (0600); `upload.json` removed.
  - `load_request`, on the leader, when `load.json` is there. No SQL from the machine runs: its bytes reach Postgres
    only as `\copy` data.
    1. A `hornhoof_uploading_*` database a stop left is dropped; a `database` that `UPLOAD_NAME` does not match is
       `.failed` with nothing made.
    2. The file unpacked in a 0700 folder: `gunzip -c` through `head -c <unpackMax + 1>`, more than `unpackMax` bytes
       failing; every entry a regular file whose name matches `^(public|net|net_local)\.[a-z_][a-z0-9_]*\.csv$`,
       else failing.
    3. `CREATE DATABASE hornhoof_uploading_<the rest of the name>`, and the leader's own schema into it: `pg_dump
       --schema-only --no-owner --no-privileges --no-publications --no-subscriptions hornhoof` through `psql -1 -v
       ON_ERROR_STOP=1`.
    4. One `psql -1 -v ON_ERROR_STOP=1` session on it, its script the updater's own: `SET session_replication_role =
       replica;`, then for each file whose table the leader has (any other one `say` line) `\copy
       <schema>.<table> (<the header's columns>) FROM '<file>' WITH (FORMAT csv, HEADER true)`, each column of the
       header first matched by `^[a-z_][a-z0-9_]*$` and found among the table's columns in
       `information_schema.columns`, else failing.
    5. `ALTER DATABASE hornhoof_uploading_... RENAME TO <database>`, so the merger never sees a half load.
    The unpacked files and the upload removed whatever the end; `uploads/<id>.done` or `.failed` (0600); `load.json`
    removed; on a failure the `hornhoof_uploading_*` database dropped.
  - `wipe_request`, while `wipe.json` is there: each step written into its `step` before it runs; a step that fails
    is one `say` line and is tried again on the loop's next pass, also after a restart.
    1. `check`: with the `db` volume there (`db` started when it is down), no database of `db` but `postgres` and
       the templates has a `net_local.state` row (a database without the table has none); else the `say` line
       "This machine's database once led the company, so it is not wiped.", once an hour, and nothing more (ruling
       12). With the volume gone, passed.
    2. `stop`: `compose rm -sf db migrate app`.
    3. `volume`: `docker volume rm` of the `db` service's volume (its name from `compose config --format json`); a
       volume already gone counts as removed.
    4. `files`: `dumps/`, `restore/`, `schema/`, `uploads/`, the updater's own dumps (`backups/`), `replica.json`,
       `schema.json`, `dump.json` and `upload.json` removed.
    5. `env`: in `.env` `HORNHOOF_SECRET`, `NODE_KEY`, `RELAY_URL` and `POSTGRES_PASSWORD` emptied,
       `COMPOSE_PROFILES` removed, `HORNHOOF_ROLE=worker`.
    6. `up`: `HORNHOOF_ROLE=worker compose up -d --no-build --remove-orphans` naming every service but `updater`.
    7. `done`: `wiped.json` with the id and the time, then `wipe.json` removed; the updater's role check (Task 5)
       then replaces the updater with `swap_updater "$(own_image)"`.
- The follow keeper, when its view's `copy.upload` is `waiting`: the mode `off`; every subscription of `hornhoof` and
  `hornhoof_next` disabled; `upload.json` `{ id: <new uuid> }`; once `uploads/<id>.done` is there, `PeerLink.stream
  ('PUT', '/peer/upload/<id>')` with `uploads/<id>.tar.gz`, deleted after a 201; a failure (a 409 too) tried again
  each minute with the same file; with the view still `waiting` `RETRY_UPLOAD_MS` after a 201, a new upload. When
  `copy.upload` is `wipe`: `copy-state.json` and its frpc files removed from its volume, then `wipe.json` `{ id }`
  unless one is there. `workerView` gives `copy` also to a row with `upload_state` set; `upload` is `waiting` while it
  is `waiting` or `received`, `wipe` when `kept`.
- The worker keeper's report carries `wiped: true` while `wiped.json` is there, which it removes after a 200, and
  while its view's `copy.upload` is set and the control folder holds neither `wipe.json` nor `replica.json`, since a
  worker keeper holds no database; the route sets `upload_state` null on it.
- The merger, at each `discover`: each database `UPLOAD_NAME` names without a `net.merges` row `upload:<name>`: the
  machine whose network id starts with its 16 hex, the label "<hostname>'s copy, uploaded <date>", `fork` a new uuid,
  status `pending`, and that row's `upload_state` `received`, in one transaction. Plan 8's `KeptDatabases` reads and
  drops `upload:` databases as it does `kept:` ones (`open`, `drop`, the fork bundle by the database's name). When the
  merge is `merged` and its `fork` is in `net.backups`, the row's `upload_state` becomes `kept`, and the database is
  dropped and the merge `done` as a `kept:` one.

- [ ] **Step 1: Write failing tests.**
  - `uploads.test.ts`, a `PeerServer` with the taker's `peer()` as `uploads` and a TLS client of a worker
    certificate:
    - `takes an upload from a machine that must give one`: allowed by its row id: 201, `uploads/<nid>-<id>.tar.gz`
      with the bytes, 0600, the folder 0700, `load.json` naming it, `hornhoof_upload_<16 hex>_<stamp>` and the
      record's `unpackMax`.
    - `refuses anyone else`: the certificate of a row not allowed: 403, no file.
    - `keeps no part`: a body over `max`: 413 and no file; a stream cut in the middle: no file, no `load.json`, and
      the next `PUT` is taken; after `start()`, an older `.part` is gone.
    - `takes one at a time`: a second `PUT` while the first's body still comes: 409; a third after the first's
      `uploads/<id>.failed`: taken.
  - `follow-keeper.test.ts`:
    - `uploads once its scope is lost`: a view with `upload` `waiting`: the subscription disabled, mode `off`,
      `upload.json`; after the test's `uploads/<id>.done` and tar, a `PUT` to `/peer/upload/<id>` with its bytes, and
      the tar gone after the 201; a 409 is tried again a minute later with the same file.
    - `wipes only after the upload is kept`: `waiting` views write no `wipe.json`; a `wipe` view writes it, after
      `copy-state.json` is gone.
    - `uploads when it comes back`: started with its data certificate revoked while it was away and no fresh view, its
      signed renewal brings a worker certificate and a view with `upload` `waiting`, and the upload follows.
  - `worker-keeper.test.ts`, `says a machine with no database is wiped`: a view with `upload` `waiting` and neither
    `wipe.json` nor `replica.json`: the report has `wiped: true`; with `wipe.json` there: not until `wiped.json`.
  - `updater.test.ts`:
    - `makes an upload as CSV`: `upload.json`: the stub saw one `COPY ... TO STDOUT (FORMAT csv, HEADER true)` for
      each table it lists, of `hornhoof` alone; `uploads/<id>.tar.gz` holds `public.tasks.csv` and the others;
      `.done`; `upload.json` gone.
    - `loads an upload as data alone`: `load.json` with a tar of `public.tasks.csv` and `net.journal.csv`: the stub
      saw `CREATE DATABASE hornhoof_uploading_...`, the leader's `pg_dump --schema-only` into it, one `psql -1` whose
      script starts `SET session_replication_role = replica;`, holds `\copy public.tasks (<the header's columns>)
      FROM` and no line of the files, then `ALTER DATABASE ... RENAME TO hornhoof_upload_...`; `.done`; the files and
      `load.json` gone.
    - `refuses what is not a table's data`: a tar with `x.sql`, with `../public.tasks.csv`, with a link, or with a
      header naming a column the table lacks: `.failed`, the `hornhoof_uploading_*` database dropped, no rename; a
      tar that unpacks past `unpackMax`: `.failed` and no `CREATE DATABASE`; a file of a table the leader lacks: one
      `say` line and the rest loaded; a `database` of another name: nothing made; a `hornhoof_uploading_*` left by a
      stop: dropped first.
    - `wipes the database, the dumps and the secrets`: `wipe.json`: the stub saw the check, `rm -sf db migrate app`,
      `volume rm` and `up -d --no-build --remove-orphans` with `HORNHOOF_ROLE=worker` in its environment; the folders
      and files above are gone; `.env` has empty `HORNHOOF_SECRET`, `NODE_KEY`, `RELAY_URL` and
      `POSTGRES_PASSWORD`, no `COMPOSE_PROFILES`, `HORNHOOF_ROLE=worker`; `wiped.json` is there and `wipe.json` gone;
      no secret in the log.
    - `goes on with a wipe that failed`: with `volume rm` failing, `wipe.json` says `volume`, `.env` still holds its
      secrets and no `wiped.json` is there; the next pass with `volume rm` working goes on from `volume` to the end.
    - `never wipes a database that led`: a database with a `net_local.state` row: no `rm`, no `volume rm`,
      `wipe.json` kept at `check`, the `say` line once.
  - `merge-kept.test.ts`, `merges an upload and asks for its fork bundle`: a database named as an upload: one merge
    `upload:<name>`, the row `received`; its fork bundle recorded while the merge is `applied`: still `received`; once
    `merged`: `kept`, the database dropped and the merge `done`; a `hornhoof_uploading_*` database: no merge.
  - `network-routes.test.ts`: `names who must upload`: the own answer's `uploads` lists a `waiting` row with its
    `machine`, `networkId`, `max` and `unpackMax`; `forgets the upload once wiped`: a report with `wiped` sets
    `upload_state` null.
  - `network-join.test.ts`, `tells a machine that left to upload, then to wipe`: `waiting` and `received` give
    `upload` `waiting`; `kept` gives `wipe`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the file and the changes above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Upload what a machine held when its owner loses whole-company scope, and wipe it once the
  leader keeps it".

### Task 11: The Machines tab

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 10 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/nodes.test.ts test/copies-view.test.ts`
passes; from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/Machines.test.tsx test/i18n.test.tsx`
passes; then the whole suite; both `tsc` commands print nothing.

**Files:**
- Create: `apps/server/src/modules/copies/view.ts`
- Modify: `apps/server/src/modules/nodes/routes.ts` (`GET /api/machines`), `apps/web/src/types.ts` (`MachineView`,
  `CopiesView`), `apps/web/src/screens/Machines.tsx`, `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/ru.ts`
- Test: `apps/server/test/copies-view.test.ts` (new), `apps/server/test/nodes.test.ts`,
  `apps/web/test/Machines.test.tsx`, `apps/web/test/i18n.test.tsx`

**Interfaces:**
- Consumes: Task 1's columns; `unfit`, `candidates` (Task 2); the slots and walsenders as Task 7 reads them, and
  `keeper.json`'s `copies` (Task 7) by `readKeeperState` (plan 2).
- Produces:
  ```ts
  // modules/copies/view.ts
  export type CopyLine =
    | { line: 'making' | 'remaking'; progress: number } | { line: 'ready' } | { line: 'catching_up' }
    | { line: 'behind'; minutes: number }
    | { line: 'asleep'; since: string | null } | { line: 'stopped'; why: 'disk_full' | 'setup' | null };
  export type DataView = { number: number | null; why: 'server' | 'next' | null; unfit: Unfit | null;
    copy: CopyLine | null; leftAt: string | null };
  export type CopiesView = { leader: string; copies: { hostname: string; sync: boolean }[]; onlySince: string | null };
  export function dataViews(ctx: Ctx, now?: Date): Promise<Map<string, DataView>>;   // by machine id
  export function copiesView(ctx: Ctx): Promise<CopiesView | null>;                    // null with no copy
  ```
- `GET /api/machines` (the CEO and whole-company people only, as today's fields): each machine gains `data:
  DataView`; the answer gains `copies`. Others see neither.
- `CopyLine`, for a data row that is not the leader: `making` or `remaking` from `copy_state` with `copy_progress`;
  `stopped` from `copy_state` `stopped` (`disk_full` and `setup` by `copy_error`, else null); `asleep` when its
  walsender is missing or its last report is over 2 minutes old, `since` its `copy_at`; `ready` when `keeper.json`'s
  `copies` has its `copy_name` as `sync` or `pace` (the controller's own reading, ruling 16); `behind` when `copy_at`
  is over a minute older than the leader's `net.pulse.at`, in whole minutes; else `catching_up`. A stale or missing
  `keeper.json` makes no copy `ready`.
- `onlySince`: when a copy has existed (any data row other than the leader has a `copy_at`) and none is `ready`, the
  newest `copy_at`; else null. `copies[].sync` is true for the one `keeper.json` has as `sync`.
- Text, in both files (`machines.copy`), EN then RU:
  - `making`: "Copy: being made, <p>%" / «Копия: создается, <p>%»; `remaking`: "Copy: being made again, <p>%" / «Копия:
    создается заново, <p>%»; `ready`: "Copy: up to date" / «Копия: актуальна»; `behind`: "Copy: <n> min behind" /
    «Копия: отстает на <n> мин»; `catching_up`: "Copy: catching up" / «Копия: догоняет»; `asleep`: "Copy: asleep since
    <time>" / «Копия: спит с <time>»; `stopped`: "Copy: stopped" / «Копия: остановлена», with `disk_full` "Copy:
    stopped: disk full" / «Копия: остановлена: диск заполнен», with `setup` "Copy: stopped: the company's settings
    cannot be written here" / «Копия: остановлена: настройки компании нельзя записать на этой машине».
  - `why`: `server` "The company server runs here." / «Здесь работает сервер компании.»; `next` "Gets a copy if one of
    the first three leaves." / «Получит копию, если одна из первых трех машин уйдет.»
  - `unfit`, after "Holds no copy: " / «Не хранит копию: »: `phone` "it is a phone." / «это телефон.»; `no_core`
    "Hornhoof runs here without Docker." / «Hornhoof работает здесь без Docker.»; `scope` "<person> does not see the
    whole company." / «<person> видит не всю компанию.»; `no_link` "the company has no link at hornhoof.org; turn it
    on in Settings." / «у компании нет ссылки на hornhoof.org; включите ее в Настройках.»; `measuring` "measuring
    this machine." / «машина еще измеряется.»; `memory` "Docker has <x> GB of memory here; a copy needs 4 GB." /
    «Docker получает здесь <x> ГБ памяти; копии нужно 4 ГБ.»; `disk` "<free> GB free; a copy needs <need> GB." /
    «свободно <free> ГБ; копии нужно <need> ГБ.»; `fsync` "the disk saves slowly (<p99> ms); a copy needs under 50
    ms." / «диск сохраняет медленно (<p99> мс); копии нужно меньше 50 мс.»
  - `leftAt`: "Stopped holding the company's data on <date>. If it may be in other hands, change the company secret
    and the API keys." / «Перестала хранить данные компании <date>. Если она может быть в чужих руках, смените секрет
    компании и API-ключи.»
  - The tab's line, under the intro: one copy "<leader> leads. <copy> keeps a copy and takes over if <leader> stops."
    / «<leader> ведет компанию. <copy> хранит копию и возьмет сервер, если <leader> остановится.»; two "<leader>
    leads. <a> and <b> keep copies; <sync, else a> takes over if <leader> stops." / «<leader> ведет компанию. <a> и
    <b> хранят копии; <sync, else a> возьмет сервер, если <leader> остановится.»; with `onlySince` a second line
    "Only <leader> holds changes since <time>." / «Только <leader> хранит изменения с <time>.»
  - Times and dates as the tab writes them today. The line says "takes over" as the spec does; plan 10 makes it so,
    and nothing of the series ships before it.
- The card shows `why`, then `copy` or `unfit`, then `leftAt`, each on its own line, under the owner.

- [ ] **Step 1: Write failing tests.**
  - `copies-view.test.ts`, on `testApp` with rows and fakes for the slot catalogs: one case per `CopyLine` (`making`
    40, `remaking` 10, `stopped` with each `why`, `asleep` with no walsender and with a report 3 minutes old,
    `behind` 4 from a `copy_at` 4.5 minutes behind the pulse, `ready` with `keeper.json` naming it `pace`,
    `catching_up` with a `copy_at` 30 s behind and `keeper.json` naming it `behind`, and `catching_up` with a
    `copy_at` equal to the pulse and no `keeper.json`); `onlySince` null with no copy ever, null with one `pace`, the
    newest `copy_at` with one `catching_up` and one asleep.
  - `nodes.test.ts`, `shows the order and the copies to those who see the whole company`: the CEO's answer has `data`
    and `copies`; a listed person's has neither.
  - `Machines.test.tsx`: `writes a copy's line`: a machine with `making` 40 shows "Copy: being made, 40%", and in
    Russian «Копия: создается, 40%»; `says who holds the company`: one copy gives the EN and RU lines above with the
    hostnames; two copies name both and the sync one; `onlySince` adds its line; `says why a machine holds no copy`:
    `memory` 3.2 shows "Docker has 3.2 GB of memory here; a copy needs 4 GB."; `tells the CEO a machine left`:
    `leftAt` shows the line with its date.
  - `i18n.test.tsx`, `words copies in both languages`: each new string of `machines.copy` exists in both files, and
    the Russian ones hold no `ё`, no em dash, no «компьютер» and no «узел».
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the view, the route's fields, the tab and both language files.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Show each machine's place in holding the company's data and its copy's state".

### Task 12: The lab: a writer, a checker, copies and a lost scope

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 11 committed. **Done when:** from the
worktree root `npm run test:lab` passes with Docker running; `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing.

**Files:**
- Create: `apps/server/test/lab/copies.test.ts`, `apps/server/test/lab/writer.ts`
- Modify: `apps/server/test/lab/lab.ts` (`relay`, the host's name in each machine), `apps/server/test/lab/steps.ts`
  (`installServer`'s relay, `joinWorker` for any person)

**Interfaces:**
- `lab.ts` starts each machine with `--add-host host.docker.internal:host-gateway`, so a Linux Docker gives the name
  as Docker Desktop does, and gains `relay(): Promise<{ url: string; fake: FakeRelay }>`: plan 1's `FakeRelay` served
  by the test process on a free port of every interface; `url` is `http://<address>:<port>`, the address `getent
  hosts host.docker.internal` gives inside m1, so the containers inside m1, which do not have the name, reach it by
  address. No frps runs in the lab: after the link is on, the test calls
  `fake.register(<link name>, <the client id in m1's link frpc config>)`, as frps would, and again after anything
  that restarts m1's link frpc.
- `steps.ts`: `installServer(m, { relay })` writes `RELAY_URL`; `joinWorker(server, m, person)` joins as that person's
  session.
- `writer.ts`: `startWriter(m: LabMachine, session: string, everyMs = 200): { stop(): Promise<string[]> }` creates a
  task every `everyMs` through m's API and keeps each id whose answer was 2xx; `checkRows(m, ids)` answers the ids
  missing from m's `tasks` (by `psql` in its `db`).
- `copies.test.ts`, one scenario, 40 minutes at most, `df -h /` and `docker system df` first as plan 7's Task 10 says:
  1. m1 a server with the lab's relay, set up, the link on and registered; `node -e` in m1's `keeper` container
     fetches the relay's `url` and gets an answer. m2 joined by the owner, m3 by a person P whose scope is the whole
     company.
  2. Within 5 minutes m2 is number 2 and m3 number 3, both of the role `data`; within 15 minutes both `ready`; each
     one's `.env` has the three secrets, `COMPOSE_PROFILES=data` and `HORNHOOF_ROLE=data`, and `docker compose ps`
     lists `db` and `app` and no `node`; the fake relay's record is `on` with m2's network id; m1's `GET
     /api/machines` has `copies` with the leader m1, m2 with `sync` true and m3 with `sync` false, and `onlySince`
     null.
  3. The writer on m1 for the rest of the scenario. m2's `db` paused (`docker pause` in m2): within 5 s a task is
     created; the record is `on` with m3's network id within 60 s, or `off`; m2's `data.copy.line` is `asleep`. m2's
     `db`
     unpaused: within 3 minutes the record names m2 again. `checkRows` of m2 and m3 are empty once both are `ready`.
  4. P's access patched to one department: at once m3 has no number, the role `worker` and `upload_state` `waiting`,
     and the fake relay's link key changed. Within 10 minutes m1 has a merge `upload:...` whose status is `merged` or
     `done`, a `fork` row in `net.backups` and no `hornhoof_upload_*` database; m3's `.env` has empty
     `HORNHOOF_SECRET`, `NODE_KEY` and `POSTGRES_PASSWORD` and `HORNHOOF_ROLE=worker`, its `docker volume ls` has no
     database volume, its control folder has no `dumps/`, `replica.json`, `wipe.json` or `wiped.json`, m1's
     `/control/uploads` is empty and m1 has no `hornhoof_uploading_*` database, and m3's row has `upload_state` null
     and a `data_left_at`.
  5. A bundle on m1 and its restore (`bringBack` true), as plan 8's lab: within 15 minutes m2 is `ready` with a new
     attempt, m1 has no `copy_%` slot of an older attempt, m2 has no `hornhoof_old_*` or `hornhoof_next` database, and
     m1's `net.merge_conflicts` has no row of a `machine:` merge.
  6. The writer stopped: `checkRows` of m1 and m2 for every id it kept are empty, those written between the
     restore's bundle and the restore included, which the merge of the kept database brought back.

- [ ] **Step 1: Write the failing test** and the helpers; `npm run test:lab` fails at its step 2.
- [ ] **Step 2: Fix** what it finds in Tasks 2 to 11, each fix with its failing test first in that task's test file.
- [ ] **Step 3: Check the disk, then run Done when,** as plan 7's Task 10 Step 3. Expected: PASS.
- [ ] **Step 4: Commit** "Test copies in the lab: a writer and a checker, a sleeping copy, a lost scope, a restore".

### Task 13: Run everything and review

**Repo:** the `network` worktree, branch `network`. **Starts from:** Tasks 1 to 12 committed and reviewed. **Done
when:** Steps 1 and 2 pass for the agent; Step 3 is the team lead's, never an agent's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` and `npm run
  test:lab` (after the disk check) → pass; the `tsc` commands → no output; `bash -n` and `shellcheck` on
  `apps/updater/updater.sh` → no output.
- [ ] **Step 2: Check the public-repo rule.** As plan 7's Task 11 Step 2.
- [ ] **Step 3: Review.** The team lead reads the branch against spec 3.3, 3.4, 3.7, section 10's "Secrets" and "A
  stolen machine", section 12's bullets on pairs, the writer and the checker and the lost scope, the overview's plan 9
  entry, plan 8's ruling 1 a), b) and d), and this plan's rulings, with Review Focus first; the CLI agent that did not
  write a task reviews it too; one fix pass, each fix with its failing test first.

The rehearsal, the merge into main, Ivan's Updates and the worktree's close are done once, for the whole series, at
its end. This plan's part of that rehearsal is Task 12's scenario.

## Addendum: a Mac's changed address (p5b:214-218)

Plan 5b's ruling 11 says of a Mac server whose address changes: "plan 9's copies, which dial it, tell it", and "A Mac
address that changes after that is plan 9's". No task of this plan does it. Spec 3.2 asks for it: "peers tell the
Mac's keeper the source address they saw on its authenticated connections", and "Addresses are stored on the machine's
row, so a copy knows them without hornhoof.org".

The direction in p5b is the wrong way round: a copy that dials the Mac sees its own source address, not the Mac's.
What tells the Mac is the Mac's own dial. A `hello` answers `seen`, the source address it saw (p5:600, 630), and from
this plan's Task 4 the leading keeper has a `PeerLink` that dials each copy and hellos it every `helloMs`. So
everything is there but one wire: plan 5b's data keeper reports `ownAddresses` with its `HORNHOOF_ADDRESSES` and no
`seen` (p5b:813), where the worker's report has `PeerLink.seen()` (p5b:793). A follow keeper reports as a worker, so a
Mac that is a copy already tells. Only the leading keeper needs the wire.

What this leaves as it was, and why that is enough: a Mac server with no copy dials nobody, so it stays on the relay's
path for its workers until `install.sh` runs there again (p5b ruling 11), and the spec's words reach no further, since
it has no authenticated connection to be seen on. A session through the relay is seen as `127.0.0.1`, which
`ownAddresses` drops, so a copy in another home tells nothing, and needs nothing. The old address stays first in the
list until `install.sh` runs again, which costs a new dial 3 s (p5b ruling 6) and gives a stranger at that address
nothing, since a peer checks the certificate.

### Task A1: The leading keeper reports the address its copies saw

**Repo:** the `network` worktree, branch `network`. **Starts from:** this plan's Task 12 committed, before Task 13.
**Done when:** from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/keeper.test.ts
test/peer-link.test.ts test/addresses.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/src/modules/keeper/keeper.ts` (the report's `addresses`), `apps/server/src/net/peer-link.ts`
  (`seen`, only if the test below asks it)
- Test: `apps/server/test/keeper.test.ts`, `apps/server/test/peer-link.test.ts`

**Interfaces:**
- Consumes: plan 5b's `ownAddresses({ controlDir, env, seen, now })`, `PeerLink.seen()`; Task 4's
  `KeeperOptions.dial`.
- The leading keeper's report: `addresses: ownAddresses({ ..., seen: dial?.seen() ?? [] })`. With `reportAs` set, as
  today.
- `PeerLink.seen()` answers what the hellos of its open sessions say now, so a session that ended takes its address
  with it.

- [ ] **Step 1: Write failing tests:**
  - `keeper.test.ts`, `reports the address its copies saw`: a leading keeper with `HORNHOOF_ADDRESSES` `192.168.1.5`
    and a fake `dial` whose `seen()` answers `['192.168.1.9']`: within 2 s the server's row has `addresses`
    `192.168.1.5` and `192.168.1.9`. `seen()` answering `['127.0.0.1']`: the next report has `192.168.1.5` alone.
    `dial` null: `192.168.1.5` alone.
  - `peer-link.test.ts`, `forgets what a session that ended saw`: a session whose hello said `seen` `192.168.1.5`
    closes, and a new one says `192.168.1.9`: `seen()` is `['192.168.1.9']`.
- [ ] **Step 2: Run** Done when. Expected: FAIL: the row has `192.168.1.5` alone.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Report the address a leading machine's copies saw, so a Mac that moves is reached directly
  again".
