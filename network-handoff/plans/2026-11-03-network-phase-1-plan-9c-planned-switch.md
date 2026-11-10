# Network Phase 1, Plan 9c: The Planned Switch and Updates Across Machines, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CEO presses "Move the server here" on a numbered machine's card. Hornhoof gives that machine a copy if it
has none, names it the sync copy, and once it keeps pace hands the server over in about 10 s: the leader stops writes,
waits until the copy holds every change, and lets go of the link; the copy takes the link at hornhoof.org, promotes
itself and leads as number 1, and the old leader follows it as a copy, as do the other copies. One Update moves every
machine: copies promise not to take over, the database is saved only once they hold every change, sync is off while
migrations run, a rollback drops the slots first, copies remake themselves after migrations, and then each copy installs
in its turn. Every data machine runs its own built-in node, so API-key turns survive a switch. The relay counts its
outbound traffic per month.

**Architecture:** One migration, `0057_switch`: `net.move` (the CEO's request and its state), `net.handovers` (the new
leader's record of each planned switch, spec 3.7's "record for the old leader"), `net_local.state` gains the handover it
ended with, and `jobs`, `agents` and `test_parts` gain the machine of their built-in node. The switch's decisions are
pure (`modules/keeper/switch-step.ts`); the leading keeper hands over (`handing.ts`), the follow keeper takes over and
promotes (`taking.ts`, `promote.ts`), over new peer paths `/peer/switch/*`, each side keeping its phase in a file of its
keeper folder so a restart goes on where it was; a keeper changes kind by exiting, and compose starts it again as the
other. On the app, `modules/copies/move.ts` takes the CEO's request, gives the target its copy, and the sync controller
names it. The updater chooses its path (lead, copy, worker) by what the machine is now and its installer by how the
machine was installed; the leading keeper gets the copies' promises, waits for their slots before the dump, turns sync
off for migrations and drops the slots before a restore (`update-steps.ts`); the follow keeper keeps its promise
(`updating.ts`). The hub knows each machine's built-in node. The relay's addendum A2 counts the droplet's outbound
bytes.

**Tech Stack:** TypeScript on Node 22 (`node:http2`, `node:https`, `fetch`); Postgres 17.11 logical and synchronous
replication; Fastify 5; drizzle-orm 0.45.4 on node-postgres and PGlite; bash 3.2 and BusyBox for `updater.sh`; Docker
Compose; React for the web app; vitest; Docker for `npm run test:real` and `npm run test:lab`; Python 3 for the relay's
addendum.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.4 "Planned switch" (steps 1 to 8, the copy made first and
named sync for the switch) and fences 1 to 4 as they hold during it; 3.7 "Promotion", "Sequences" and the publication
made before any slot; 3.9 "Built-in node"; 3.10 (the standby reads the link's name and key from its copy); section 2's
"Move the server here" with its inline confirm and the line "Mac takes the server once its copy is up to date (40%)";
section 4's rows "The CEO presses 'Move the server here'" and "Update fails, or the leader dies mid-update"; section 9
"Updates across machines" and "The maintenance state" (steps 1 to 11, "A machine that was offline"); section 12's
bullets for the planned switch, rollback with slots, sequences, the maintenance state surviving a rollback and a
built-in node's turn surviving a planned switch. Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 9's
entry (its relay part: decision 5, the traffic counter and the runbook line). Plan 9's ruling 1, which split plan 9 into
9, 9b and 9c; plan 4's ruling 9; plan 5's ruling 13. The approved mockup
https://claude.ai/artifact/Twnj15fdFN4Z1gT4Z2AgxT (`moveHere`, `moveAsk`, `moveYes`, `cancel`, and `prioBody`'s `move`).

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see them
fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only the
task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a test of
an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**Two repositories.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in the series' worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network` on its branch `network`, after plan 9b's last task is
committed there; no new worktree, since nothing of the series ships until the series merges into main, once, at its end.
Task 12 alone works in the relay repository, `/Users/0x/Projects/hornhoof-edge`, on its `main`, as plan 1's addendum A1
does.

**Handed over** (done on the `network` branch before this plan starts; none of it is shipped):
- Today's code: `NodeHub`, `NodeIdentity`, `BUILTIN`, `identityOf`, `sameNode` (`modules/nodes/hub.ts`); `jobsOf` and
  `failOpenJobs` (`modules/nodes/messages.ts`); the 26 uses of `BUILTIN` in `conversation/queue.ts`, `jobs/routes.ts`,
  `nodes/hub.ts`, `nodes/routes.ts`, `nodes/socket.ts`, `subscriptions/routes.ts`, `subscriptions/views.ts`,
  `testruns/pool.ts` and `testruns/runs.ts`; `jobs`, `agents` and `test_parts` (`builtin`) in `schema.ts`; `updater.sh`
  (`update`, `backup`, `applied`, `restore`, `go_back`, `install_new`, `unpack`, `write_status`, `handle_request`,
  `interrupted`).
- Plan 1: the relay client's `route`, `setSync`; `Route`, `SyncRecord`, `SyncPost`; `FakeRelay`
  (`apps/server/test/fake-relay.ts`) with `register`; the relay repo's `relay.py`, `hornhoof-relay`, `setup-relay.sh`,
  `hornhoof-relay.service`, `relay/test/`, and its README's headings.
- Plan 2: `Keeper`, `KeeperOptions`, `KEEPER_PORTS`, `keeper.json` (`readKeeperState`, `writeKeeperState`,
  `KeeperState`), `AppMode`; `front`'s hold (plan 4's ruling 12: `HOLD_MS`); maintenance read from `status.json`
  (`updaterBusy`) and `UpdaterStatus` (`modules/updates/control.ts`); `migrate.ts`; compose's `restart: unless-stopped`
  on `keeper`; updater revision 2 (the app stopped right before the dump).
- Plan 3: `net_local.state`, `net_local.lease`, `net_local.maintenance`; `LeaseStore` (`take`, `renew`, `fence`,
  `endSessions`); `nextLeaseStep`; `keeperSql`; `Keeper.term()`; the keeper's answer to `GET /api/network/lease?nonce=`
  on its link doors (plan 3's Task 5); ruling 8 (a new term at every keeper start).
- Plan 4: `builtinKey(nodeKey, machineId)`, `run --builtin` with `HORNHOOF_MACHINE_ID`, `socket.ts`'s `identify` of a
  `builtin.<m>.<hex>` bearer; the node through `front`; `failOpenJobs(..., 'machine_restarted', running)` at hello.
- Plan 5: `findThisMachine`, the leader's hidden `server:<machine id>` row (its ruling 6); `PeerServer` and its peer
  paths, `peerClientFor`; `CertificateKeeper`; `TunnelKeeper` and `linkClientId(name, machineId)`; `LinkListener`.
- Plan 5b: `WorkerKeeper`, `workerConfig`, `WorkerConfig`, `WorkerView`, `DataMachine`, `WorkerLink`, `workerView`,
  `PEERS_FILE`; `PeerLink` (`leader()`, `request`, `stream`, `connectDb`, `Hello`); `builtinMachine`, `shownMachine`;
  `disconnectMachines`, `disablePerson`'s disconnect; the worker's updates (`leaderBuild`, `goodGrant`, `tryGrant`,
  `followOf`, `holdsMachine`, `go.json`, `follow.json`); `install.sh server` and `worker`; the lab (`Lab`, `LabMachine`,
  `steps.ts`).
- Plan 7: the CEO's check on the people's routes (`not_owner_session`); `errorText`.
- Plan 8: `BOOKKEEPING` and the merge's rules (`modules/merge/rules.ts`).
- Plan 9: `machines.role`, `copy_state`, `copy_progress`, `copy_name`, `server_order`, `server_pin`, `server_why`,
  `upload_state`; `qualify.ts`; `order.ts` (`COPIES`, `Ranking`, `rankOf`, `candidates`, `rank`); `scope.ts`
  (`cutReplication`, `leaveData`); `FollowKeeper`, `followConfig`, `FollowConfig`, `keeperRole`, `REPLICA_FILE`
  (`replica.json`); `CopyMaker`, `CopyReport`, `CopyOrder`, `COPY_STATE`, `SCHEMA_FILE`, `copyName`; `DbDoor`,
  `replicaPassword`, `PUBLICATION`; `SyncController`, `nextSyncStep`, `SyncSample`, `SyncMemory`, `CopySample`,
  `lsnAtLeast`, `sweepSlots`; `net.pulse`; the remake by the leader's count of migrations (its ruling 14), its swap and
  `copy-state.json`'s phases; the guard of its ruling 12 (`stopped`, error `led`); the merge of a copy that never wrote
  by one id-set read (its ruling 15); `become_data`, `schema_request`, the upload and the wipe in `updater.sh`;
  `compose.worker.yaml` with `node` in the profile `builtin`; `GET /api/machines`' `data` and `copies`; the lab's
  `copies.test.ts`, `writer.ts` (`startWriter`, `checkRows`) and `relay()`.
- Plan 9b: `rankOf`, `planRoles` and the handover of a copy (`modules/copies/order.ts`); `net.ranking`; `setPriority`
  and `PUT /api/machines/:id/priority`; `CopyOrder.lastAttempt`; `DataView` (`number`, `why`, `pin`, `unfit`, `copy`,
  `leftAt`) and `priority` in `GET /api/machines`; the card's Priority part and `machines.priority` in both language
  files; `CopySample.number` `Infinity` for a data row with no number.
- Where the branch's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`; in Russian a plan is «тариф».
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`, `.superpowers/`,
  `archive/`, `companies/`, `deploy.env`. The relay repo's commits are `commit -s` with the same name and email, as plan
  1's.
- Nothing private in either repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys and passwords made at run time. The runbook line goes into the team lead's private
  `~/.hornhoof-edge/droplet/README.txt`, never into a repo.
- No new npm dependency, and no new Python package in the relay. One new migration, `0057_switch`: `npx drizzle-kit
  generate --name switch` from `apps/server` for what `schema.ts` describes, with the hand-written part of Task 1
  appended after a `--> statement-breakpoint`; never an edit of an older one. Its number follows plan 9b's `0056`; the
  series' migrations are numbered again at the merge into main.
- One leader at a time (spec 3.4): the old leader writes nothing after it fenced, and the new one writes nothing, its
  app included, before its promotion ended; after the old leader sent "go", it leads again only on the new one's word.
  Hornhoof moves the server only on the CEO's request (spec 3.3); nothing here starts a switch by itself.
- No confirmed write is lost (spec 3.4, section 9): the new leader promotes only once its slot confirmed the old
  leader's last position W, a copy joins the new leader with `copy_data = false` only when it confirmed W, and the
  update's dump is taken only after every promised copy confirmed W, else the update ends with nothing changed. No
  database is thrown away before it is merged (spec 3.7, plan 9's Global Constraints).
- Messages between keepers and apps change only by additions (spec section 9): a keeper of plan 9b's build that does not
  know a peer path answers 404, which reads as "not ready", and a status or view without the new fields keeps what it
  had.
- Ivan's rules: only a machine's owner opens computer access to it; no step of this plan asks Ivan to type a command.
  The CEO only presses "Move the server here" or Update; everything else happens by itself.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; `npm run test:real` and `npm run test:lab` need Docker. Types, from the worktree root: `npx tsc
  -p apps/server/tsconfig.json --noEmit`, and `apps/web` likewise when touched, each printing nothing. `bash -n` and
  `shellcheck` on `apps/updater/updater.sh` print nothing when it is touched. Never run prettier.
- Before a real or lab run on the team lead's Mac: `df -h /` and `docker system df`; clean only build cache and
  `hornhoof-lab/*` images, never a volume.

## Rulings made while planning

1. **What this plan takes.** Plan 9's ruling 1 gave it "Move the server here" (3.4 "Planned switch") with 3.7's
   promotion and sequences, section 9's updates across machines (the promise, the slot wait before the dump, sync off
   for migrations, rollback with slots, copies remaking after migrations, a copy's own update order), the built-in
   node's identity per machine (plan 4's ruling 9, which plan 5's ruling 13 moved to plan 9), and the relay's traffic
   counter with its runbook line. Plan 9b left it the promotion making the new leader 1, which 9b's ranking does at the
   new leader's first lead. Left to plan 10 (ruling 12): the heartbeats, B's promise outside a switch, the takeover, the
   switch banners of section 2 and the old leader's note on its card.
2. **The CEO's request** (section 2, spec 3.4). `net.move` holds one request at a time: its id (new for each request,
   and the id of the switch it leads to), its target machine, who asked and when, its state (`preparing`, `switching`,
   `failed`), a failure's reason, and the machine that led when it was asked. `POST /api/machines/:id/move`, the CEO
   only (plan 7's check), on a machine with a number from 2: it stores the request (a new one replaces a `preparing` or
   `failed` one) and runs the ranking, which gives the target the role `data` at once if it has not got it, past
   `COPIES` too (spec: "A first makes its copy if it has none (number 4 or later)"), and retires it by no rule while the
   request stands. The sync controller names the target as soon as its copy finished and kept pace for 30 s, through
   "sync off" if another copy is named, and no lower number replaces it meanwhile (spec: "names it sync (3.7), for the
   switch even over a lower number"). The leading keeper starts the switch once the target is named, "on" for it is
   stored, and it keeps pace (ruling 3). Refused: the leader's own row (409 `already_leader`), a machine with no number
   (409 `no_number`), while the updater runs (409 `updating`), while a switch runs (409 `switching`); outside lead 503
   as every writing route. Two additions, for the team lead to rule on: `DELETE /api/machines/:id/move` cancels a
   request that is `preparing` or `failed` (the card's Cancel beside the waiting line), and a request still `preparing`
   after 24 hours fails with `expired`, so a copy that never finishes does not hold a move forever. The target's card
   says, in its Priority part: "<host> takes the server once its copy is up to date (<p>%)" while its copy is being
   made, the same without the share once it finished, "Moving the server to <host>." while switching, and "The server
   stayed on <leader>: <reason>" for 24 hours after a failure, to everyone who sees that part; the buttons only to the
   CEO.
3. **The switch, step by step** (spec 3.4 steps 1 to 8). A is the leading keeper, B the target's follow keeper. Each
   keeps its phase in its keeper folder, A in `handing.json` (`offered`, `stopped`, `go`, `followed`) and B in
   `taking.json` (`offered`, `go`, `promoted`, `aborted`), written before the act it stands for, so a keeper that starts
   again goes on from it, and doing again on start whatever act of its phase may not have finished (a fence, a stop, a
   disable). A talks to B over its peer client, B answers on its peer server: `POST /peer/switch/offer`, `POST
   /peer/switch/go`, `POST /peer/switch/abort`, `GET /peer/switch/state`. The offer is taken only from the machine B's
   link names as leader; B keeps that machine in `taking.json`, and `go`, `abort` and `state` are taken only from it,
   since A's hello says `lead: false` once it fenced. Each switch has an id, the request's (`net.move.request`), which
   every message and both files carry; a message of another id is refused, one of the same id again changes nothing. The
   deadline is the offer's time plus 60 s (spec step 8).
   - Step 1: A offers once the target is ready (ruling 2). It first claims the request it sampled (`preparing` to
     `switching` by its id, under the lock the routes take), then writes `offered`, then sends the offer; a request
     replaced or cancelled meanwhile is not claimed. B accepts when its copy is `ready` and its subscription enabled,
     and writes `offered`.
   - Step 2: A writes `stopped`, closes its front door (so every `front` holds, plan 4's ruling 12), says `lead: false`
     in its hello, fences (`LeaseStore.fence()`: an expired lease, the app's and agent roles' sessions ended), takes no
     lease while `handing.json` is there, and only then records `fenced`; a keeper that starts in `stopped` without
     `fenced` closes and fences again before anything else.
   - Step 3: A reads W after the fence and waits until B's slot confirmed W, then up to 10 s more for the other copies
     whose copy is `ready` and that have a walsender; those that reached W are `copies`. A copy still making its first
     copy is never among them. A writes `go`, then sends `go` with W and `copies`, again each second while B answers
     `offered`. B answers 200 only before its deadline and with its subscription enabled and its apply worker running,
     and writes `go`. B's slot on A at W is the barrier: a subscriber reports a position as flushed only once every
     transaction before it is applied and flushed, and with `streaming = off` it applies in order (PostgreSQL 17's
     `worker.c`, `send_feedback` and `get_flush_position`); B's own origin progress is no barrier, since it stays at the
     last published commit while W runs on over WAL nobody publishes.
   - Step 4: A stops its link frpc and keeps it stopped while `handing.json` is there.
   - Step 5: B disables its subscription, then becomes a leading keeper that takes no lease yet (ruling 4): its link
     frpc registers the name, and once the relay's `route` names B's client, B checks its nonce: `GET
     <base>/api/network/lease?nonce=<22 random base64url>` answers B's machine id and that nonce; `<base>` is the link's
     `https://<host>`, or `HORNHOOF_LINK_PROBE`, which only tests set.
   - Step 6: B promotes (ruling 5) if the deadline has not passed. Its term written, there is no abort.
   - Step 7: A sees `leading` in B's `state` and follows (ruling 6).
   - Aborts. Before it sent `go`, A alone decides: B does nothing without `go`, and its `offered` ends at the deadline.
     A sends `abort` (its answer is not needed), removes `handing.json`, opens its front door, starts its link frpc, and
     leads again under a new term (plan 3's ruling 8: one above its own, (T + 1, A), as the spec's re-entry says); once
     it leads it marks the request `failed` (`no_answer`, `not_ready`, `behind`). After `go`, only B's word counts: B
     aborts when its name or nonce fails or the deadline passes before its term (link frpc stopped, subscription enabled
     again, `aborted` with the reason and `follow: (T + 1, A)`, kept 10 minutes); A, asking `state` each second,
     re-enters on `aborted` as above. B's word may also be `none`: no `taking.json` of that switch and no handover of it
     recorded, so B never took `go` for it and never can (its `go` needs `offered` of that switch, and the follow keeper
     ends an `offered` at B's deadline), and A re-enters (`no_answer`); an `offered` answer is not that word, since a
     late `go` may still reach B before B's own clock passes the deadline. B answers `leading` only once the handover is
     recorded with every slot (promotion step 6), from `net.handovers` once its `taking.json` is gone, so an A that
     comes back late still learns that B leads; with its term written and no handover yet it answers `go`, which A
     cannot abort on. A that hears nothing keeps asking (deviation, ruling 12: the spec gives that case to the takeover
     rule, which is plan 10's).
4. **A keeper changes kind by exiting** (deviation in form; the spec does not say how). `keeperRole` reads the keeper
   folder as well: `taking.json` in phase `go` or `promoted` makes a leading keeper that is taking over; `handing.json`
   a leading keeper that is handing over; then plan 9's `replica.json` or an enabled subscription a follow keeper; else
   a leading keeper. A keeper whose kind must change writes its files, closes its listeners and exits 0, and compose's
   `restart: unless-stopped` starts it again within seconds as the other kind. Every `front` holds meanwhile, as it
   holds for any keeper restart.
5. **Promotion** (spec 3.7, steps 5 and 6), by B, each step checked first so a restart goes on:
   1. The term: `net_local.state` of (one above the highest of A's term, every `net.journal.term_number` and its own
      state's, B), unsplit, with B's cluster. A row of B's already above A's term is this attempt's own (B writes
      nothing between `go` and here), so a restart keeps it.
   2. The subscription detached (`slot_name = NONE`) and dropped.
   3. Every sequence owned by a column of a table in `public` set to that column's maximum plus 1000, unless it already
      stands higher.
   4. The publication `hornhoof` made when missing, before any slot (spec 3.7).
   5. A slot for A and for each of `copies`, named `copyName(<its network id>, <the attempt of its row's copy_name, 0
      without one> + 1)`, so no old subscription of that machine can attach to it.
   6. One commit: `net.handovers` gets the record of the old leader under the switch's id (its row, its term, W, B's
      row, the time and the slots' names), and `net.move` is deleted.
   7. `replica.json` and `copy-state.json` removed; `promoted` written.
   8. The lease taken as at every keeper start, which makes the term (M + 2, B), M the highest number step 1 saw, (T +
      2, B) when that is A's (deviation in form: the spec says (T + 1, B); terms only need to grow). The front door
      opens; the sync controller starts as any leading keeper's: "sync off" at B's new generation, then the first copy
      in the order once it kept pace (deviation in form: the spec sets sync at promotion; A subscribes only after it, so
      a set sync would make the first commits wait and take the "sync off" path anyway). The app leads once the flag
      allows, and 9b's ranking makes B 1 and ranks A. B answers `state` `leading`, with its term and the slots' names,
      from step 6's commit on, and removes `taking.json` once its app leads. From promotion until A joins, seconds as a
      rule, B commits with no copy confirming, exactly as under today's "sync off" (spec 3.4): B dying in that window is
      plan 10's takeover, with the same exposure as any "sync off", not a gap in this switch.
6. **The old leader and the other copies follow B** (spec step 7). On `leading`, A writes `followed`, then: its
   `net_local.state` records the handover (`handed_to`, `handed_lsn` W, `handed_at`); every replication slot of its own
   is dropped, walsenders ended first; its keeper folder gets `peers.json`, a view built from its own database (the data
   machines, the authority, the revoked serials and the link, its secrets opened with `HORNHOOF_SECRET`, `dataSecret`
   included), and `copy-state.json` in a new phase `join` with B's slot name for it; then plan 9's `replica.json` in the
   control folder, and A exits and starts as a follow keeper. `followConfig` takes the server's address from the view's
   link when `.env` has no `HORNHOOF_JOIN_SERVER` (a server's never has). The copy maker's `join` makes the subscription
   to that slot with `create_slot = false` and `copy_data = false`, every table ready at once. A database whose state
   records a handover is no `led` database for plan 9's ruling 12 and counts as never written for its ruling 15:
   everything it wrote reached B before W. Every other copy learns its slot from B's view (`CopyOrder.join`), and its
   maker drops its old subscription and joins the same way; a copy that did not reach W gets no slot and remakes (plan
   9's ruling 14). A view from a new leader counts toward no remake rule until that leader's views named no `join` for
   the copy twice in a row, so a copy that reached W is never made again.
7. **Any data machine may lead.** A machine installed by `install.sh server` may follow, and a machine that joined may
   lead, so:
   - The updater's path follows what the machine is now: `lead` with no `replica.json` and `HORNHOOF_ROLE` not `worker`;
     `copy` with `replica.json`; `worker` with `HORNHOOF_ROLE=worker`. Its installer follows how it was installed:
     `install.sh worker` with `compose.yaml` and `compose.worker.yaml` when `.env` names `COMPOSE_FILE`, else
     `install.sh server` with `compose.yaml`. The `copy` path is plan 9's (a worker's: no backup, no migrations, the
     turn waited for) with the machine's own installer and files; the `lead` path checks health at `front` as a
     server's, whatever the installer. `install.sh worker` on a data machine (`COMPOSE_PROFILES` naming `data`) starts
     every service of the profiles but the updater, `db`, `migrate`, `app` and the built-in node included, not `keeper`
     and `front` alone as plan 5b's does for a worker; on a copy `migrate` does nothing (plan 9), on a joined leader it
     migrates.
   - The wipe of an install with no `COMPOSE_FILE` also writes `COMPOSE_FILE=compose.yaml:compose.worker.yaml` (that
     file taken from the image as plan 5b's `compose_from_image` does) and `HORNHOOF_JOIN_SERVER` from `wipe.json`'s new
     `server`, the link's address, so it works on as a worker.
   - Plan 5's `thisMachine` revokes the other live `server:` rows only when it inserts its own (a database brought to a
     new server); a leader that found its row, as B finds its joined computer's, revokes none, so A's certificate stays
     good after the switch.
   - A `server:` row is hidden only while it is the leader's own (`findThisMachine`); another one is listed as a machine
     with its hostname from its reports (plan 5b), number, copy and Priority part, and the `/api/machines/:id` routes
     take it. Its Disconnect answers 409 `server_install`: the machine where the company was installed is not a joined
     computer (plan 5's ruling 6).
   - Where a machine leaves, the leader is refused: Disconnect of the leading row and disabling its person answer 409
     `leader` "<host> runs the company server. Move the server to another machine first."; plan 9's `leader_scope` and
     9b's `leader_pin` stand.
8. **Each data machine's built-in node is its own** (spec 3.9 "Built-in node"; plan 4's ruling 9). The hub's identity
   becomes `{ kind: 'builtin', machine }`, the network id in the node's key (plan 4's `builtin.<m>.<hex>`); the bare
   `NODE_KEY` is the leader's own. Jobs, agents and test parts record the machine of the built-in node they went to
   (`builtin_machine`), and a built-in node touches only its own. An API-key agent stays on its machine's built-in node
   while it is ready, else goes to the leader's, else to any ready one, lowest number first, as a move (a fresh
   session). Each ready built-in node is a place for test parts. Copies run theirs (`COMPOSE_PROFILES=data, builtin`),
   and plan 5b's grant waits for their jobs too, while a granted machine's built-in node takes no new work. A built-in
   node's message source stays `node:builtin:<stream>:<n>` (plan 4's ruling 4; each node's stream id is its own), so a
   message sent before an Update and again after it is still applied once. On a planned switch A's built-in node
   reconnects through A's `front` to B and keeps its jobs (section 12).
9. **An update across machines, on the leader** (section 9 steps 2 to 9). The updater and the leading keeper meet
   through the control folder:
   - The updater learns before it asks anything whether the new build has migrations (its `_journal.json` entries above
     the database's `applied`) and writes it into `status.json`. A new step, `promise`, waits up to 30 s for the
     keeper's `promised.json`; refused or silent, the update ends "<why>, so nothing changed." The keeper sends each
     copy that is online and up to date (`sync` or `pace` in its sync controller) "updating until <now + 15 min>" (`POST
     /peer/updating`), sends it again every 5 minutes while the update runs, and answers ok only when every one answered
     (section 9: "without every acknowledgement the leader cancels the update"). No copy: ok at once. A keeper that
     starts again with the promise sent and no answer sends it again.
   - In maintenance (plan 3's lease, plan 2's step `backup`), the keeper writes `net_local.maintenance`, reads W and
     waits up to 60 s until each promised copy's slot confirmed it; with migrations it then has those copies disable
     their subscriptions (each answering once it did) and holds sync off, and waits until "off" is stored at the current
     generation and no copy is named; then `settled.json`, which says whether all of that happened. The updater's
     `backup` waits up to 120 s for it, before it stops the app for the dump; a `settled.json` that says no, or none,
     ends the update "The copies did not confirm the last changes, so nothing changed." and the maintenance state with
     it. Sync off comes before the dump here, not after it as the spec's step 6 says (deviation in form: nothing writes
     in maintenance, so the order changes nothing). The hold is kept in the keeper's file and set again when a keeper
     starts, before its sync controller's first step.
   - An updater that stops in `backup` goes on from `backup`, not from the start, so the maintenance state, which plan 2
     reads from the step, never lapses once W was read; it stops only in `promise` or `pull`, before W, to start over.
   - Before a restore in `go_back`, `status.json` says `restore`, and the keeper has the copies disable their
     subscriptions and drops every slot, walsenders ended first (today's `DROP DATABASE ... WITH (FORCE)` fails on an
     active slot), then `slots-dropped.json`; the updater waits up to 60 s for it, then ends the walsenders and drops
     the slots itself too, and restores only once the database has no slot left.
   - At the end the keeper deletes `net_local.maintenance`, tells the copies "update ended" and lifts the hold; the
     controller names a copy once one keeps pace (after migrations or a restore, once a copy remade itself). The end
     comes when plan 2 ends the maintenance state: on success, on a finished rollback, and on a failure (plan 2's
     ruling, approved there), once the keeper leads again.
   - The first update that meets copies is run by this plan's updater and keeper. No company runs a build of plan 9 or
     9b: the series reaches main and Ivan's companies once, at its end, from main's build, which has no copies, and an
     updater of before this plan, finding no promise step, updates as plan 2's (the keeper's rows for a status with no
     memory do nothing). An update from a build of plan 9 or 9b with copies is not supported.
   - An update is refused while a move is `preparing` or `switching` (409 `moving`), as a move is while the updater
     runs.
   - Deviation in form, step 1: machines download the new build once the leader runs it (plan 5b), not while it
     installs, so a failed update leaves nobody waiting on a build that went back; nothing stops either way. Updates are
     proven by unit tests, the updater's stub tests and the real pairs, a rollback with an active copy among them
     (section 12 asks rollback with slots of the pairs and the maintenance state of the updater's tests); the lab has no
     registry to update from.
10. **The copies during an update, and a copy's own order** (section 9 steps 2, 6, 10 and 11). The follow keeper takes
    `POST /peer/updating` from the leader: `{ version, until, migrations }` is written to `promise.json` in the control
    folder, with the leader that sent it, and to its own `net_local.maintenance` before it answers, so a restart keeps
    it; `stop`, `ended` and the renewals are then taken from that leader, whose hello says `lead: false` in maintenance.
    While a promise holds, its `keeper.json` says `maintenance`, its front door never passes to its own app, and its
    maker does nothing that a remake, a schema load, a swap or a new subscription would do, nor gives an attempt up: it
    keeps what it saw (the leader's count of migrations, a missing slot) and acts on it once the promise is gone,
    against the leader's view of then. `{ stop: true }` disables the subscription, and a keeper that starts or ticks
    with a stopped promise disables it again if it is enabled; `{ ended: true }`, or the promise's time passing, removes
    it, and the subscription is enabled again unless the leader's count of migrations changed or its slot is gone (plan
    9's remake). A copy installs the leader's build on the `copy` path (ruling 7) in its turn, one grant at a time with
    the workers (plan 5b), which waits for its built-in node's jobs too. Its own app may read a database of the other
    schema for the minutes between its install and its remake; that app answers only with no leader for 60 s (plan 9's
    ruling 4).
11. **The relay counts its traffic** (overview, decision 5). Addendum A2 to plan 1, in the relay repo: each minute
    `relay.py` adds what the interface of the default route sent since its last read to the UTC month's total in its
    SQLite; a reboot, another interface or a counter that went down counts from zero. Past 300 GB in a month it logs one
    line a day. `hornhoof-relay traffic` prints the last 12 months. The README's "What it stores" says so. The runbook
    line goes into the team lead's private `~/.hornhoof-edge/droplet/README.txt`. Deployed with the series' other relay
    work at its end, before the rehearsal, as A1.
12. **What plan 10 takes from here** (its entry in the overview gains it, approved with this plan): a planned switch
    whose peer link breaks after "go" leaves A fenced until B answers, and the takeover rule settles it (spec step 8);
    the leader dying mid-update while copies hold the promise (section 4's row); the banners "Moving the company to Mac"
    and the old leader's note. Until then the page holds for the switch's seconds and the badge moves.

## Review Focus

1. Two leaders writing at once: A writes after its fence, or leads again after it sent `go` without B's word; B writes
   anything, its app included, before its slots exist, or takes a lease before `promoted`. Tests in Task 3 (every row of
   `nextHandStep` and `nextTakeStep`), Task 6 (`takes no lease before it promoted`) and Task 7 (`never leads again after
   go without B's word`).
2. A confirmed write lost or doubled across the switch: B promoting before it applied W, a copy joining B with
   `copy_data = false` that never reached W, an old subscription attaching to B's slot, a sequence handing out a number
   already used. Tests in Task 4 (the real pairs: `promotes a copy and the old leader joins it`, `reaches W when only a
   checkpoint follows`) and Task 7 (`gives no slot to a copy that missed W`).
3. A keeper that stops in the middle of a switch, on either side: each phase of `handing.json` and `taking.json` found
   at start leads on, never to two leaders and never to none for good while both machines run. Tests in Task 6 and Task
   7 (`goes on after a restart in each phase`) and Task 11 (the lab restarts B's keeper during a switch).
4. An update with migrations that hangs on the sync copy, a dump taken before the copies confirmed W, or a restore that
   meets an active slot. Tests in Task 9 (every row of `nextUpdateStep`, the updater's order of steps with its stubs),
   Task 4 (`refuses to drop a database with an active slot, and drops it once the slots went`) and Task 9's real
   `update-rollback.test.ts` (a rollback with a copy subscribed and a migration applied).
5. A built-in node's job taken, failed or cancelled by another machine's built-in node, or an API-key turn ended by a
   planned switch. Tests in Task 2 (`keeps each built-in node's jobs apart`, `keeps a turn across a planned switch`) and
   Task 11 (m1's built-in node online on m2 under its own machine after the move).

---

### Task 1: The tables of the move, the handover and the built-in nodes

**Repo:** the `network` worktree, branch `network`. **Starts from:** plan 9b's last task committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/switch-schema.test.ts test/fence-lint.test.ts
test/merge-rules.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing.

**Files:**
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/modules/merge/rules.ts`
- Create: `apps/server/drizzle/0057_switch.sql` (generated, with the hand-written part appended) and its snapshot
- Test: `apps/server/test/switch-schema.test.ts` (new), `apps/server/test/merge-rules.test.ts`

**Interfaces:**
- Consumes: plan 9b's `net.ranking` as the pattern for a table of `net` (its trigger and how `rules.ts` treats it); plan
  3's `net_local.state`.
- Produces, described in `schema.ts` as 9b's `net.ranking` is:
  ```sql
  net.move (id boolean PRIMARY KEY DEFAULT true CHECK (id), request uuid NOT NULL DEFAULT gen_random_uuid(),
    machine_id uuid NOT NULL REFERENCES machines(id),
    from_machine_id uuid NOT NULL REFERENCES machines(id), asked_by uuid NOT NULL REFERENCES people(id),
    asked_at timestamptz NOT NULL, state text NOT NULL CHECK (state IN ('preparing', 'switching', 'failed')),
    reason text CHECK (reason IN ('no_answer', 'not_ready', 'behind', 'no_link', 'expired', 'left')),
    ended_at timestamptz,
    CONSTRAINT move_failed CHECK ((state = 'failed' AND reason IS NOT NULL AND ended_at IS NOT NULL)
      OR (state <> 'failed' AND reason IS NULL AND ended_at IS NULL)))
  net.handovers (id uuid PRIMARY KEY, from_machine_id uuid NOT NULL REFERENCES
    machines(id), term_number bigint NOT NULL, term_machine text NOT NULL, applied text NOT NULL, to_machine_id uuid
    NOT NULL REFERENCES machines(id), at timestamptz NOT NULL, slots jsonb NOT NULL DEFAULT '{}'::jsonb)
  jobs.builtin_machine, agents.builtin_machine, test_parts.builtin_machine: text, CHECK (builtin_machine ~
    '^[0-9a-f]{32}([0-9a-f]{32})?$')
  ```
  and by hand: both new tables get the trigger `net.ranking` has; `net_local.state` gains `handed_to text`, `handed_lsn
  text`, `handed_at timestamptz` with `CHECK ((handed_to IS NULL) = (handed_lsn IS NULL) AND (handed_to IS NULL) =
  (handed_at IS NULL))`.
- `rules.ts`: `net.move` as `net.ranking` (the leader's own state, never merged); `net.handovers` merged as an
  append-only log by its uuid; each `builtin_machine` beside its table's `node_id`, treated as that column is.
- `applied` is a WAL position as `pg_lsn` prints it; `slots` maps a network id to the slot made for it. A handover's
  `id` is the switch's, the `request` of the `net.move` row it ended; a replaced request gets a new `request`.

- [ ] **Step 1: Write failing tests** in `switch-schema.test.ts` (PGlite, as 9b's schema test):
  - `holds one move`: a second row is refused by the key; `state` `failed` with `reason` alone or `ended_at` alone is
    refused, and `preparing` or `switching` with a `reason`, with an `ended_at`, or with both, too; `reason` `late` is
    refused; a row with no `request` given gets one.
  - `records a handover`: a row with `slots` `{"<32 hex>": "copy_<16 hex>_2"}` reads back; a missing `applied` is
    refused.
  - `names a built-in node's machine`: `jobs.builtin_machine` takes 32 and 64 lowercase hex and refuses `ABC` and 33
    hex; the same on `agents` and `test_parts`.
  - `records the handover a state ended with`: `net_local.state` takes the three `handed_` columns all null or all set,
    and refuses one set alone.
  - `merge-rules.test.ts`: `net.move` is never merged, `net.handovers` merges by `id`, each `builtin_machine` is treated
    as its table's `node_id`.
  - `fence-lint.test.ts` as it stands: it must pass with the two new tables, which it checks for their trigger.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/switch-schema.test.ts
  test/merge-rules.test.ts`. Expected: FAIL (no such tables or columns).
- [ ] **Step 3: Implement** `schema.ts`, then `npx drizzle-kit generate --name switch` from `apps/server`, then the
  hand-written part after a `--> statement-breakpoint`; `rules.ts`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the tables of a server move, its handover and each machine's built-in node".

### Task 2: Each data machine's built-in node

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/hub.test.ts test/socket.test.ts
test/node-messages.test.ts test/queue.test.ts test/testruns.test.ts test/subscriptions.test.ts
test/network-follow.test.ts test/updater.test.ts` passes (the files that test those modules today; where a name differs,
the existing file is used), then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing;
`bash -n` and `shellcheck` on `apps/updater/updater.sh` print nothing.

**Files:**
- Modify: `apps/server/src/modules/nodes/hub.ts`, `nodes/socket.ts`, `nodes/messages.ts`, `nodes/routes.ts`,
  `conversation/queue.ts`, `jobs/routes.ts`, `subscriptions/routes.ts`, `subscriptions/views.ts`, `testruns/pool.ts`,
  `testruns/runs.ts`, `jobs/dispatch.ts`, `conversation/live.ts`, `tasks/reconcile.ts`, `tasks/wake.ts` (the other
  callers of `identityOf`), `network/follow.ts` (`tryGrant`), plan 5b's claims that take `holdsMachine`,
  `apps/server/src/main.ts` (the first lead's backfill), `apps/updater/updater.sh` (`become_data`),
  `compose.worker.yaml` (the comment on `node`), `apps/server/test/lab/copies.test.ts` (plan 9's lab: a copy now runs
  its built-in node)
- Test: the server's tests of those modules, `apps/server/test/updater.test.ts`

**Interfaces:**
- Consumes: plan 4's `builtinKey` and `identify`; Task 1's columns; plan 5b's `tryGrant`; plan 9's `become_data`.
- Produces:
  ```ts
  // modules/nodes/hub.ts
  export type NodeIdentity = { kind: 'node'; nodeId: string } | { kind: 'builtin'; machine: string };
  export const builtinOf = (machine: string): NodeIdentity => ({ kind: 'builtin', machine });
  export function ownBuiltin(config: { machineId: string | null }): NodeIdentity;
  //   builtinOf(machineId); with no machineId (an install not set up again since plan 4) builtinOf('0'.repeat(32)),
  //   the one built-in node such an install has
  export function identityOf(sub: { kind: 'personal' | 'api_key' }, nodeId: string | null, builtinMachine: string |
    null, own: NodeIdentity): NodeIdentity | null;  // an API key's: builtinOf(builtinMachine) or own
  //   keyOf gives 'builtin:<machine>'; NodeHub gains builtins(): string[], the machines of the attached, greeted
  //   built-in nodes; BUILTIN goes. Every caller of identityOf (queue.ts, jobs/dispatch.ts, conversation/live.ts,
  //   tasks/reconcile.ts, tasks/wake.ts) passes the agent's or job's builtin_machine and ownBuiltin(ctx.config)
  // modules/nodes/builtin.ts (new)
  export function pickBuiltin(ctx: Ctx, db: Db, current: string | null): Promise<string | null>;
  //   current while its node is ready; else the leader's own while ready; else the ready one whose machines row
  //   (by network_id) has the lowest server_order, nulls last, then by machine; null when none is ready
  export function builtinName(ctx: Ctx, db: Db, machine: string, t?: unknown): Promise<string>;
  //   'the built-in node' for the leader's own; 'the built-in node on <hostname>' for another
  ```
- `socket.ts`: the bare `NODE_KEY` is `ownBuiltin(ctx.config)` (a node of a build before plan 4); a `builtin.<m>.<hex>`
  that matches is `builtinOf(m)`. Every machine's built-in node of this build signs in with its own `builtin.<m>.<hex>`
  (plan 4's `run --builtin` with `HORNHOOF_MACHINE_ID`), so after a switch the old leader's node, reaching the new
  leader through its own `front`, is still `builtinOf(<its machine>)`.
- `jobsOf(builtinOf(m))`: API-key jobs whose `builtin_machine` is `m`. A job going to a built-in node gets that node's
  machine in the same statement that marks it sent; an agent of an API key gets `builtin_machine` when its program first
  runs there, as a plan's agent gets `node_id`.
- Message sources (plan 4's ruling 4): a built-in node's numbered messages keep the source `node:builtin:<stream>:<n>`
  whatever its machine, not `keyOf`'s `builtin:<machine>`; each node's stream id is a uuid made with its own outbox
  file, so two built-in nodes never share one, and a message applied before this build and sent again after it is found.
- `queue.ts`: an API key's agent runs on `pickBuiltin(ctx, tx, agent.builtinMachine)`; a machine other than its
  `builtin_machine` is a move (`moves: true`, a fresh session), as a plan's agent on another node is today; no ready
  built-in node is `machine_offline` as today.
- "Online" for an API key (`jobs/routes.ts`, `subscriptions/views.ts`): any built-in node ready. A cancel
  (`subscriptions/routes.ts`) goes to each job's own built-in node.
- Test runs (`runs.ts`, `pool.ts`): each ready built-in node is a place with key `builtin:<m>`, its name `builtinName`,
  `builtin: true`, `machineId` the row of that network id (null for the leader's own, as today), and a part sent there
  records `builtin_machine`. `GET /api/pool`'s `builtin` stays the leader's own, its `parts` those of the leader's own
  machine, and it gains `builtins`: each other attached built-in node, `{ machine, name, online, noRuns, load, loaded,
  parts }`. `GET /api/machines`: `builtin` stays the leader's own, and a machine's `running` also takes the agents and
  parts whose `builtin_machine` is its network id, as `builtinMachine`'s row takes the leader's own today.
- `main.ts`: at the app's first lead, in the hook that runs before nodes are let in, open API-key jobs, the agents of
  API keys that have run on the built-in node (`builtin` true), and queued or running test parts with `builtin` true,
  each with no `builtin_machine`, get the leader's own machine (rows from before this build).
- `tryGrant` (plan 5b) also waits while a job runs with `builtin_machine` the machine's network id or a test part runs
  there, for a copy as for a worker. A claim of work for a built-in node (a turn in `queue.ts`, a test part in
  `runs.ts`) takes plan 5b's `holdsMachine` for the live row of that node's network id, in the same transaction and lock
  as plan 5b's claims for a machine's nodes, so a machine holding a grant gets no new built-in work.
- `become_data` writes `COMPOSE_PROFILES=data,builtin`; `compose.worker.yaml`'s comment on `node` says copies run their
  built-in node; plan 9's lab expects `COMPOSE_PROFILES=data,builtin` and `node` among a copy's services.

- [ ] **Step 1: Write failing tests**:
  - hub: `keeps two built-in nodes apart`: `builtinOf('a…')` and `builtinOf('b…')` attached: both online, a message to
    one reaches only its socket, and a third socket for `a…` replaces only `a…`'s.
  - socket: `names a built-in node by its machine`: `builtinKey(NODE_KEY, m)` connects as `builtinOf(m)`; the bare
    `NODE_KEY` as `ownBuiltin`.
  - messages: `keeps each built-in node's jobs apart`: API-key jobs J1 on `a…` and J2 on `b…`, both running; `a…`'s
    hello listing none fails J1 as `machine_restarted` and leaves J2 running; `a…` cannot finish J2.
  - messages: `keeps a turn across a planned switch`: an app that leads with machine `b…` and a running API-key job J of
    `builtin_machine` `a…` (as replicated from the old leader); `a…`'s built-in node signs in with `builtinKey(NODE_KEY,
    a…)` and its hello lists J: J stays running, and J's result from that socket finishes it.
  - queue: `keeps an agent on its machine's built-in node`: with `a…` and `b…` ready and the agent's `builtin_machine`
    `b…`, its turn goes to `b…` with `moves` false; with `b…` gone, to the leader's own with `moves` true and the
    agent's `builtin_machine` the leader's; with none ready, `machine_offline`.
  - test runs: `offers each built-in node as a place`: two ready built-in nodes give two places `builtin:<m>`, named
    "the built-in node" and "the built-in node on <hostname>", and a part sent to the second has its `builtin_machine`;
    `/api/pool` lists the second in `builtins` with that part, and `GET /api/machines` puts it in that machine's
    `running`.
  - follow: `waits for a copy's built-in node`: `tryGrant` for a copy with a running API-key job of its
    `builtin_machine` grants nothing; once the job ended it grants. `gives a granted machine's built-in node no new
    work`: with a grant standing for the copy's row, a turn of an agent whose `builtin_machine` is that copy goes to
    another ready built-in node as a move, or waits as `machine_offline` with none, and no test part is sent to
    `builtin:<copy>`.
  - messages: `applies a built-in node's message once across the update`: a message of stream S, number 4, applied with
    the source `node:builtin:S:4` before this build; the same message again from `builtinOf(a…)` answers as already
    applied and changes nothing.
  - `updater.test.ts`, `becomes a data machine with its built-in node`: `become_data` writes
    `COMPOSE_PROFILES=data,builtin`.
  - main: `gives old built-in work the leader's machine`: an open API-key job, its agent with `builtin` true and a
    running test part with `builtin` true, all with no `builtin_machine`, have the leader's own machine after the first
    lead, before a built-in node's hello is taken; then that node's hello listing the job and the part keeps both.
- [ ] **Step 2: Run** the files of Done when. Expected: FAIL.
- [ ] **Step 3: Implement**; every one of today's 26 uses of `BUILTIN` goes through `builtinOf`, `ownBuiltin` or
  `pickBuiltin`, and `grep -rn "BUILTIN\b" apps/server/src` finds only `BUILTIN_NAME`, if kept.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Give each data machine's built-in node its own identity, jobs and test parts".

### Task 3: The switch's decisions

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/switch-step.test.ts` passes; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/switch-step.ts`
- Test: `apps/server/test/switch-step.test.ts` (new)

**Interfaces:**
- Consumes: plan 3's `Term` (`{ number, machine, split }`).
- Produces:
  ```ts
  export const SWITCH_MS = 60_000;         // the deadline: the offer's time plus this
  export const OFFER_WAIT_MS = 5_000;
  export const OTHERS_WAIT_MS = 10_000;    // the other copies, after B confirmed W
  export const BEHIND_MS = 10_000;         // B must confirm W this long before the deadline
  export const MOVE_WAIT_MS = 86_400_000;  // a request preparing this long fails as expired
  export const ABORTED_KEEP_MS = 600_000;
  export type MoveReason = 'no_answer' | 'not_ready' | 'behind' | 'no_link' | 'expired' | 'left';
  export type Handing = { switch: string; to: { machine: string; networkId: string; hostname: string }; term: Term;
    at: number; deadline: number; phase: 'offered' | 'stopped' | 'go' | 'followed' | 'aborted'; fenced: boolean;
    w: string | null; copies: string[] | null; slot: string | null; reason: MoveReason | null };
  //   switch: the request's id; fenced: the front door closed and LeaseStore.fence() returned, in this phase
  export type TakeState =
    | { state: 'none' }
    | { state: 'offered' | 'go'; switch: string }
    | { state: 'leading'; switch: string; term: Term; slots: Record<string, string> }
    | { state: 'aborted'; switch: string; follow: Term; why: 'no_link' | null };
  export type HandSample = { now: number; handing: Handing | null;
    move: { request: string; networkId: string; state: 'preparing' | 'switching' | 'failed'; askedAt: number;
      endedAt: number | null } | null;
    target: { numbered: boolean; data: boolean; named: boolean; onStored: boolean; pace: boolean } | null;
    leads: boolean; updating: boolean; offer: 'waiting' | 'accepted' | 'refused' | 'silent' | null;
    wConfirmedAt: number | null; othersAtW: string[]; othersOnline: string[]; state: TakeState | null };
  //   wConfirmedAt: when B's slot was first seen at or past W; othersOnline: the other copies whose copy_state is
  //   ready and that have a walsender; othersAtW: those of them whose slot confirmed W; state: B's answer for this
  //   switch, null while none came
  export type HandAction =
    | { do: 'none' } | { do: 'offer' } | { do: 'stop' } | { do: 'fence' } | { do: 'read_w' }
    | { do: 'go'; copies: string[] } | { do: 'send_go' } | { do: 'abort'; reason: MoveReason }
    | { do: 'reenter'; reason: MoveReason } | { do: 'ask' } | { do: 'follow'; slot: string }
    | { do: 'fail'; reason: MoveReason } | { do: 'forget' };
  //   abort and reenter write the phase aborted with the reason; fail marks the request failed and, from aborted,
  //   removes handing.json; send_go sends the stored go again
  export function nextHandStep(s: HandSample): HandAction;
  export type Taking = { switch: string; from: { networkId: string }; term: Term; at: number; deadline: number;
    phase: 'offered' | 'go' | 'promoted' | 'aborted'; w: string | null; copies: string[] | null;
    slots: Record<string, string> | null; why: 'no_link' | null };
  //   from: the machine that offered, as B's link named it leader then; go, abort and state are taken from it alone
  export type TakeSample = { now: number; taking: Taking | null; termWritten: boolean; registered: boolean;
    probed: boolean; appLeads: boolean };
  export type TakeAction =
    | { do: 'none' } | { do: 'expire' } | { do: 'register' } | { do: 'probe' } | { do: 'promote' }
    | { do: 'abort'; why: 'no_link' } | { do: 'lead' } | { do: 'done' } | { do: 'forget' };
  export function nextTakeStep(s: TakeSample): TakeAction;
  export function takeState(taking: Taking | null, handover: { switch: string; term: Term;
    slots: Record<string, string> } | null): TakeState;
  //   leading from the handover alone (recorded at promotion step 6); else none, offered, go or aborted from taking:
  //   a written term with no handover yet is go
  ```
- `nextHandStep`, the first row that matches (`handing` absent unless the row says its phase):

  | When | Action |
  |---|---|
  | no `handing`, move `failed` and `endedAt` over `MOVE_WAIT_MS` ago | forget |
  | no `handing`, move `preparing`, `askedAt` over `MOVE_WAIT_MS` ago | fail expired |
  | no `handing`, move `preparing`, target null, not `numbered` or not `data` | fail left |
  | no `handing`, move `preparing`, `leads`, not `updating`, target `named`, `onStored` and `pace` | offer |
  | no `handing`, move `switching` (claimed, never offered) | fail no_answer |
  | no `handing` | none |
  | `offered`, offer `refused` | abort not_ready |
  | `offered`, offer `silent` | abort no_answer |
  | `offered`, offer `accepted` | stop |
  | `offered`, offer null (a keeper that started again) | abort no_answer |
  | `offered` | none |
  | `stopped`, not `fenced` | fence |
  | `stopped`, `w` null | read_w |
  | `stopped`, `wConfirmedAt` null, `now` at or past `deadline - BEHIND_MS` | abort behind |
  | `stopped`, `wConfirmedAt` set, all `othersOnline` in `othersAtW` | go with `othersAtW` |
  | `stopped`, `wConfirmedAt` set, `now` at or past `wConfirmedAt + OTHERS_WAIT_MS` | go with `othersAtW` |
  | `stopped`, `wConfirmedAt` set, `now` at or past `deadline - BEHIND_MS` | go with `othersAtW` |
  | `stopped` | none |
  | `go`, state `leading` | follow with `state.slots[own network id]` |
  | `go`, state `aborted` | reenter with `state.why`, else `behind` |
  | `go`, state `none` | reenter no_answer |
  | `go`, state `offered` | send_go |
  | `go` | ask |
  | `followed` | follow with `handing.slot` |
  | `aborted`, `leads` | fail with `handing.reason` |
  | `aborted` | none |

  `abort` is A's own and comes only before `go`; nothing after `go` leads A back but `aborted` or `none` from B. Only
  the phases `offered`, `stopped`, `go` and `followed` hold A's lease back; in `aborted` A leads again at once and marks
  the request failed once it leads. `go` is always sent at least `BEHIND_MS` before the deadline: `wConfirmedAt` is set
  before `deadline - BEHIND_MS` or the abort row fires first. A state whose `switch` is not `handing.switch` counts as
  none came.
- `nextTakeStep`, the first row that matches:

  | When | Action |
  |---|---|
  | no `taking` | none |
  | `offered`, `now` at or past `deadline` | expire |
  | `offered` | none |
  | `go`, `termWritten` | promote |
  | `go`, `now` at or past `deadline` | abort no_link |
  | `go`, not `registered` | register |
  | `go`, not `probed` | probe |
  | `go` | promote |
  | `promoted`, `appLeads` | done |
  | `promoted` | lead |
  | `aborted`, `now` at or past `at + ABORTED_KEEP_MS` | forget |
  | `aborted` | none |

- [ ] **Step 1: Write failing tests** in `switch-step.test.ts`: one test per row of each table, named by its row (for
  example `hands over: abort behind when B has not confirmed W 10 s before the deadline`), each with a sample where
  every earlier row fails; and:
  - `never aborts after go`: for every sample with phase `go` and any `now`, offer, W and `state` but `aborted` and
    `none`, `offered` and null included, the action is `ask`, `send_go` or `follow`.
  - `sends go before the deadline or not at all`: for every `stopped` sample, a `go` action comes only with `now` before
    `deadline - BEHIND_MS` or at it.
  - `fences again before reading W`: `stopped` with `fenced` false and `w` set: fence.
  - `never promotes after the deadline unless the term is written`: phase `go`, `now` past `deadline`, `registered` and
    `probed`: abort; the same with `termWritten`: promote.
  - `takeState`: `leading` with term and slots only with a handover, whatever the phase; `go` with the phase `go` and no
    handover, the term written or not; `aborted` with `follow` `{ number: T + 1, machine: A }`.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/switch-step.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both functions as the tables say; no clock, file or database in this file.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Decide each step of a planned switch as a pure function".

### Task 4: Promotion and joining, on real Postgres pairs

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 3 committed. **Done when:** from the worktree
root `npm run test:real` passes with Docker running; from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run
test/promote.test.ts` passes; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/promote.ts`
- Test: `apps/server/test/promote.test.ts` (new, PGlite where it can), `apps/server/test/real/switch.test.ts` (new)

**Interfaces:**
- Consumes: plan 3's `keeperSql`, `Sql`, `LeaseStore.fence`; plan 9's `copyName`, `PUBLICATION`, the leading keeper's
  publication making, `realCluster`, `test/real/pair.ts`; Task 1's tables.
- Produces, each on the owner's keeper session, each doing nothing when its work is already done:
  ```ts
  // modules/keeper/promote.ts
  export function writeTerm(sql: Sql, o: { above: number; machine: string }): Promise<Term>;
  //   net_local.state: number one above the highest of o.above, max(net.journal.term_number) and the state's own;
  //   machine o.machine, split false, cluster from pg_control_system(); an existing row of o.machine with no
  //   handed_lsn and a number above o.above is this attempt's and is answered as it is; else the one row is
  //   overwritten and its handed_to, handed_lsn and handed_at cleared (a machine that handed the server over and now
  //   takes it back)
  export function termOf(sql: Sql): Promise<(Term & { handedLsn: string | null }) | null>;
  export function dropSubscriptions(sql: Sql): Promise<string[]>;    // disable, slot_name NONE, drop; the names
  export function raiseSequences(sql: Sql): Promise<string[]>;
  //   every sequence owned (pg_depend 'a') by a column of a table in public: setval to max(column) + 1000 when that is
  //   above its last value; the names it set
  export function makeSlots(sql: Sql, names: string[]): Promise<void>;  // pgoutput, each unless it exists
  export function recordHandover(sql: Sql, h: { id: string; from: string; term: Term; applied: string; to: string;
    at: Date; slots: Record<string, string> }): Promise<void>;
  //   the net.handovers row of id h.id (the switch's) and DELETE FROM net.move, one commit; a row of that id already
  //   there counts as done
  export function handoverOf(sql: Sql, id: string): Promise<{ from: string; term: Term; slots: Record<string, string> }
    | null>;
  export function markHanded(sql: Sql, o: { to: string; lsn: string; at: Date }): Promise<void>;
  export function dropSlots(sql: Sql): Promise<string[]>;
  //   pg_terminate_backend of each slot's walsender, then pg_drop_replication_slot of every slot of this database
  export function applyRunning(sql: Sql, subscription: string): Promise<boolean>;
  //   the subscription enabled and its apply worker running (pg_stat_subscription's row with relid null has a pid)
  export function joinSlot(sql: Sql, o: { name: string; conninfo: string }): Promise<void>;
  //   CREATE SUBSCRIPTION <name> CONNECTION <conninfo> PUBLICATION hornhoof WITH (create_slot = false, slot_name =
  //   '<name>', copy_data = false, synchronous_commit = 'local', binary = false, streaming = off,
  //   disable_on_error = true), names and literals quoted by format; a subscription of that name already there
  //   counts as made
  ```
- `slot_name = NONE` comes before `DROP SUBSCRIPTION`, which would else drop the slot on the other side; a slot is
  dropped only after its walsender ended, or `pg_drop_replication_slot` fails on an active one.

- [ ] **Step 1: Write failing tests.**
  - `promote.test.ts` (PGlite): `writes the term above every one seen`: journal rows of term 7, A's term 5 given: the
    state's term is 8 with B's machine; called again, still 8; with a state row of B's term 9 and no `handed_lsn`: 9.
    `records a handover and ends the request`: a `net.move` row and the call: no `net.move` row, one `net.handovers` row
    with the slots; called again with the same id, still one row. `marks a database handed`: the three columns set; then
    `writeTerm` for the same machine above them: a new number and the three columns null.
  - `test/real/switch.test.ts`, on a pair of `realCluster`s, the leader `linux/amd64` and the copy `linux/arm64` as plan
    9's pairs, both migrated as the app does, the copy subscribed as plan 9's maker subscribes it:
    - `promotes a copy and the old leader joins it`: rows written on the leader in `tasks`, `task_events` and
      `agent_events`; the leader fenced; W read; the copy's slot confirmed W, and at that moment, with no further wait,
      every row written on the leader is on the copy; on the copy `writeTerm`, `dropSubscriptions`, `raiseSequences`,
      the publication, `makeSlots([<the leader's slot name>])`, `recordHandover`; on the leader `markHanded`,
      `dropSlots`, `joinSlot` to the copy; then rows written on the copy reach the leader within 10 s, every table of
      `public` and `net` has the same ids on both, and a `task_events` row made on the copy has an id above every one
      made on the leader.
    - `reaches W when only a checkpoint follows`: after the last commit and the fence, `CHECKPOINT` on the leader; W
      read after it; the copy's slot confirms W within 10 s with `wal_receiver_status_interval` 1 s, though the copy's
      origin stays at the last commit; `applyRunning` is true; then the promotion and the join of the first test run
      through, with the same checks.
    - `takes nothing as applied before it is`: a transaction of 50 000 rows committed on the leader, W read at once:
      while the copy still applies it, its slot's `confirmed_flush_lsn` stays below the transaction's commit; once it is
      at W, all 50 000 rows are on the copy.
    - `refuses to drop a database with an active slot, and drops it once the slots went`: with the copy's subscription
      enabled, `DROP DATABASE hornhoof WITH (FORCE)` on the leader fails naming the slot; after the copy's subscription
      is disabled and `dropSlots` ran, it succeeds.
- [ ] **Step 2: Run** `npm run test:real` from the worktree root. Expected: FAIL (no `promote.ts`).
- [ ] **Step 3: Implement** `promote.ts`.
- [ ] **Step 4: Check the disk** (`df -h /` and `docker system df`, as the Global Constraints say), **then run Done
  when.** Expected: PASS.
- [ ] **Step 5: Commit** "Promote a copy and let the old leader join it, tested on real pairs".

### Task 5: The CEO's request, the target's copy, and the leader's row

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 4 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/copies-move.test.ts test/copies-order.test.ts
test/sync-step.test.ts test/sync.test.ts test/nodes.test.ts test/people.test.ts test/updates-routes.test.ts` passes (the
existing files of those modules where a name differs), then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/copies/move.ts`
- Modify: `apps/server/src/modules/copies/order.ts` (`planRoles`), `apps/server/src/modules/keeper/sync-step.ts`,
  `apps/server/src/modules/keeper/sync.ts`, `apps/server/src/modules/nodes/routes.ts` (the move routes, `GET
  /api/machines`, Disconnect), `apps/server/src/modules/nodes/nodes.ts` (`shownMachine` and the other skips of `server:`
  rows), plan 5's `thisMachine`, the people route that disables a person, `apps/server/src/modules/updates/routes.ts`,
  `apps/server/src/errors.ts` (`ErrorReason` gains `already_leader`, `no_number`, `updating`, `switching`, `moving`,
  `leader`, `server_install`)
- Test: `apps/server/test/copies-move.test.ts` (new), and the existing tests of the modified modules

**Interfaces:**
- Consumes: Task 1's `net.move`; 9b's `Ranking.now({ rescore, ceo })`, `planRoles`, `rankOf`, `setPriority`'s shape;
  plan 9's `SyncSample`, `nextSyncStep`; plan 7's check of the CEO; plan 5's `findThisMachine`; plan 2's
  `UpdaterStatus`; `MoveReason` (Task 3).
- Produces:
  ```ts
  // modules/copies/move.ts
  export type MoveView = { machine: string; state: 'preparing' | 'switching' | 'failed'; reason: MoveReason | null;
    leader: string; progress: number | null };
  //   machine: the target's row id; leader: the hostname of the machine that led when it was asked; progress: the
  //   target's copy_progress while its copy is not ready, else null
  export function askMove(ctx: Ctx, machineId: string, by: string): Promise<void>;
  export function cancelMove(ctx: Ctx, machineId: string): Promise<void>;
  export function moveView(db: Db): Promise<MoveView | null>;
  export function moveTarget(sql: Sql): Promise<string | null>;
  //   for the keeper: the target's network id while the request is preparing or switching
  export function claimMove(sql: Sql, request: string): Promise<boolean>;
  //   for Task 7: in one transaction, SELECT ... FOR UPDATE of the row, and preparing to switching only when its
  //   request is the one given; false when it was replaced, cancelled or no longer preparing
  // routes: POST /api/machines/:id/move -> 202 { state: 'preparing' }; DELETE /api/machines/:id/move -> 204
  // GET /api/machines gains move: MoveView | null; canMove: boolean; and on each machine serverInstall: boolean
  // SyncSample gains target: string | null   // the network id of the move's target when it is one of others
  ```
- `askMove`, after `requirePerson` and plan 7's check of the CEO, the machine looked up as the other `/api/machines/:id`
  routes do; outside lead 503 as they answer; then, in order: the leader's row, 409 `already_leader` "<host> runs the
  company server already."; no `server_order`, 409 `no_number` "<host> cannot take the server now."; the updater running
  (`status.json` `running`), 409 `updating` "Hornhoof is updating. Move the server once the update ended."; a request
  `switching`, 409 `switching` "The server is moving to <host> now.". Then the one `net.move` row is written (a new
  `request`, target, the leader's row as `from_machine_id`, the CEO, now, `preparing`, no reason) in one transaction
  with the live rows `FOR UPDATE` and the `net.move` row `FOR UPDATE`, the lock `claimMove` takes, and
  `ctx.ranking.now({ rescore: false })` awaited; a failed ranking answers 503 `try_again` as 9b's priority route does,
  the request stored.
- `cancelMove`: under the same lock, no request naming the machine 404; `switching` 409 `switching`; else deleted.
- `planRoles` (9b): while a request is `preparing` or `switching`, its target, when numbered, gets the role `data` at
  once whatever `COPIES` says, and no rule of 9b retires it; once the request is gone, 9b's rules alone.
- `nextSyncStep` (plan 9's table) with `target` T set: before the rows that replace C by a lower number, two rows:
  `setting` C, T is not C, T finished and kept pace `PACE_FOR_MS`, off stored: `clear`, flag `relay_off`; the same not
  stored: post off, flag `copy`. The rows that replace C by a lower number do not fire while C is T. The `set` row picks
  T, when finished and kept pace `PACE_FOR_MS`, before the lowest-numbered such. With no `target` the table is as it
  was.
- `SyncController` reads `moveTarget` once a second on its keeper session and puts it in each sample; it gains `named():
  string | null` (the network id its setting names), `record(): SyncRecord | null` (the relay's record as last read or
  stored) and `generation(): number | null` (the route's generation as last read), and `copies()` gains each copy's
  `networkId`, for Tasks 7 and 9.
- `server:` rows: every place that skips them (plan 5's ruling 6) skips only the leader's own (`findThisMachine`);
  another one is listed with `serverInstall: true`, its hostname from its reports, and the `/api/machines/:id` routes
  take it, 9b's priority route included. Its Disconnect answers 409 `server_install` "The company was installed on
  <host>, so it cannot be disconnected.".
- `thisMachine` (plan 5's ruling 6): the other live `server:` rows and their certificates are revoked only in the call
  that inserted this machine's own `server:` row; a call that found its row revokes nothing.
- Disconnect of the leader's row, and disabling a person one of whose live machines is the leader's row, answer 409
  `leader` "<host> runs the company server. Move the server to another machine first.".
- `GET /api/machines`: `move` from `moveView`, for everyone who may list machines; `canMove` true for the CEO on his own
  session while the app leads (the refusals above come from the route).
- The update route that starts an update answers 409 `moving` "The server is moving to <host>. Update once it moved."
  while a request is `preparing` or `switching`.

- [ ] **Step 1: Write failing tests.**
  - `copies-move.test.ts`, on `testApp` leading with the CEO, the leader L, numbered copies A (2) and B (3), a fit
    machine D numbered 4 with the role `worker`, a machine U with no number:
    - `asks for a move and gives the target its copy`: the CEO's POST on D answers 202; `net.move` names D `preparing`
      with L as `from_machine_id`; D has the role `data`; the ranking ran once; `GET /api/machines` has `move` `{
      machine: D, state: 'preparing', reason: null, leader: <L's hostname>, progress: null }`.
    - `refuses what cannot move`: L 409 `already_leader`; U 409 `no_number`; with `status.json` `running`, 409
      `updating`; with a request `switching`, 409 `switching`; a person who is not the CEO 403; outside lead 503.
    - `replaces and cancels a request`: a POST on A after D's names A; DELETE on A 204 and no row; DELETE on B 404; a
      `switching` request's DELETE 409.
    - `answers try_again when the ranking fails`: a failing `ctx.ranking.now`: 503 `try_again`, the row stored.
    - `claims only the request it saw`: `claimMove` with D's request: true and `switching`; after a POST on A replaced
      it, `claimMove` with D's old request: false and A's request still `preparing`; after a DELETE, false.
  - `copies-order.test.ts`, `keeps the target's copy`: with three copies and D the target, D keeps `data` beside them
    and no ranking retires it; with the request deleted, 9b's rules retire the extra row as before.
  - `sync-step.test.ts`, one test per new row; `names the target over a lower number`: `setting` A (2), target D (4)
    finished and keeping pace 30 s, off stored: `clear`; then `set` D; with the target D named and A keeping pace: no
    replacement.
  - `sync.test.ts`, `samples the move's target`: a `net.move` row naming D's row puts D's network id in the sample
    within 1 s; `named()` gives the setting's network id.
  - `nodes.test.ts`: `lists a server: row that does not lead`: another `server:` row is listed with `serverInstall:
    true` and its hostname, and its Disconnect is 409 `server_install`; the leader's own is not listed. `refuses to
    disconnect the leader`: the leader's row (a joined computer here, as after a switch): 409 `leader`. `says who may
    move`: `canMove` true for the CEO's own session, false for P; P's list still has `move`.
  - people: `refuses to disable the leader's person`: P whose machine is the leader's row: 409 `leader`.
  - authority (plan 5's test of `thisMachine`): `keeps the old leader's install when a copy leads`: a database with a
    live `server:` row of A and a joined row of B whose network id is B's `machineId`: `thisMachine` on B answers B's
    row, and A's row and certificates stay live; on a machine C with no row: C's `server:` row is made and A's is
    revoked, as today.
  - updates: `refuses an update while the server moves`: with a request `preparing`, 409 `moving`.
- [ ] **Step 2: Run** the files of Done when. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Take the CEO's request to move the server, and give the target its copy first".

### Task 6: Taking the server over

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/taking.test.ts test/keeper-role.test.ts
test/keeper.test.ts test/follow-keeper.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/taking.ts`
- Modify: `apps/server/src/keeper.ts` (`keeperRole`, the exit), `apps/server/src/modules/keeper/follow.ts` (the switch's
  peer paths), `apps/server/src/modules/keeper/keeper.ts` (a leading keeper that is taking over), the peer server's
  routing of peer paths (where plan 7's `/peer/backups` and plan 9's `/peer/upload` are routed)
- Test: `apps/server/test/taking.test.ts` (new), `apps/server/test/keeper-role.test.ts`,
  `apps/server/test/keeper.test.ts`, `apps/server/test/follow-keeper.test.ts`

**Interfaces:**
- Consumes: `nextTakeStep`, `takeState`, `Taking`, `TakeState`, `SWITCH_MS` (Task 3); `writeTerm`, `termOf`,
  `dropSubscriptions`, `raiseSequences`, `makeSlots`, `recordHandover`, `handoverOf`, `applyRunning` (Task 4); plan 9's
  `FollowKeeper`, `keeperRole`, `REPLICA_FILE`, `COPY_STATE`, `copyName`, the publication making; plan 5's
  `TunnelKeeper`, `linkClientId`; plan 1's relay client `route`; plan 3's keeper link doors.
- Produces:
  ```ts
  // modules/keeper/taking.ts
  export const TAKING_FILE = 'taking.json';                // keeper folder, 0600, written whole and then moved
  export function readTaking(dir: string): Taking | null;  // null when missing; unreadable: null and one log line
  export function writeTaking(dir: string, t: Taking): void;
  export class Taker {   // in the follow keeper: answers A
    constructor(opts: { dir: string; sql: Sql; leader: () => string | null; copyReady: () => boolean;
      subscription: () => Promise<string | null>; exit: () => void; now?: () => number; log: (line: string) => void });
    handle(from: string, method: string, path: string, body: unknown): Promise<{ status: number; body: object }>;
    tick(): Promise<void>;   // the follow keeper calls it each second: nextTakeStep's expire and forget
  }
  export class Promoter {   // in a leading keeper that is taking over
    constructor(opts: { dir: string; controlDir: string; sql: Sql; machine: { id: string; networkId: string };
      route: () => Promise<{ client: string | null } | null>; client: string;
      probe: (nonce: string) => Promise<{ machine: string; nonce: string } | null>;
      tunnel: { start(): void; stop(): Promise<void> }; appLeads: () => boolean; exit: () => void;
      promote?: (t: Taking) => Promise<Record<string, string>>;
      now?: () => number; log: (line: string) => void; everyMs?: number });
    //   promote: Task 4's steps 1 to 6 of ruling 5, answering the slots' names; tests give a fake
    start(): Promise<void>;
    stop(): Promise<void>;
    leads(): boolean;    // promoted: the keeper may take its lease
    handle(from: string, method: string, path: string, body: unknown): Promise<{ status: number; body: object }>;
  }
  // keeper.ts
  export function keeperRole(env: NodeJS.ProcessEnv, controlDir: string, dir: string,
    hasSubscription: () => Promise<boolean>): Promise<'worker' | 'follow' | 'lead' | 'taking' | 'handing'>;
  //   worker for HORNHOOF_ROLE=worker; taking for taking.json in go or promoted; handing for handing.json in
  //   offered, stopped, go or followed; follow for replica.json or an enabled subscription; else lead
  ```
- The peer paths, on the follow keeper's peer server and on a taking keeper's, from a data certificate:
  - `POST /peer/switch/offer` `{ switch, term, deadline }` from the machine `leader()` names: 200 `{ ok: true }` and
    `taking.json` `offered` with that machine as `from` when `copyReady()` and the subscription is enabled and no other
    offer stands; the same offer again 200 and nothing new; else 409 `{ ok: false, why: 'not_ready' }`.
  - `POST /peer/switch/go` `{ switch, w, copies }` from the machine `taking.json`'s `from` names (not `leader()`, which
    names nobody once A fenced): 200 only when `taking.json` is `offered` for that switch, `now` is before its deadline
    and `applyRunning` is true; then `taking.json` `go` with `w` and `copies` is written, the subscription disabled, and
    once the answer is sent, `exit()`. The same `go` again while `taking.json` is `go` for that switch: 200 and nothing
    new. Else 409. W itself is A's barrier (ruling 3), not B's.
  - `POST /peer/switch/abort` `{ switch }` from that machine: before the term, `taking.json` `aborted` (`follow` (T + 1,
    A)), the subscription enabled again if it was disabled, 200 `takeState`; after it, 409 with `takeState`; another
    switch 409.
  - `GET /peer/switch/state?switch=<id>` from that machine: 200 `takeState(<taking.json when of that switch>,
    handoverOf(id))`. With no `taking.json` the asker is checked against the handover's `from` instead, so any keeper of
    this build answers it, the new leader included, whatever its kind.
- `Taker.tick`, each second in the follow keeper: an `offered` past its deadline is removed (`expire`), an `aborted`
  past `ABORTED_KEEP_MS` too (`forget`); a stopped subscription that `taking.json` `go` disabled stays disabled.
- A taking keeper (`keeperRole` `taking`): its peer server, link doors, TLS listener and `TunnelKeeper` (with
  `linkClientId(<link name>, machine)`) run as any leading keeper's; it takes no lease, keeps its front door closed,
  writes `keeper.json` `off`, and starts neither the sync controller, the pulse nor the slots until `leads()`.
  `Promoter` runs `nextTakeStep` every `everyMs` (250): `registered` is `route()` naming `client`; `probed` is a `probe`
  answered with B's network id and the nonce sent, tried once a second; `termWritten` from `termOf`; then: `register` is
  the tunnel running; `promote` the promotion (ruling 5, Task 4's functions in its order), then `replica.json` and
  `copy-state.json` removed and `taking.json` `promoted` with the slots, the handover recorded under the switch's id by
  then (promotion step 6); `lead` lets the keeper take its lease and start the rest; `done` removes `taking.json`; `dir`
  is the keeper folder (`taking.json`, `copy-state.json`), `controlDir` the control folder (`replica.json`, plan 9's);
  `abort` stops the tunnel, enables the subscription, writes `aborted` with `why` and `follow`, and `exit()`s; `expire`
  and `forget` remove the file.
- `probe(nonce)`: `GET <base>/api/network/lease?nonce=<nonce>`, `<base>` the link's `https://<host>` or
  `HORNHOOF_LINK_PROBE` when set (tests and the lab), 5 s timeout, certificates checked as `fetch` does.
- The exit: `keeper.ts` gives each kind `exit`, which closes its listeners and ends the process with code 0 (compose
  starts it again, ruling 4); tests give a fake.
- The log lines: "Taking the server over from <A's hostname>." at `go`; "This machine leads the company now, under term
  <n>." at `done`; "Gave the server back to <A's hostname>: <why>." at `abort`.

- [ ] **Step 1: Write failing tests.**
  - `keeper-role.test.ts`: `taking` for `taking.json` in `go` and in `promoted`, also with `replica.json`; `follow` for
    `offered` or `aborted` with `replica.json`; `handing` for `handing.json` in each of its four phases; `lead` for
    `handing.json` `aborted`.
  - `taking.test.ts`, the `Taker` on `createTestSql` with fakes for the subscription and `exit`:
    - `accepts an offer only when ready`: from the leader with a ready copy: 200 and `taking.json` `offered` with it as
      `from`; the same offer again: 200, the file unchanged; from another machine 403; with the copy not ready 409
      `not_ready`.
    - `takes go from the machine that offered`: with `leader()` now null (A said `lead: false`), `go` from A: 200,
      `taking.json` `go` with `w` and `copies`, the subscription disabled, then `exit` called once; the same `go` again:
      200, `exit` not called again; a `go` of another switch: 409; from another machine: 403; with the apply worker not
      running: 409 and nothing written; after the deadline: 409.
    - `answers its state`: `offered`, then `go`; after a fake promotion with no handover yet, still `go`; with the
      handover recorded, `leading` with the term and slots; with no `taking.json` and a handover of id S from the asker:
      `?switch=S` gives `leading` with its slots, another id gives `none`.
    - `ends an offer nobody followed`: `offered` and no `go`: at the deadline `tick` removes the file and the state is
      `none`; a `go` for that switch after it: 409.
  - `taking.test.ts`, the `Promoter` with a fake route, probe, tunnel and promotion:
    - `registers, checks its nonce, then promotes`: the route names another client: no probe; names B's: one probe;
      probe answered with another machine: no promotion; with B's id and the nonce: one promotion, then `taking.json`
      `promoted`, `replica.json` gone, `leads()` true.
    - `takes no lease before it promoted`: on a `Keeper` in taking mode with plan 3's fake lease, until `leads()` the
      fake records no `take`, `keeper.json` says `off` and the front door refuses connections; after it, one `take` and
      the door opens.
    - `gives the server back when the name does not come`: the route never names B: at the deadline the tunnel is
      stopped, the subscription enabled, `taking.json` `aborted` with `why` `no_link` and `follow` (T + 1, A), and
      `exit` called.
    - `goes on after a restart in each phase`: started with `go` and the term already written: it promotes (the fake
      sees its call) without aborting, also past the deadline; with `promoted`: it leads; with `aborted` 11 minutes old:
      the file goes.
- [ ] **Step 2: Run** the files of Done when. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let a copy take the server over: its name at hornhoof.org, its nonce, then promotion".

### Task 7: Handing the server over, and following the new leader

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 6 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/handing.test.ts test/peer-link.test.ts
test/seed-view.test.ts test/copy-maker.test.ts test/worker-config.test.ts test/network-join.test.ts test/keeper.test.ts
test/merge-fast.test.ts test/updater.test.ts` passes (the existing files of those modules where a name differs), then
the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing; `bash -n` and `shellcheck` on
`apps/updater/updater.sh` print nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/handing.ts`, `apps/server/src/modules/keeper/seed-view.ts`
- Modify: `apps/server/src/modules/keeper/keeper.ts` (handing), `apps/server/src/modules/keeper/copy.ts` (phase `join`,
  `CopyOrder.join`, the `led` guard), `apps/server/src/modules/keeper/worker-config.ts` (`followConfig`),
  `apps/server/src/modules/network/join.ts` (`CopyOrder.join`), plan 9's one id-set check (`fastWay`),
  `apps/updater/updater.sh` (`schema_request`'s passfile alone, the wipe's check), `apps/server/src/net/peer-link.ts`
  (`ask`)
- Test: `apps/server/test/handing.test.ts` (new), `apps/server/test/seed-view.test.ts` (new), and the existing tests of
  the modified modules

**Interfaces:**
- Consumes: `nextHandStep`, `Handing`, `HandSample`, `TakeState`, `SWITCH_MS`, `OFFER_WAIT_MS` (Task 3); `markHanded`,
  `dropSlots`, `joinSlot`, `termOf`, `dropSubscriptions` (Task 4); `SyncController.named()`, `record()`, `generation()`,
  `copies()`, `moveTarget`, `claimMove` (Task 5); the switch's peer paths (Task 6); plan 3's `LeaseStore.fence`,
  `Keeper.term()`; plan 5's peer client to a data machine; plan 5b's `WorkerView`, `PEERS_FILE`; plan 9's `CopyMaker`,
  `CopyOrder`, `REPLICA_FILE`, `COPY_STATE`, `SCHEMA_FILE`, `followConfig`, `workerView`'s `copy`; plan 5's
  `decryptSecret`.
- Produces:
  ```ts
  // modules/keeper/handing.ts
  export const HANDING_FILE = 'handing.json';   // keeper folder, 0600, written whole and then moved
  export function readHanding(dir: string): Handing | null;
  export function writeHanding(dir: string, h: Handing): void;
  export class Hander {
    constructor(opts: { dir: string; controlDir: string; sql: Sql; lease: { fence(): Promise<void> };
      term: () => Term | null;
      sync: { named(): string | null; record(): SyncRecord | null; generation(): number | null;
        copies(): { name: string; networkId: string; state: 'sync' | 'pace' | 'behind' | 'silent' }[] };
      peer: (networkId: string) => { request(method: string, path: string, body?: unknown, timeoutMs?: number):
        Promise<{ status: number; body: unknown } | null> };
      front: { close(): Promise<void>; open(): void }; tunnel: { start(): void; stop(): Promise<void> };
      leads: () => boolean; updating: () => boolean; machine: { id: string; networkId: string };
      exit: () => void; now?: () => number; log: (line: string) => void; everyMs?: number });
    start(): Promise<void>;
    stop(): Promise<void>;
    holds(): boolean;    // phases offered, stopped, go, followed: no lease, hello lead false, the front door shut
  }
  // modules/keeper/seed-view.ts
  export function seedView(sql: Sql, machineId: string, secret: string): Promise<WorkerView>;
  //   the whole WorkerView that workerView answers for this machine's row, from stored values only (no relay call,
  //   nothing made): the live data rows but its own, the authority, the revoked serials, and the link with appSecret,
  //   dataSecret and visitorKey opened with decryptSecret(<stored>, secret), null when one is missing
  // modules/keeper/copy.ts: copy-state.json's phase gains 'join' with slot: string, and the file gains leader: string
  //   (the network id of the leader the copy was made on or last joined); CopyOrder gains join: string | null and
  //   leader: string (the network id of the leader whose view it comes from)
  // modules/network/join.ts: workerView's copy.join is the newest net.handovers row's slot for the row's network id
  //   when that slot's attempt is above the attempt of the row's copy_name (or it has none), else null
  // net/peer-link.ts: PeerLink gains
  ask(networkId: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, timeoutMs?: number):
    Promise<{ status: number; body: unknown } | null>;
  //   one HTTP/2 request on the session to the data machine with that network id, to its peer server's path (as the
  //   hello is sent), JSON both ways, 5000 ms unless given; null with no session to it, on a timeout, or when the
  //   answer is not JSON. The Hander's and LeadUpdate's peer(networkId) is { request: (...a) => link.ask(networkId,
  //   ...a) } on the leading keeper's dial PeerLink, which keeps sessions to every other live data row
  // modules/keeper/worker-config.ts: followConfig takes HORNHOOF_JOIN_SERVER, else the link url of the view in
  //   PEERS_FILE; with neither it throws with the line it throws today
  ```
- `updating` is plan 2's read of `status.json` `running` until Task 9 gives `LeadUpdate.busy()`, which the keeper passes
  from then on.
- `Hander`, every `everyMs` (250), builds `HandSample` (the request and its target from `net.move` and `machines`;
  `named` that target's copy when `sync.named()` is its network id; `onStored` when the record is `on` naming it at
  `sync.generation()`; `pace` when `copies()` says `sync` or `pace` for it; `wConfirmedAt` and `othersAtW` from
  `pg_replication_slots`' `confirmed_flush_lsn` against `w`, by slot name; `othersOnline` the other copies whose
  `copy_state` is `ready` and that have a walsender) and acts on `nextHandStep`:
  - `offer`: `claimMove(<the sampled request>)`; false: nothing more (the next sample sees the request of now); true:
    `handing.json` `offered` (`switch` the request, deadline `now + SWITCH_MS`, the term from `term()`, `fenced` false),
    then the offer `{ switch, term, deadline }` (answer within `OFFER_WAIT_MS`, else `silent`).
  - `stop`: `stopped` written; then as `fence`. `fence`: `front.close()`; `lease.fence()`; then `fenced` true written.
    From `stopped` on `holds()`, so the keeper's hello says `lead: false`, `keeper.json` says `read` and the lease loop
    takes nothing; a keeper that starts in `stopped` with `fenced` false fences again before it reads W.
  - `read_w`: `pg_current_wal_lsn()` into `handing.json`.
  - `go`: `go` and `copies` written, then the request `{ switch, w, copies }` (its answer is not needed), then
    `tunnel.stop()`, kept stopped while `holds()` (plan 9's restart of the link frpc after 30 s does not run).
    `send_go`: the same request again, at most once a second, none while one is out.
  - `ask`: `GET /peer/switch/state?switch=<handing.switch>`, its answer kept for the next sample; one log line a minute
    while none comes: "Waiting for <host> to say whether it took the server."
  - `follow`: `followed` and the slot written; `markHanded` (B's network id, W, now); `dropSlots`; `PEERS_FILE` from
    `seedView` with `HORNHOOF_SECRET`; `COPY_STATE` `{ attempt: <the slot's attempt>, database: 'hornhoof', phase:
    'join', slot, leader: <B's network id> }`; `REPLICA_FILE` in `controlDir` as plan 9 writes it; `handing.json`
    removed; `exit()`.
  - `abort` and `reenter`: (`abort` only) the abort request `{ switch }`; `aborted` with the reason written;
    `front.open()`; `tunnel.start()`; the lease loop takes the next term as plan 3's ruling 8 says.
  - `fail`: `net.move` `failed` with the reason and `ended_at` now; from `aborted`, `handing.json` removed.
  - `forget`: the failed `net.move` row deleted.
- The copy maker's `join` (A, and any copy whose order names a `join`), every step checked first so a restart in `join`
  goes on: `dropSubscriptions` of every subscription not named `slot` (the old one, left by a restart before it went);
  when the database has no `<data_directory>/replica.pgpass` (`pg_stat_file(..., true)`), `schema.json` with `only:
  'passfile'`, which `schema_request` answers by writing the passfile alone, as plan 9's does, and `.done`; then
  `joinSlot` with plan 9's connection string through `keeper:7432`; then `copy-state.json` `ready` with the slot's
  attempt, `leader` and the leader's count of migrations from the order, and `report().name` the slot. A copy in phase
  `ready` whose order names a `join` above its attempt writes `{ attempt, phase: 'join', slot, leader: order.leader }`
  first, then joins as above. An order whose `leader` is not the copy's `leader` counts toward none of plan 9's remake
  rules (its ruling 14: a slot `missing` or `lost`, a subscription that stopped) until two orders in a row from that
  leader named no `join` for it, so a copy that reached W joins and is never made again, and one that did not reach W
  remakes as plan 9's. A `copy-state.json` of before this plan with no `leader` takes the order's first `leader`.
- The `led` guard (plan 9's ruling 12, the maker's step 1 and the wipe's check in `updater.sh`) counts a
  `net_local.state` row only while its `handed_lsn` is null; plan 9's one id-set check (its ruling 15) takes a source
  whose state row has `handed_lsn` set as one that never wrote.
- The log lines: "Handing the server over to <host>." at `offer`; "<host> leads now; this machine keeps a copy." at
  `follow`; "The server stays here: <reason>." at `abort` and `reenter`.

- [ ] **Step 1: Write failing tests.**
  - `peer-link.test.ts`, `asks a data machine on its own session`: two `PeerServer`s of data machines, each answering a
    test path with its own machine id: `ask(<second's network id>, 'POST', <path>, { a: 1 })` answers the second's 200
    and body; an unknown network id answers null at once; a server that never answers gives null after `timeoutMs`.
  - `handing.test.ts`, a `Hander` on `createTestSql` with fakes for the lease, sync, peer, front, tunnel and `exit`:
    - `hands over when the target keeps pace`: a request `preparing` for D, D named, on stored at the generation,
      `pace`: one offer, `net.move` `switching`; accepted: `front.close`, `lease.fence`, `holds()` true; W read; D's
      slot at W and the other copy C at W: `go` with `copies` `[C]`, then `tunnel.stop`; `state` `leading` with slots:
      `markHanded`, `dropSlots`, `peers.json`, `copy-state.json` in `join` with D's slot for this machine,
      `replica.json`, and `exit`.
    - `gives no slot to a copy that missed W`: C below W for `OTHERS_WAIT_MS` after D reached it: `go` with `copies`
      `[]`.
    - `aborts alone before go`: offer refused: `abort` sent, `aborted` `not_ready`, `front.open`, `tunnel.start`,
      `holds()` false; once `leads()`: `net.move` `failed` `not_ready` and no `handing.json`. D not at W 10 s before the
      deadline: the same with `behind`.
    - `never leads again after go without B's word`: after `go`, the peer silent for 5 minutes of fake time: still
      `holds()`, no `front.open`, no `tunnel.start`, a log line a minute; then `aborted` with `why` `no_link`: re-enters
      and, leading, marks `failed` `no_link`. After `go`, `offered` past the deadline: still asks; `none`: re-enters and
      marks `failed` `no_answer`.
    - `goes on after a restart in each phase`: a new `Hander` started on `handing.json` `offered` with no answer: abort
      `no_answer`; on `stopped` with `fenced` false: `front.close` and `lease.fence` before W is read; on `stopped` with
      `fenced` true: `holds()` and goes on to W; on `go`: asks, and with B answering `offered` sends the same `go`
      again; on `followed`: finishes following.
    - `claims only the request it saw`: the request replaced by another between the sample and the act: no
      `handing.json`, no offer; a request left `switching` with no `handing.json`: `failed` `no_answer`.
    - `gives no slot to a copy still making its copy`: C at W with a walsender but `copy_state` `making`: `go` with
      `copies` `[]`.
    - `fails a stale or empty request`: a request `preparing` for 25 hours: `failed` `expired`; a target with no number:
      `failed` `left`; a `failed` row ended 25 hours ago: deleted.
  - `seed-view.test.ts`: `builds the view from the database`: two data rows and a link with its secrets stored sealed by
    `encryptSecret` under the test's secret: the view lists the other data row with its addresses and ports, the
    authority, the revoked serials and the link with `appSecret`, `dataSecret` and `visitorKey` opened; with no visitor
    key stored, `link` null; with another secret, it throws and writes nothing.
  - `copy-maker.test.ts`: `waits for the new leader's word before a remake`: a copy made on A, its subscription stopped
    and its slot not listed, gets views from B: with `join` in the first: it joins, no remake; with no `join` in two
    views in a row: it remakes. `joins a slot with no copy of the data`: phase `join` with no passfile: `schema.json`
    `only: 'passfile'` once; with it: one `CREATE SUBSCRIPTION` with `create_slot = false` and `copy_data = false`
    naming the slot, then `ready` and `report().name` the slot. `moves to the new leader's slot`: phase `ready` with
    attempt 3 and an order `join` of attempt 4: `copy-state.json` says `join` before the old subscription is dropped,
    then the new one is made; started again in `join` with the old subscription still there: it is dropped before the
    new one is made. `counts a handed database as no led one`: a state row with `handed_lsn` set: no `stopped` `led`.
  - `worker-config.test.ts`: `follows without a join server`: no `HORNHOOF_JOIN_SERVER` and a `peers.json` with a link:
    the link's url; with neither: the line of today.
  - `network-join.test.ts`: `names the slot to join`: a `net.handovers` row with slots for C's network id at attempt 4
    and C's `copy_name` at 3: `join` that name; at 4: null.
  - `merge-fast.test.ts` (plan 9's test of the one id-set check): `takes a handed database as one that never wrote`.
  - `updater.test.ts`: `writes the passfile alone`: `schema.json` with `only: 'passfile'`: the passfile written, no
    `pg_dump`, `.done`. `wipes a handed database`: a state row with `handed_lsn` set does not stop the wipe; one without
    does.
- [ ] **Step 2: Run** the files of Done when. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Hand the server over to a copy and follow it, and move the other copies to it".

### Task 8: "Move the server here" on the card

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 7 committed. **Done when:** from `apps/web`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/Machines.test.tsx test/i18n.test.tsx` passes; `npx tsc -p
apps/web/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/web/src/screens/Machines.tsx`, `apps/web/src/types.ts`, `apps/web/src/i18n/en.ts`,
  `apps/web/src/i18n/ru.ts`, `apps/web/src/theme.css` (the confirm, as the mockup's `.confirm`)
- Test: `apps/web/test/Machines.test.tsx`, `apps/web/test/i18n.test.tsx`

**Interfaces:**
- Consumes: Task 5's `move`, `canMove` and `serverInstall`; 9b's Priority part; `errorText`.
- In the card's Priority part, as the mockup's `prioBody` `move`:
  - for a machine with a number from 2, not pinned `none`, when `canMove` and no request is `switching`: the button
    "Move the server here" / «Перенести сервер сюда»; pressed, it asks in place, as the mockup: the question
    `moveAsk(host)` and the buttons "Move the server" / «Перенести сервер» and "Cancel" / «Отмена»; focus goes to the
    first, and Cancel brings it back to the button. "Move the server" posts `/api/machines/<id>/move`; while it runs the
    buttons are disabled; an error shows under them by `errorText`; then the tab reloads.
  - on the request's target, for everyone who sees the part, whatever `canMove` says, in place of the button:
    `preparing`: `waiting(host, progress)`, and with `canMove` the button "Cancel the move" / «Отменить перенос», which
    sends `DELETE /api/machines/<id>/move`; `switching`: `switching(host)`; `failed`: `failed(leader, reason(host))`.
- A machine with `serverInstall` shows no Disconnect.
- Text, `machines.move` in both files, EN then RU:
  - `here`: "Move the server here" / «Перенести сервер сюда»; `ask(h)`: "Move the company server to <h>? Hornhoof stops
    for a short while as it moves; your work is kept." / «Перенести сервер компании на <h>? Пока он переезжает, Hornhoof
    ненадолго остановится; ваша работа сохранится.»; `yes`: "Move the server" / «Перенести сервер»; `cancel`: "Cancel" /
    «Отмена»; `stop`: "Cancel the move" / «Отменить перенос».
  - `waiting(h, p)`: "<h> takes the server once its copy is up to date (<p>%)" / «<h> возьмет сервер, как только ее
    копия станет актуальной (<p>%)», and with no `p` "<h> takes the server once its copy is up to date." / «<h> возьмет
    сервер, как только ее копия станет актуальной.»
  - `switching(h)`: "Moving the server to <h>." / «Сервер переезжает на <h>.»; `failed(l, r)`: "The server stayed on
    <l>: <r>" / «Сервер остался на <l>: <r>».
  - `reason`: `no_answer` "<h> did not answer." / «<h> не ответила.»; `not_ready` "the copy on <h> was not ready." /
    «копия на <h> была не готова.»; `behind` "<h> did not get the last changes within a minute." / «<h> не получила
    последние изменения за минуту.»; `no_link` "<h> could not take the company's link at hornhoof.org." / «<h> не смогла
    занять ссылку компании на hornhoof.org.»; `expired` "the copy on <h> was not up to date within a day." / «копия на
    <h> не стала актуальной за сутки.»; `left` "<h> no longer holds a copy." / «<h> больше не хранит копию.»
- Errors, in both files where `errorText` finds them: `already_leader` "<h> runs the company server already." / «Сервер
  компании уже работает на <h>.»; `no_number` "<h> cannot take the server now." / «<h> сейчас не может взять сервер.»;
  `updating` "Hornhoof is updating. Move the server once the update ended." / «Hornhoof обновляется. Перенесите сервер,
  когда обновление закончится.»; `switching` "The server is moving to <h> now." / «Сервер как раз переезжает на <h>.»;
  `moving` "The server is moving to <h>. Update once it moved." / «Сервер переезжает на <h>. Обновите, когда он
  переедет.»; `leader` "<h> runs the company server. Move the server to another machine first." / «На <h> работает
  сервер компании. Сначала перенесите сервер на другую машину.»; `server_install` "The company was installed on <h>, so
  it cannot be disconnected." / «Компания установлена на <h>, поэтому эту машину нельзя отключить.»

- [ ] **Step 1: Write failing tests** in `Machines.test.tsx`, with the answer of `GET /api/machines` faked as today:
  - `asks before it moves the server`: the CEO, `canMove`, D numbered 4: "Move the server here" on D's card; pressed,
    the question names D and focus is on "Move the server"; Cancel puts focus back on the button and posts nothing;
    "Move the server" posts `/api/machines/<D>/move` once and reloads.
  - `shows no move where it cannot be`: not on the server's card, not on a machine pinned `none` or unfit, not for P,
    not with `canMove` false, not while a request is `switching`.
  - `shows the move to everyone`: with `canMove` false (P's view), `move` `switching` for D: "Moving the server to D."
    on D's card; `preparing`: the waiting line and no Cancel.
  - `says how the move goes`: `move` `preparing` for D with `progress` 40: "D takes the server once its copy is up to
    date (40%)" and "Cancel the move", which sends the DELETE; with `progress` null, the sentence with no share;
    `switching`: "Moving the server to D."; `failed` `behind` with leader L: "The server stayed on L: D did not get the
    last changes within a minute."
  - `shows a move's refusal`: a 409 `updating` shows its line under the buttons, in Russian too.
  - `keeps the company's install connected`: a machine with `serverInstall` has no Disconnect.
  - `i18n.test.tsx`: every key of `machines.move` and the seven errors exists in both files; the Russian ones hold no
    `ё`, no em dash, no «компьютер» and no «узел».
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/Machines.test.tsx test/i18n.test.tsx` from
  `apps/web`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add Move the server here to the machine's card".

### Task 9: An update on the leader: the promise, the copies at W, sync off and the slots

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 8 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/update-steps.test.ts test/lead-update.test.ts
test/sync-step.test.ts test/updater.test.ts` passes, then the whole server suite; from `apps/web`, `VITEST_MAX_WORKERS=2
nice -n 10 npx vitest run test/UpdateProgress.test.tsx test/i18n.test.tsx` passes; the `tsc` commands print nothing;
`bash -n` and `shellcheck` on `apps/updater/updater.sh` print nothing; from the worktree root `npm run test:real` passes
with Docker running, after the disk check.

**Files:**
- Create: `apps/server/src/modules/keeper/update-steps.ts`, `apps/server/src/modules/keeper/lead-update.ts`,
  `apps/server/test/real/update-rollback.test.ts`
- Modify: `apps/server/src/modules/updates/control.ts` (`UpdaterStatus`, the three files),
  `apps/server/src/modules/keeper/keeper.ts` (a leading keeper runs `LeadUpdate`),
  `apps/server/src/modules/keeper/sync.ts` and `sync-step.ts` (`hold`), `apps/updater/updater.sh`,
  `apps/server/test/updater-stubs/docker` (the build's journal), `apps/web/src/types.ts` (`UpdateStep`),
  `apps/web/src/ui/UpdateProgress.tsx`, `apps/web/src/i18n/en.ts`, `ru.ts`
- Test: `apps/server/test/update-steps.test.ts` (new), `apps/server/test/lead-update.test.ts` (new),
  `apps/server/test/sync-step.test.ts`, `apps/server/test/updater.test.ts`, `apps/web/test/UpdateProgress.test.tsx` (new
  when there is none), `apps/web/test/i18n.test.tsx`

**Interfaces:**
- Consumes: plan 2's `status.json` and `UpdaterStatus`, its maintenance from the step; plan 3's lease kind
  `maintenance`, `net_local.maintenance`; plan 9's `SyncController.copies()`, `nextSyncStep`, `SyncSample`; Task 4's
  `dropSlots`; plan 5's peer client.
- Produces:
  ```ts
  // modules/updates/control.ts
  //   UpdaterStatus.step gains 'promise'; UpdaterStatus gains migrations?: number | null (the new build's
  //   migrations the database has not applied; null when unknown) and restore?: boolean (go_back restores)
  export const PROMISED_FILE = 'promised.json';
  export const SETTLED_FILE = 'settled.json';
  export const DROPPED_FILE = 'slots-dropped.json';
  //   control folder, each { id: string; ok: boolean; why?: string }, the keeper's, whole and then moved
  // modules/keeper/update-steps.ts
  export const PROMISE_MS = 900_000;        // "updating until <now + 15 min>"
  export const PROMISE_AGAIN_MS = 300_000;
  export const ANSWER_MS = 10_000;          // one copy's answer to /peer/updating
  export const W_WAIT_MS = 60_000;
  export type UpdateMemory = { id: string; version: string; migrations: number | null; promised: string[];
    promisedAt: number; answered: boolean; w: string | null; wAt: number | null; stopped: boolean;
    stopAcks: string[]; settled: boolean; dropped: boolean };
  export type UpdateSample = { now: number;
    status: { id: string; version: string; state: UpdaterStatus['state']; step: UpdaterStatus['step'];
      migrations: number | null; restore: boolean } | null;
    memory: UpdateMemory | null; online: string[]; answers: Record<string, 'ok' | 'refused' | 'silent'> | null;
    inFlight: boolean; maintenance: boolean; leads: boolean; atW: string[]; held: boolean };
  //   online: copies the sync controller has in sync or pace; answers: to the last promise, once every one came or
  //   ANSWER_MS passed, kept in memory only; inFlight: a request to the copies is out; maintenance: the lease's kind is
  //   maintenance (plan 3), the sessions ended; atW: promised copies whose slot's confirmed_flush_lsn is at or past
  //   memory.w; held: SyncController.held(); stopAcks: promised copies that answered 200 to { stop: true }
  export type UpdateAction =
    | { do: 'none' } | { do: 'promise'; to: string[] } | { do: 'answer'; ok: boolean; why: string | null }
    | { do: 'promise_again' } | { do: 'begin' } | { do: 'stop_copies' } | { do: 'settle'; ok: boolean }
    | { do: 'drop_slots' } | { do: 'end' };
  export function nextUpdateStep(s: UpdateSample): UpdateAction;
  // modules/keeper/lead-update.ts
  export const LEAD_UPDATE = 'lead-update.json';   // keeper folder: UpdateMemory, 0600, written before each act
  export class LeadUpdate {
    constructor(opts: { dir: string; controlDir: string; sql: Sql;
      sync: { copies(): { name: string; networkId: string; state: 'sync' | 'pace' | 'behind' | 'silent' }[];
        hold(on: boolean): void };
      peer: (networkId: string) => { request(method: string, path: string, body?: unknown, timeoutMs?: number):
        Promise<{ status: number; body: unknown } | null> };
      hostname: (networkId: string) => Promise<string>; leads: () => boolean; maintenance: () => boolean;
      now?: () => number; log: (line: string) => void; everyMs?: number });
    start(): Promise<void>;
    stop(): Promise<void>;
    busy(): boolean;   // status.json running, or a memory kept: Task 7's Hander reads it as updating()
  }
  // SyncSample gains hold: boolean; SyncController gains hold(on: boolean): void and held(): boolean, true once the
  //   hold is on, off is stored at the route's current generation and synchronous_standby_names names nobody
  ```
- `nextUpdateStep`, the first row that matches:

  | When | Action |
  |---|---|
  | status not `running` or null, memory set, `leads` | end |
  | status not `running` or null | none |
  | memory null or of another id, step `promise` | promise to `online` |
  | memory null or of another id | none (an update an updater of before this plan began) |
  | step `promise`, `answered` | none |
  | step `promise`, answers null, `inFlight` | none |
  | step `promise`, answers null | promise to `promised` (a keeper that started again with no answer) |
  | step `promise`, every one of `promised` `ok` | answer ok |
  | step `promise` | answer no, with the first copy's why |
  | `promised` not empty, `now` at or past `promisedAt + PROMISE_AGAIN_MS` | promise_again |
  | step `backup`, `maintenance`, `w` null | begin |
  | `w` set, not `settled`, every one of `promised` in `atW`, `migrations` not 0, not `stopped` | stop_copies |
  | `w` set, not `settled`, every one of `promised` in `atW`, `migrations` 0 | settle ok |
  | `w` set, not `settled`, `stopped`, every one of `promised` in `atW` and in `stopAcks`, `held` | settle ok |
  | `w` set, not `settled`, `now` at or past `wAt + W_WAIT_MS` | settle no |
  | `w` set, not `settled`, `stopped`, not every one of `promised` in `stopAcks`, not `inFlight` | stop_copies |
  | `restore`, not `dropped` | drop_slots |
  | otherwise | none |

  A `migrations` of null counts as not 0. The why of a copy that was `silent` is "<host> did not answer", of one that
  `refused` "<host> did not promise to wait".
- `LeadUpdate` acts, writing `lead-update.json` before each act. On `start`, before the keeper starts its sync
  controller, a memory with `stopped` or `dropped` true calls `sync.hold(true)`, so a restart never names a copy in the
  middle of an update:
  - `promise`: memory `{ id, version, migrations, promised: to, promisedAt: now }`; `POST /peer/updating` `{ version,
    until: now + PROMISE_MS, migrations }` to each, `ANSWER_MS` each, all at once; 200 `{ ok: true }` is `ok`, another
    answer `refused`, none `silent`. With no copy, answers `{}`, so ok at once.
  - `answer`: `PROMISED_FILE` `{ id, ok, why }`; `answered` true.
  - `promise_again`: the same request to `promised`, `promisedAt` now, and `net_local.maintenance.until` moved to `now +
    PROMISE_MS` when it is there; a copy that does not answer is logged, nothing more.
  - `begin`: `net_local.maintenance` (version, since now, until now + `PROMISE_MS`), then `pg_current_wal_lsn()` into
    `w`, `wAt` now.
  - `stop_copies`: `stopped` true written; `sync.hold(true)`; `POST /peer/updating` `{ stop: true }` to each of
    `promised` not yet in `stopAcks`, each 200 added to `stopAcks`.
  - `settle`: `SETTLED_FILE` `{ id, ok, why }`, why "The copies did not confirm the last changes" when no; `settled`
    true.
  - `drop_slots`: `{ stop: true }` to `promised`; `sync.hold(true)`; `dropSlots`; `DROPPED_FILE` `{ id, ok: true }`;
    `dropped` true.
  - `end`: `DELETE FROM net_local.maintenance`; `{ ended: true }` to `promised`, one try each; `sync.hold(false)`; the
    three files of that id and `lead-update.json` removed. `leads` is plan 3's normal lease with the app in `lead`, so
    copies hear "update ended" only after it (spec step 8).
- `nextSyncStep` with `hold`, four rows after `posting` and before every other: `hold`, `setting` set, off stored:
  `clear`, flag `relay_off`; `hold`, `setting` set: post off, flag `copy`; `hold`, off not stored: post off, flag null;
  `hold`: none, flag `relay_off`. With `hold` false the table is as it was, so the controller names a copy once one
  keeps pace (spec step 10).
- `updater.sh`, on the `lead` path only (Task 10 names the paths; until then, a machine with no `replica.json` and not
  `HORNHOOF_ROLE=worker`):
  - `unpack` also takes `/app/apps/server/drizzle/meta/_journal.json` as `journal.json`; a missing one is no failure.
  - `update`, after the downloads: `BEFORE=$(applied)` (moved up from `backup`); `MIGRATIONS` the journal's `.entries
    | length` minus `BEFORE` when both are numbers and that is 0 or more, else empty; `write_status` writes
    `migrations` (null when empty) and `restore` (true once `RESTORE=1`), from then on in every status.
  - `promise_copies`, then: `step promise "Asking the copies to wait for the update."`; once a second, up to
    `PROMISE_WAIT` seconds, `promised.json` with this `id`: `ok` true goes on; false `stop_with failed "<why>, so
    nothing changed."`; none `stop_with failed "The keeper did not answer, so nothing changed."`.
  - `step backup`, then `settle_wait`: up to `SETTLE_WAIT` seconds for `settled.json` with this `id`; `ok` true goes on
    to plan 2's stop of the app and the dump; else `stop_with failed "The copies did not confirm the last changes, so
    nothing changed."`.
  - `go_back`, when it restores: `RESTORE=1`, `write_status running rollback`, up to `DROP_WAIT` seconds for
    `slots-dropped.json` with this `id`; then `drop_slots` of its own, whether the file came or not: in `db`, as the
    owner, `pg_terminate_backend` of every slot's `active_pid` and `pg_drop_replication_slot` of every slot, again each
    2 s for up to `DROP_WAIT` seconds until `pg_replication_slots` has no row; then `keep_link` and `restore` as today.
    A slot still there at the end: no restore, `stop_with failed "Could not drop the copies' slots, so the database was
    not put back. Run install.sh server in $SERVER_DIR, and see docker compose logs keeper."`, the maintenance state
    staying until then.
  - `interrupted`: `promise` and `pull` start over (W not read yet); `backup` goes on from `backup`: `BEFORE` read again
    (no migration ran yet), `MIGRATIONS` from the status, `step backup`, `settle_wait` (the keeper's `settled.json` of
    this id stands, since the step, and so the maintenance state, never left `backup`), then the dump.
  - `PROMISE_WAIT` 30, `SETTLE_WAIT` 120, `DROP_WAIT` 60, each from `HORNHOOF_PROMISE_WAIT`, `HORNHOOF_SETTLE_WAIT`,
    `HORNHOOF_DROP_WAIT` when set, as `HEALTH_WAIT`.
- The docker stub: `cp` of `_journal.json` writes `{ "entries": [...] }` with as many entries as `STUB_MIGRATIONS` gives
  that build; a query of `pg_replication_slots` answers the lines of `$STUB_STATE/slots` (none when missing), and a
  `pg_drop_replication_slot` empties it unless `STUB_SLOTS_STAY` is set; `STUB_STOP_IN=backup` stops the updater at its
  first `pg_dump`, once, as `pull` does.
- Web: `UpdateStep` gains `promise`; `STEPS` is `['pull', 'promise', 'backup', 'install', 'health']`;
  `updates.steps.promise`: "asking the copies to wait" / «прошу копии подождать».

- [ ] **Step 1: Write failing tests.**
  - `update-steps.test.ts`: one test per row, named by it (for example `updates: settle no when a copy has not confirmed
    W within a minute`), each with a sample where every earlier row fails; and `answers ok at once with no copy`: step
    `promise`, `online` `[]`, after `promise`: answers `{}` gives answer ok.
  - `lead-update.test.ts`, on `createTestSql` with a temporary control and keeper folder and fake peers:
    - `promises and answers`: two copies in `pace`: each gets `{ version, until, migrations }` with `until` 15 minutes
      ahead; both 200: `promised.json` `{ id, ok: true }`; one silent: `ok` false with why "<its host> did not answer".
    - `waits for the copies at W, then stops them for migrations`: status `backup` with `migrations` 2, the lease in
      maintenance: one `net_local.maintenance` row; `w` read; the fake slots below W: no `settled.json`; at W: `{ stop:
      true }` to each, `hold(true)`; with one copy not answering the stop, or `held()` false (the relay silent): no
      `settled.json`, the stop sent again, and after 60 s `settled.json` `ok` false; with both answering and `held()`
      true: `settled.json` ok. With `migrations` 0: no `stop`, no hold.
    - `refuses the dump when a copy stays behind`: a slot below W for 61 s of fake time: `settled.json` `ok` false.
    - `drops the slots before a restore`: status `rollback` with `restore` true: `{ stop: true }` to each, the slots
      gone, then `slots-dropped.json`.
    - `ends only once it leads`: status `rolled_back`, `leads` false: the row stays; `leads` true: the row gone, `{
      ended: true }` to each, `hold(false)`, the files gone.
    - `promises again while the update runs`: 5 minutes of fake time in step `install`: a second promise and `until`
      moved.
    - `goes on after a restart`: a new `LeadUpdate` over the kept `lead-update.json` at step `backup` with `w` set:
      reads no new W and settles once the slots reach it; over one at step `promise` with `promised` set and no answer:
      sends the promise again; over one with `stopped` true: `hold(true)` before its first sample.
  - `sync-step.test.ts`: one test per `hold` row; `holds sync off`: with off stored, no setting and a copy keeping pace,
    `hold` gives none; `hold` false: `set` as before.
  - `updater.test.ts` (its stubs; the keeper's files written by the test):
    - `asks the copies before it saves the database`: with `promised.json` ok and `settled.json` ok: the status shows
      step `promise` before `backup`, `migrations` 2 for a build of 22 entries over 20 applied, and the dump comes after
      `settled.json` appeared.
    - `ends when a copy does not promise`: `promised.json` `{ ok: false, why: 'Mac did not answer' }`: `failed` with
      "Mac did not answer, so nothing changed.", no dump, no install.
    - `ends when no keeper answers`: no `promised.json` within `HORNHOOF_PROMISE_WAIT=1`: `failed` with "The keeper did
      not answer, so nothing changed.".
    - `ends when the copies do not confirm`: `settled.json` `ok` false: `failed` with "The copies did not confirm the
      last changes, so nothing changed.", no dump.
    - `waits for the slots before it restores`: a build that fails its health check after a migration: status `restore`
      true, then, after `slots-dropped.json`, the stub's slot query, then the restore; with none within
      `HORNHOOF_DROP_WAIT=1`, the updater's own terminate and drop, then the restore once the stub lists no slot; with
      the stub listing a slot throughout: no restore and `failed` with "Could not drop the copies' slots, so the
      database was not put back.".
    - `starts over when stopped while asking`: `STUB_STOP_IN` during step `promise`: the next start runs the update from
      the beginning. `goes on from the dump when stopped there`: stopped in `backup` after `settled.json`: the next
      start writes no `pull` or `promise` status, takes the dump and installs.
  - `test/real/update-rollback.test.ts`, on a pair as Task 4's, the copy subscribed and active, the leader's sync naming
    it: `LeadUpdate` through `begin`, `stop_copies` and `settle` with the fake relay; the dump taken as the updater
    takes it (`pg_dump` in the leader's container); a migration that adds a column applied on the leader; then status
    `rollback` with `restore`: `drop_slots`; the updater's restore commands run as `updater.sh` runs them
    (`hornhoof_restore` loaded from the dump, `DROP DATABASE hornhoof WITH (FORCE)`, the rename): they succeed; the
    restored database has the `net_local.maintenance` row the dump held, and not the new column; then `end`: the row is
    gone and the copy, its subscription enabled again, finds its slot missing, which is plan 9's remake.
  - `UpdateProgress.test.tsx`: `counts the promise as a step`: step `promise` is "2 of 5" with "asking the copies to
    wait", in Russian «прошу копии подождать».
- [ ] **Step 2: Run** the files of Done when. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Update with copies: their promise, the dump once they hold every change, sync off for
  migrations, slots dropped before a restore".

### Task 10: The copies during an update, and the updater's path and installer

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 9 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/copy-updating.test.ts test/follow-keeper.test.ts
test/copy-maker.test.ts test/updater.test.ts test/install.test.ts` passes (plan 5b's test of `install.sh` where its name
differs), then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing; `bash -n` and
`shellcheck` on `apps/updater/updater.sh` and `scripts/install.sh` print nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/updating.ts`
- Modify: `apps/server/src/modules/keeper/follow.ts` (`/peer/updating`, the app mode, the fallback),
  `apps/server/src/modules/keeper/copy.ts` (the maker holds), `apps/updater/updater.sh` (`update`'s path and installer,
  `wipe_request`), `scripts/install.sh` (`worker` mode on a data machine), the writer of `wipe.json` (plan 9's)
- Test: `apps/server/test/copy-updating.test.ts` (new), `apps/server/test/follow-keeper.test.ts`,
  `apps/server/test/copy-maker.test.ts`, `apps/server/test/updater.test.ts`

**Interfaces:**
- Consumes: Task 9's `/peer/updating` bodies and `PROMISE_MS`; plan 9's `FollowKeeper`, its fallback to its own app (its
  ruling 4), `CopyMaker` and its remake; plan 5b's worker path in `updater.sh` (`wait`, `go.json`, `install.sh worker`,
  `HORNHOOF_HEALTH_URL`) and `compose_from_image`; plan 9's `wipe_request` and `wipe.json`.
- Produces:
  ```ts
  // modules/keeper/updating.ts
  export const PROMISE_FILE = 'promise.json';   // control folder, 0600, whole and then moved
  export type UpdateWord = { leader: string; version: string; until: number; migrations: number | null;
    stopped: boolean; at: number };
  export function readWord(controlDir: string): UpdateWord | null;
  export class CopyUpdating {
    constructor(opts: { controlDir: string; sql: Sql; leader: () => string | null;
      subscription: { enabled(): Promise<boolean>; disable(): Promise<void> }; now?: () => number;
      log: (line: string) => void });
    handle(from: string, body: unknown): Promise<{ status: number; body: object }>;
    holds(): boolean;    // a word whose until has not passed
    stopped(): boolean;  // the word stopped the subscription
    tick(): Promise<void>;
    //   on start and once a second: a word past its until goes, as { ended: true }; a stopped word whose
    //   subscription is enabled disables it again
  }
  ```
- `POST /peer/updating` on the follow keeper's peer server, from a data certificate:
  - `{ version, until, migrations }` from the machine `leader()` names, or from the word's `leader` while a word holds
    (a renewal, sent while the leader's hello says `lead: false`): `PROMISE_FILE` with that machine as `leader` (and
    `stopped` as it was), then `net_local.maintenance` (version, since now, until) in its own database, then 200 `{ ok:
    true }`; a body of another shape 400; from another machine 403.
  - `{ stop: true }` from the word's `leader`: `stopped` true written, then `subscription.disable()`, then 200; again:
    200 and nothing new; with no word 409.
  - `{ ended: true }` from the word's `leader`: `net_local.maintenance` deleted, then the file removed, then 200; with
    no word 200.
- While `holds()`: the follow keeper's `keeper.json` says `maintenance` (plan 2's mode), its front door never passes to
  its own app (plan 9's ruling 4 waits), and `CopyMaker` does nothing that starts or finishes a remake, a schema load, a
  swap or a new subscription, does not enable a subscription while `stopped()`, and counts no failure toward giving an
  attempt up; it keeps the reasons it saw (the order's count of migrations, a slot `missing` or `lost`) and, once the
  word is gone, acts on the order of then as plan 9's: it enables a subscription the word disabled unless its remake
  rule says remake. A remake or swap already under way when the word came stops at its next step and goes on after.
- `install.sh worker` (plan 5b), on an `.env` whose `COMPOSE_PROFILES` names `data`: `docker compose up -d --no-build`
  of every service `compose config --services` gives but `updater` (so `db`, `migrate`, `app`, `keeper`, `front` and,
  with `builtin`, `node`), as plan 9's `become_data` names them; `app` waits for `migrate` (plan 2), which migrates a
  joined leader and does nothing on a copy (plan 9). Without `data` it stays as plan 5b's (`keeper front`). The log
  lines: "The company server is updating to <version>; this copy waits." at the promise; "The company server's update
  ended." at the end; "The company server's update promise ran out." when `until` passed.
- `updater.sh`: `PATH_KIND` and `SHAPE`, read at the start of each `update`:
  - `PATH_KIND`: `worker` with `HORNHOOF_ROLE=worker` (as plan 5b reads it), `copy` with `$CONTROL/replica.json`, else
    `lead`.
  - `SHAPE`: `worker` when `.env` names `COMPOSE_FILE`, else `server`.
  - The path decides the steps: `lead` is today's server flow with Task 9's steps and health at `front` as a server's;
    `copy` and `worker` are plan 5b's worker flow (no backup, no migrations, `wait` for its grant), health at the
    keeper's `/api/keeper`. The shape decides the files: `install.sh <SHAPE>`; with `worker`, `unpack` takes
    `compose.worker.yaml` and `pull_images`, `services_without_node` and `remove_unnamed` read `-f compose.yaml -f
    compose.worker.yaml`, as plan 5b's worker; with `server`, `compose.yaml` alone.
- `wipe.json` gains `server`, the link's `https://<host>` from the view of the keeper that writes it; `wipe_request` on
  an install whose `.env` names no `COMPOSE_FILE` also writes `COMPOSE_FILE=compose.yaml:compose.worker.yaml` (that file
  taken from the image by `compose_from_image`) and `HORNHOOF_JOIN_SERVER=<server>`, in the same rewrite of `.env` as
  plan 9's other lines; a `server` that is not `https://` and a host name refuses the wipe with one line.

- [ ] **Step 1: Write failing tests.**
  - `copy-updating.test.ts`, on `createTestSql` with a temporary control folder:
    - `promises before it answers`: from the leader: `promise.json` and the `net_local.maintenance` row exist when the
      200 comes; from another machine 403 and nothing written.
    - `stops and ends`: `{ stop: true }`: `stopped` written before `disable` is called; `{ ended: true }`: no row, no
      file.
    - `hears the leader that promised`: with `leader()` null after the promise (the leader in maintenance): a renewal,
      `stop` and `ended` from the promising machine: 200; from another: 403.
    - `finishes a stop a restart cut`: a word `stopped` and the subscription enabled: `tick` disables it.
    - `lets a promise run out`: `until` passed: `tick` removes both, with its log line.
  - `follow-keeper.test.ts`: `waits for the update`: with a word that holds, `keeper.json` says `maintenance`, and with
    no leader for 90 s of fake time the front door still does not pass to its own app; once the word is gone, it does
    after 60 s as plan 9's.
  - `copy-maker.test.ts`: `holds its subscription for the update`: a word `stopped`: the maker does not enable the
    subscription and records no failure for 10 minutes of fake time; once the word is gone with the same count of
    migrations, it enables it; with the leader's count changed, it remakes. `remakes nothing while the word holds`: a
    word that holds and an order with a changed count of migrations, then one with the slot `missing`: no
    `hornhoof_next`, no `schema.json`, no `CREATE SUBSCRIPTION`; the word gone: one remake, against the order of then.
  - `install.test.ts` (plan 5b's): `updates a data machine's app`: `install.sh worker` with `HORNHOOF_FROM_UPDATER` on
    an `.env` with `COMPOSE_PROFILES=data,builtin` runs `up -d --no-build` naming `db`, `migrate`, `app`, `keeper`,
    `front` and `node`, never `updater`; with no `COMPOSE_PROFILES`: `keeper front` as before.
  - `updater.test.ts`:
    - `picks its path and installer`: no `replica.json` and no `COMPOSE_FILE`: promise, backup, `install.sh server`;
      `replica.json` and no `COMPOSE_FILE`: no promise, no backup, `wait` for `go.json`, then `install.sh server` with
      `compose.yaml` alone; no `replica.json`, `COMPOSE_FILE` and `HORNHOOF_ROLE=data`: promise, backup, `install.sh
      worker` with both compose files, and health at `front`; `replica.json` and `COMPOSE_FILE`: plan 9's copy flow as
      before.
    - `wipes a server's install into a worker`: `wipe.json` with `server` `https://acme.hornhoof.test` on a `.env` with
      no `COMPOSE_FILE`: `.env` has `COMPOSE_FILE=compose.yaml:compose.worker.yaml`,
      `HORNHOOF_JOIN_SERVER=https://acme.hornhoof.test` and plan 9's lines, and `compose.worker.yaml` is in the folder;
      with `server` `http://x`: refused, `.env` as it was.
- [ ] **Step 2: Run** the files of Done when. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let copies keep their promise through an update, and update each machine by what it is now".

### Task 11: The lab: moving the server and back

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 10 committed. **Done when:** from the worktree
root `npm run test:lab` passes with Docker running; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/test/lab/switch.test.ts`
- Modify: `apps/server/test/lab/lab.ts` (`edge`), `apps/server/test/lab/steps.ts` (the probe's address in `.env`)

**Interfaces:**
- `lab.ts` gains `edge(fake: FakeRelay, name: string, machines: LabMachine[]): Promise<{ url: string; close():
  Promise<void> }>`: an HTTP server of the test process on a free port of every interface, its `url` by the address plan
  9's `relay()` uses. For `GET /api/network/lease?nonce=<n>` it reads `fake`'s route for `name`, finds the machine whose
  link frpc config holds that client id, runs `curl -s` of the same path on that machine's keeper link door from inside
  its `keeper` container, and answers what it got (502 when no machine holds the route). It plays the edge's part in the
  probe, as `fake.register` plays frps's.
- `steps.ts`: `installServer` and `joinWorker` take `{ probe }` and write `HORNHOOF_LINK_PROBE=<probe>` into `.env`.
- `switch.test.ts`, one scenario, 60 minutes at most, `df -h /` and `docker system df` first as plan 7's Task 10 says:
  1. m1 a server with the lab's relay and edge, set up, the link on and registered; m2 joined by the owner, m3 by a
     person whose scope is the whole company; within 15 minutes m2 is number 2 and m3 number 3, both `ready`, and m2
     named sync. m1's and m2's built-in nodes are online in `GET /api/pool`, m1's as `builtin` and m2's in `builtins`.
  2. The writer on m1's API for the rest of the scenario.
  3. "Move the server here" on m2 as the CEO: 202. The test plays frps for the link name in every move: once the
     leader's `handing.json` says `go` (the leader stops its link frpc), `fake.drop(<link name>)`; once the taker's
     `taking.json` says `go`, `fake.register(<link name>, <the taker's link client id>)`, which then answers `ok`.
     Within 120 s: m2's `/api/keeper` says `lead`; m1's says `read` with m2 as leader; at no sample of the test's
     one-second poll did both say `lead`; `GET /api/machines` from m1's address has m2 the leader and number 1, m1
     number 2 with its copy `ready` within 5 minutes, and no `move`; m2's `net.handovers` has one row naming m1 and m2;
     m1's `net_local.state` has `handed_to` m2's network id; m3's copy is `ready` within 5 minutes and was not made
     again (its `copy_name`'s attempt one up, and its `copy_state` never `making` or `remaking` in the test's samples);
     m2's `GET /api/pool` has m2's built-in node as `builtin` and m1's online in `builtins`.
  4. "Move the server here" on m1: the same checks with the machines' parts swapped.
  5. "Move the server here" on m2, and once m2's `taking.json` says `go`, `docker restart` of m2's `keeper`, then the
     registration: m2 leads within 120 s, never two at once, and the same checks as in step 3.
  6. "Move the server here" on m1, with the drop at m2's `go` and no registration for m1: within 120 s m2's keeper
     folder has no `handing.json`, and then the test registers m2's link client again, as frps would once m2's link frpc
     started; m2 leads again, m1 says `read` with m2 as leader and its copy `ready`, never two at once, `GET
     /api/machines` has `move` `failed` with the reason `no_link`, and the fake relay's route names m2's client.
  7. The writer stopped. The test reads m2's `pg_current_wal_lsn()` and waits, 2 minutes at most, until m2's `copy_%`
     slots for m1 and m3 have `confirmed_flush_lsn` at or past it; then `checkRows` of m1, m2 and m3 for every id the
     writer kept are empty.

- [ ] **Step 1: Write the failing test** and `edge`; `npm run test:lab` fails at its step 3.
- [ ] **Step 2: Fix** what it finds in Tasks 1 to 10, each fix with its failing test first in that task's test file.
- [ ] **Step 3: Check the disk, then run Done when,** as plan 7's Task 10 Step 3. Expected: PASS.
- [ ] **Step 4: Commit** "Test the planned switch in the lab: there, back, a restart in the middle, and an abort".

### Task 12: The relay counts its traffic (addendum A2 to plan 1)

**Repo:** the relay repo, `/Users/0x/Projects/hornhoof-edge`, branch `main`. **Starts from:** plan 1's addendum A1
committed. **Done when:** `python3 -m unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Modify: `relay/relay.py` (the tables, the counter, its thread, `admin traffic`), `relay/hornhoof-relay` (its usage
  lines), `README.md` ("What it stores")
- Test: `relay/test/test_traffic.py` (new)

**Interfaces:**
- Produces, in `relay.py`:
  ```python
  TRAFFIC_EVERY_S = 60
  TRAFFIC_WARN_BYTES = 300 * 10**9
  def default_iface(proc: str = '/proc') -> str | None:   # the interface of the first 00000000 destination in <proc>/net/route
  def sent_bytes(iface: str, sys: str = '/sys') -> int | None:   # <sys>/class/net/<iface>/statistics/tx_bytes
  def boot_id(proc: str = '/proc') -> str | None:          # <proc>/sys/kernel/random/boot_id
  def count_traffic(at: int, proc: str = '/proc', sys: str = '/sys') -> int | None:
  #   adds what was sent since the last read to the UTC month of `at`, and answers that month's total; None when
  #   the interface or its counter cannot be read (nothing changes)
  def watch_traffic() -> None:   # every TRAFFIC_EVERY_S, forever, as watch_frps
  ```
- `init_db` makes `traffic (month TEXT PRIMARY KEY, bytes INTEGER NOT NULL)` and `traffic_seen (id INTEGER PRIMARY KEY
  CHECK (id = 1), boot TEXT NOT NULL, iface TEXT NOT NULL, sent INTEGER NOT NULL, at INTEGER NOT NULL)`.
- `count_traffic`: the same boot and interface and a reading at or above `sent`: adds the difference; another boot or
  interface, or a reading below `sent`: adds the whole reading (the counter started from zero); no `traffic_seen` yet:
  adds nothing. Then `traffic_seen` is the new reading. Both writes in one transaction.
- `watch_traffic` logs, at most once per UTC day while the month's total is past `TRAFFIC_WARN_BYTES`: "Sent <n> GB this
  month, past 300 GB: time to resize the server." (`<n>` in 10^9 bytes, one decimal); `main` starts it beside
  `watch_frps`; an exception in one round is one log line, and the next round runs.
- `admin traffic`: the last 12 months, oldest first, one line each: `<YYYY-MM>  <n> GB`; no rows: "No traffic counted
  yet.". `hornhoof-relay`'s comment lines gain `hornhoof-relay traffic  bytes sent per month, the last 12 months`; the
  usage line of `admin` names `traffic`.
- README, "What it stores": "For the server itself, the bytes its public interface sent each month, so its operator
  knows when to resize it." after the paragraph on addresses.
- The runbook line is the team lead's, in `~/.hornhoof-edge/droplet/README.txt`: "Each month: `hornhoof-relay traffic`.
  Past 300 GB of the 500 GB included, resize the droplet (the journal says so once a day)."

- [ ] **Step 1: Write failing tests** in `test_traffic.py`, with fake `proc` and `sys` folders in a temporary folder and
  `RELAY_DB` pointed at a fresh file as the other tests do:
  - `test_default_iface`: a route file with `eth1` on `00000000` after a line of `eth0` on another destination: `eth1`;
    with no default: None.
  - `test_counts_since_last_read`: readings 1000 then 1500 in one month: the month's total 500; then 1400 (went down):
    1900; then another `boot_id` with 300: 2200; another interface with 50: 2250.
  - `test_months_apart`: a reading at 23:59:30 UTC on the last day of a month and one at 00:00:30 on the next: the
    difference goes to the second month.
  - `test_unreadable_counts_nothing`: no route file: None and no row written.
  - `test_admin_traffic`: three months stored: `relay.py admin traffic` prints three lines oldest first with one
    decimal; none: "No traffic counted yet.".
  - `test_warns_once_a_day`: past 300 GB: two rounds on the same UTC day give one log line; a round the next day
    another.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_traffic.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** (`commit -s`) "Count the bytes the relay sends each month".
- [ ] **Step 6: Deploy and the runbook line** (the team lead's): with the series' other relay work, at its end, before
  the rehearsal, as addendum A1. Check: `hornhoof-relay traffic` on the droplet prints the month after two minutes.

### Task 13: Run everything and review

**Repo:** the `network` worktree, branch `network`, and the relay repo. **Starts from:** Tasks 1 to 12 committed and
reviewed. **Done when:** Steps 1 and 2 pass for the agent; Step 3 is the team lead's, never an agent's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` and `npm run
  test:lab` (after the disk check) → pass; the `tsc` commands → no output; `bash -n` and `shellcheck` on
  `apps/updater/updater.sh` → no output; in the relay repo `python3 -m unittest discover -s relay/test -v` → pass.
- [ ] **Step 2: Check the public-repo rule.** As plan 7's Task 11 Step 2, in both repositories.
- [ ] **Step 3: Review.** The team lead reads the branch against spec 3.4 "Planned switch", 3.7 "Promotion" and
  "Sequences", 3.9 "Built-in node", section 2's "Move the server here", section 4's two rows, section 9 "Updates across
  machines" and "The maintenance state", section 12's bullets, the overview's plan 9 entry and this plan's rulings, with
  Review Focus first; the CLI agent that did not write a task reviews it too; one fix pass, each fix with its failing
  test first.

The rehearsal, the merge into main, Ivan's Updates and the worktree's close are done once, for the whole series, at its
end. This plan's part of that rehearsal is Task 11's scenario and an Update of the rehearsal's company with a copy.
