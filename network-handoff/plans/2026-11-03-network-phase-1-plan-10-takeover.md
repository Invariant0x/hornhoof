# Network Phase 1, Plan 10: Takeover, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the machine that leads stops, its sync copy takes the company over by itself in about a minute: the data
machines tell each other each second where they stand, the leader keeps its lease only while hornhoof.org or its sync
copy vouches for it, and the copy takes the name at hornhoof.org only once the leader has been silent and its route
empty long enough, and only when the relay's sync record says it holds every confirmed change. Otherwise the copies ask
the CEO, who may say "Go on from 23:40" on one of them. An old leader that comes back follows the new one: what it wrote
is bundled and merged, then it becomes a copy again, and its card says so; the server never moves back by itself. Jobs
of the old leader keep running and their results wait for the merge. The page stays open through a switch and says what
happens. A company with no public link gets a hidden name at hornhoof.org, so it can have copies too.

**Architecture:** One migration, `0058_takeover`: `net.handovers` records takeovers and the CEO's choices beside planned
switches, and when each was told, `net.parked` keeps the results of jobs the new leader does not know, `public_links`
gains `hidden`, `machines` gains the led database's term (`copy_old_led`) and the copy step `saving`. The keepers'
decisions are pure (`modules/keeper/takeover-step.ts`): the relay window, the copy's watch (checks 1 to 5), the old
leader's way back in, and B's promise; plan 3's `nextLeaseStep` takes proofs. Every data keeper sends and answers
heartbeats (`beats.ts`, `/peer/beat`); the leading keeper renews by proof (a) or (b) (`proofs.ts`) and, without a lease,
comes back in by B's promise or the relay's window, or follows; the follow keeper watches (`watch.ts`) and, when it
takes over, writes plan 9c's `taking.json` of a new kind and exits, so plan 9c's `Promoter` promotes it. The CEO's
question lives in the keeper (`question.ts`) and the app's recovery API in `read` (`modules/recovery/`), with a signed
sign-in cookie for `read`. A led database is bundled by its own machine (`led.ts`) and merged whole before plan 9's
remake drops it. The hub parks the messages of unknown jobs while a merge is pending (`modules/nodes/parked.ts`). The
keeper's front door answers where the company is moving (`switch-word.ts`), and the web shows the banners.

**Tech Stack:** TypeScript on Node 22 (`node:http2`, `fetch`, `node:crypto`); Postgres 17.11 logical and synchronous
replication; Fastify 5; drizzle-orm 0.45.4 on node-postgres and PGlite; bash 3.2 and BusyBox for `updater.sh`; React for
the web app; vitest; Docker for `npm run test:real` and `npm run test:lab`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.4 "Heartbeats", "The lease" (proofs (a) and (b)),
"Re-entry", "Takeover by B" (checks 1 to 5), "B's promise", "Why the two never both get commits confirmed", "When the
relay and the copy are both gone", "Without a public link", "One data machine" (from the first finished copy on, proofs
only), and "Planned switch" step 8's broken peer link; 3.6's "Go on here" and "Go on from" terms "by the CEO" and its
rule for turning normal, as ruling 7 takes them; 3.7 "Promotion" after a takeover, "No database is thrown away" and
"Rejoining" after an unplanned switch; 3.9 "Jobs" across an unplanned switch, `read` mode's sign-in and recovery API;
3.10's timing; section 2's "During a switch" banners, "A copy that may be missing changes" with its question, and the
old leader's note on its card; section 4's rows of the leader stopping, sleeping, losing the internet or its Docker, the
relay restarting or down, the peer link down, the leader and its sync copy stopping together, the home of both losing
the internet, the old leader coming back, disk full and the leader dying mid-update; section 5 steps 1 and 2 for a
machine that led; section 12's first bullet (the keeper's decisions as a pure function, table-tested), the server order
bullet's "the new leader 1 after a takeover, the old one ranked again and never given the server back" and "the leader
dying in a relay outage of 90 s", the real pairs' "a third copy remade after an unplanned switch", and the lab's "number
1 cut off and coming back", "the leader and its sync copy stopped together" and the overlap checker. Overview
`notes/plans/2026-11-03-network-phase-1-overview.md`, plan 10's entry with what it takes from plan 9 (rulings 12 and 18)
and from plan 9c (ruling 12).

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see them
fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only the
task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a test of
an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in the series' worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network` on its branch `network`, after plan 9c's last task is
committed there. Nothing of the series ships until it merges into main, once, at its end.

**Handed over** (done on the `network` branch before this plan starts; none of it is shipped):
- Today's code: `handleNodeMessage`'s `hello`, `job.started`, `job.event` and `job.done` (`modules/nodes/messages.ts`:
  unknown jobs cancelled at hello, their events and ends dropped), `jobStarted`, `jobsOf`, `failOpenJobs`, `OPEN_JOBS`;
  the tool token check (`modules/tools/job.ts`); `enqueueTurn` and its `answersCeo` (`modules/conversation/queue.ts`),
  as `modules/computer/routes.ts` tells the orchestrator; the login (`modules/auth/routes.ts`), `limiter`
  (`auth/limit.ts`), `startSession`, `requirePerson`, `SESSION_COOKIE` (`auth/session.ts`); `PublicLinks`
  (`set(companyId, name?)`, `remove`, `sync`) and `linkOf` (`modules/link/link.ts`), `public_links`.
- Plan 1: the relay client's `route`, `setSync`, `health` (`Route`, `SyncRecord`); `FakeRelay` with `register`, `drop`,
  `restartFrps`, `frpsDown`, `routeAnswer`, `evictionBound`.
- Plan 1b: `SIGN_IN_LIMITS` (`auth/sign-in-limit.ts`), the sign-in tries counted in the database, the
  `__Host-hh_session` cookie over the link.
- Plan 2: `Keeper`, `KeeperOptions`, `KEEPER_PORTS`, `keeper.json` (`readKeeperState`, `writeKeeperState`,
  `KeeperState`), `AppMode` and its modes; `front`'s hold (`HOLD_MS`) and its 503 with `Retry-After`; read mode as its
  ruling says (new sign-ins refused, `/mcp` refused, nodes refused).
- Plan 3: `Term`, `LeaseKind`, `net_local.state`, `net_local.lease`; `LeaseStore` (`take`, `renew`, `fence`), `Clocks`,
  `Held`, `LEASE_MS`, `LATE_MS`, `leaseValid`, `nextLeaseStep`, `LeaseStep`; `Keeper.mode()` and `problems()`; the fence
  trigger, which commits under a `split` lease with `sync` null; `net.journal`; `keeperSql`; `Keeper.term()`; the
  keeper's answer to `GET /api/network/lease?nonce=` (`{ machine, term, nonce }`, `machine` the keeper's network id);
  ruling 8.
- Plan 4: `public.applied`, node messages numbered and confirmed, the node's outbox; `front` stamping tool calls and
  retrying them across a switch (`net/front-calls.ts`: `frontCalls`, `CALL_HOLD_MS`, `CALL_LOST`, `CALL_NOT_SENT`); the
  built-in node through `front`.
- Plan 5: `PeerServer`, `PeerServerOptions`, `PEER_PATHS`, `Peer`; `TunnelKeeper`, `linkClientId`; `tunnelSettings`;
  `CertificateKeeper`; `findThisMachine`.
- Plan 5b: `PeerLink` (`use`, `leader()`, `request`, `stream`, `connectDb`), `Hello`, `DialTarget`; `WorkerKeeper`,
  `WorkerView`, `workerView`, `PEERS_FILE`; the lab (`Lab`, `LabMachine`, `steps.ts`).
- Plan 7: `sealBundle`, `checkHead`, `headLine`, `readHead`, `BundleStore`, `BackupKeeper`, `MakerView`, `dump.json`,
  `dumps/`, `POST /api/network/backups` and `recordBundle`, `pickHolders`, `/peer/backups/`.
- Plan 8: the merger, `MergeSource`, `net.merges` and their statuses, the whole way of comparing, `runMerge` (its step 5
  adding `net.backups`), `complete`, the reading's `backupsOf` (`read.ts`), the picks (`picks.ts`), ruling 7 (nothing
  the source left open runs again, `CLOSING`), fork bundles (`reason` `fork`, `FORK_KEEP_MS`, `dump.json` with
  `database`).
- Plan 9: `FollowKeeper`, `keeperRole`, `REPLICA_FILE`, `CopyMaker`, `CopyReport`, `CopyOrder`, `COPY_STATE`, the remake
  into `hornhoof_next` and its swap (ruling 14) with the old database merged as `machine:<machine id>:<attempt>`
  (`peerSource`, `MACHINE_SOURCE`, `machines.copy_old`, `workerView`'s `copy.old`), the carry of ruling 21 (`Carry`,
  `applyCarry`, `carry.sql`), the one id-set read (ruling 15), the guard of ruling 12 (`stopped`, error `led`);
  `SyncController` (`flag()`, `renew()`, `copies()`), `nextSyncStep`; the link frpc stopped at lease end and started
  again 30 s later (ruling 17); `net.pulse` and the copy's `copyAt`; `qualify.ts` with ruling 18's `no_link` and
  `PublicLinks.remove`'s 409 `link_needed`; `machines.copy_state`, `copy_error`, `copy_at`; the card's copy lines
  (ruling 16); the lab's `writer.ts` (`startWriter`, `checkRows`) and `relay()`.
- Plan 9b: `Ranking` (ranks at the app's first lead: the leader 1, the rest by score), `planRoles`; the card's Priority
  part.
- Plan 9c: `taking.ts` (`TAKING_FILE`, `Taking`, `Taker`, `Promoter`, `readTaking`, `writeTaking`), `nextTakeStep`,
  `takeState`, `promote.ts` (`writeTerm`, `termOf`, `dropSubscriptions`, `raiseSequences`, `makeSlots`,
  `recordHandover`, `handoverOf`, `applyRunning`), `handing.ts` (`Hander`, `HANDING_FILE`), `seedView`, `markHanded`,
  `net.handovers`, `net.move`, `keeperRole`'s kinds `taking` and `handing`, a keeper's exit to change kind,
  `probe(nonce)` with `HORNHOOF_LINK_PROBE`, `promise.json` (`PROMISE_FILE`, the copies' update promise),
  `SyncController.hold` and `held`, `PeerLink.ask` (plan 9c's Task 7), the lab's `switch.test.ts` and `edge()`.
- Main's turn failures, once merged into the branch: `jobs.failure`, `jobs.not_before`, `jobs.restarted_at`; `job.done`
  carrying `failure` (its kind) and its handling's `afterFailure` (passing failures tried again after 1, 2, 5 and 10
  minutes, the plan held on `usage_limit`); the node messages `agent.restarted` and `agent.unheard { agentKey, jobId |
  null, text }` (words a program never took, put into the agent's next turn), and the server message `agent.restart`.
  Task 8 parks an `agent.restarted` that names a job with no row as it parks `job.event`, never `agent.unheard`, and
  applies a parked `job.done` with its `failure` through `afterFailure` once.
- Where the branch's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`; in Russian a plan is «тариф».
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`, `.superpowers/`,
  `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh config
  or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys and passwords made at run time.
- No new npm dependency. One new migration, `0058_takeover`: `npx drizzle-kit generate --name takeover` from
  `apps/server` for what `schema.ts` describes, with the hand-written part of Task 1 appended after a `-->
  statement-breakpoint`; never an edit of an older one. Its number follows plan 9c's `0057`, and its journal `when`
  stays above 1793700000000, main's `0046_turn_failures` (the series renumbers at its merge).
- One leader at a time (spec 3.4): a leader renews its lease only on a proof sent after its last renewal, never after it
  lapsed, and ends it at once when another machine answers at its link or says it leads under a newer term; a copy
  registers the name only after checks 1 to 4 and, without the CEO, check 5; an old leader leads again only on B's
  promise of the next term or through the relay's window at the generation of its own last registration. Two machines
  confirm writes in overlapping periods only while one of them writes under a term by the CEO.
- No confirmed write is lost (spec 3.4, 3.7, section 5): only the copy the relay's record names "on", at the route's
  generation, takes over without the CEO; no database that led is dropped before its bundle is recorded and its merge is
  `merged` or `done`; a job's result that arrives before its job's row is parked, never dropped.
- Hornhoof never moves the server back by itself (spec section 2): a machine that led and came back follows; only "Move
  the server here" (plan 9c) moves the server while its machine runs.
- Messages between keepers and apps change only by additions (spec section 9): a keeper of plan 9c's build that does not
  know `/peer/beat` answers 404, which counts as no answer.
- Ivan's rules: only a machine's owner opens computer access to it; no step of this plan asks Ivan to type a command.
  The CEO only answers the question on a page; everything else happens by itself.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; `npm run test:real` and `npm run test:lab` need Docker. Types, from the worktree root: `npx tsc
  -p apps/server/tsconfig.json --noEmit`, and `apps/web` likewise when touched, each printing nothing. `bash -n` and
  `shellcheck` on `apps/updater/updater.sh` print nothing when it is touched. Never run prettier.
- Before a real or lab run on the team lead's Mac: `df -h /` and `docker system df`; clean only build cache and
  `hornhoof-lab/*` images, never a volume.

## Rulings made while planning

1. **What this plan takes.** The overview's plan 10 entry, with what plans 9 and 9c handed it: heartbeats naming the
   sync copy, proofs (a) and (b), re-entry, the takeover by B with checks 1 to 5, B's promise, the CEO's question and
   "Go on from", terms; the old leader's return (its bundle, its merge as a machine that wrote, its remake, its card's
   note, ranked again and never given the server back); jobs across an unplanned switch; `read` mode's recovery API and
   sign-in; rejoining after an unplanned switch; 3.10's timing; the banners; the keeper's decisions as pure functions
   tested by section 4's rows; the hidden name for a company with no link (plan 9's ruling 18 lifted); a planned switch
   whose peer link breaks after "go", the leader dying mid-update while copies hold the promise, and the planned
   switch's banners (plan 9c's ruling 12). Plan 11 keeps 3.6: the internet check, going on alone after 2 minutes, split
   terms other than the CEO's, "Go on here" with the saving of work folders, workers' choice between split leaders,
   meeting with or without an arbiter, the saved order, and `read` mode's read tools on `/mcp` and nodes connecting for
   status (spec 3.9), which only a machine cut off for long needs.
2. **Proofs, and when they are needed** (spec 3.4 "The lease", "One data machine"). A leading keeper needs a proof once
   another live data row holds a copy that finished at least once: its `copy_state` is `ready`, `remaking`, `stopped` or
   `saving`, or it is the old leader the newest handover names, which holds a database that led (`othersFinished`, read
   each `linkEveryMs`). Until then it renews as plan 9 does, each tick with no proof; so does a lease of kind `split`
   (ruling 7). With proofs, it renews `until = t + 10 s`, `t` being the send time of the newest proof sent after its
   last renewal: (a) `GET <link>/api/network/lease?nonce=<22 random base64url>` each second, answered with its own
   network id and that nonce, or (b) the answer to its heartbeat from B, the copy whose network id the relay's record
   names "on" at the keeper's current generation (`SyncController.record()`), saying "I follow" its term. No proof for
   10 s on either clock lets the lease lapse as plan 3's does. It ends at once (`ended`), whatever its time, when the
   link answers that nonce with another machine's id, or a heartbeat or its answer says "I lead" under a term above its
   own: that is the keeper seeing B's route (section 4, "Leader laptop sleeps"). A `stopped` copy counts as finished,
   which errs on the side of needing a proof (deviation in form: the spec says "once the first copy finished").
3. **Heartbeats** (spec 3.4). Every data keeper (leading, handing, taking, follow) sends `POST /peer/beat` each second
   to every other live data machine it has a peer session with, over `PeerLink.ask`, 900 ms to answer, one in flight per
   machine, and answers each it receives with its own; the keeper answers itself, with no database in the way. A beat is
   `{ machine, host, stance, number, reach, ready, full }`: the stance is "I lead (T, A), normal, sync on b, lease until
   u" (`lead`, with the lease's kind and the copy b the record names "on", or null), "I follow (T, A), not attempting"
   (`follow`), "I am attempting" (`attempting`, a keeper whose `taking.json` is `go`), `handing` (plan 9c's A from
   `stopped` on) or `idle` (a leading keeper without a lease, with its own term). `number` is its place in the order,
   `reach` how far its changes reach (a copy's `copyAt`, the leader's now), `ready` whether its copy finished and its
   database never led, `full` whether its last lease write failed for a full disk. Each keeper keeps, per machine, the
   newest beat it heard either way and when, by its monotonic clock. The leader's hello to workers (plan 5b) gains its
   `term`, `sync` (the named copy's machine) and `moving` (plan 9c's target while handing), and `PeerLink.leader()`
   takes, of the hellos that say `lead`, the one with the highest term.
4. **An old leader comes back in** (spec 3.4 "Re-entry", 3.6 "Meeting"). A leading keeper without a lease that needs
   proofs (ruling 2) acts on the pure `nextEntryStep`, each tick. Who made the route's last registration it reads from
   the route itself: plan 1's `client` names the maker of `generation`, held or empty, and its own link client is
   `linkClientId(<link name>, machine)`, so this is scoped to the link's name and survives a crash between registering
   and noting it.
   - It follows, exiting as a follow keeper with `peers.json` from `seedView` and plan 9's `replica.json` (as plan 9c's
     `follow` does, without a handover): when a beat says "I lead" under a term above its own, or when the route's last
     registration, held or empty, is another client's, since then someone registered after it.
   - With B answering its beats, it asks B for the next term (`POST /peer/promise { term: (M + 1, A) }`, M the highest
     number it knows, split when its own term is); on B's answer "I follow" that term it starts its link frpc, and takes
     its lease of that term, by the time it sent the ask, once its sync controller has a flag (a split term needs none);
     on "I am attempting" it waits; on "I lead" it follows.
   - With B silent for 3 s (or no record "on"), it goes by the relay's window, as a side that held the last normal term
     does when it meets the relay again (spec 3.6 "Meeting"): the route empty with its own client as the maker of its
     last registration, for 12 s, the relay's health answering every poll and 25 s since the relay came back, no poll
     late by 3 s. It then notes that generation g and starts its link frpc, and once the route names its own client at g
     + 1 it takes its lease by the time it sent that read (proof (a) by the route itself), with its sync controller's
     flag. Its own route at a later generation proves nothing, since another may have registered in between: it stops
     its link frpc and the window starts again. (Deviation, approved 2026-11-03: spec 3.4 lists two ways back in, the
     takeover and B's promise; without this third one, a leader whose keeper restarts while its only copy sleeps would
     never lead again, and 3.6 already lets the last normal leader take the name after the window.) A take by the
     relay's window or by a term of its own is (M + 1, A), split when its own term is (ruling 7); only ruling 7's rule
     for turning normal makes the successor of a split term unsplit. Plan 3's ruling 8 (a new term at every keeper
     start) holds only while no proof is needed, and so does plan 9's ruling 17 (the link frpc started again 30 s after
     lease end); with proofs the link frpc runs only while the keeper leads or this ruling lets it register. The sync
     controller samples from the keeper's start, not its first lead (plan 9), so a keeper that comes back in has its
     flag before its lease; it posts only while its own client holds the route, as plan 9's. Plan 9c's `reenter` and
     `abort` take their lease the same way, so an old leader whose B took over by this plan's rule follows instead of
     leading again; and while plan 9c's `Hander` holds, a beat saying "I lead" under a higher term, or a route last
     registered by another client, makes it follow at once, whatever B answers about that switch (ruling 12).
5. **The takeover by B** (spec 3.4 "Takeover by B", 3.7 "Promotion"). Every follow keeper whose copy finished watches
   (`Watcher`) the leader its copy was made on or last joined (`copy-state.json`'s `leader`, plan 9c), kept across lost
   sessions and restarts, each second: the route, the relay's health and its probe at the link, and the beats. Its
   window (`nextWindow`) opens at the first "empty" reply and starts over on any "held" reply, any generation change,
   any unknown answer, any failed health, any gap of 3 s or more between one poll's send and the next poll's reply, and
   any beat from the leader. `nextWatchStep` takes over when: (1) no beat from the leader either way for 20 s; (2) no
   probe answered by the leader for 20 s; (3) health answered every poll of the window and 25 s passed since this
   watcher first saw the relay's `relayStarted`; (4) the window open for 12 s; (5) its copy finished, the record says
   "on" naming it at the generation the route reports, and the leader's last beat saying "lead, normal, sync on <it>"
   came less than 100 s ago. With 1 to 4 and not 5 it asks the CEO (ruling 7). It never watches while the update promise
   (plan 9c's `promise.json`) or a planned switch's offer holds, nor while its copy is being made or led. To take over
   it writes plan 9c's `taking.json` of `kind` `takeover` in phase `go` (the highest term it knows, a new id, deadline
   30 s, and the generation g its window saw), disables its subscription, and exits; as a taking keeper plan 9c's
   `Promoter` registers the name, checks its nonce and promotes (plan 9c's ruling 5) with three differences: no slot for
   anyone, since every other data machine remakes after an unplanned switch (spec 3.7 "Rejoining"; deviation in form:
   3.7's promotion makes a slot for each other data machine, which a remake would not use); the handover recorded with
   its `kind`, when it last heard the leader (`heard_at`), how far its own changes reached (`reach`) and the live data
   rows of the last normal term but itself (`members`); and it takes its own registration only at g + 1, so any other
   registration since its window, held or already gone, aborts at once. An abort enables the subscription again and the
   watcher starts over.
6. **B's promise** (spec 3.4). A follow keeper answers "I follow (T, A)" with the term it follows, kept in
   `followed.json` in its keeper folder; once its watcher decided, or its `taking.json` is `go`, it answers "I am
   attempting", and once promoted "I lead (T', B)". It grants `POST /peer/promise { term }` (`promiseAnswer`) only while
   it is not attempting, when the asker is the term's machine, the term followed is the asker's, and the asked term is
   above it and split only when that one is: it writes the asked term into `followed.json` first and answers "I follow"
   it. A follow keeper with no `followed.json` grants nothing, so an old leader then goes by the relay (ruling 4). The
   watcher's decision and the promise's check run in one turn of the event loop, so the two never cross.
7. **The CEO's question and "Go on from"** (section 2 "A copy that may be missing changes", 3.6, 3.9 "Modes"). While a
   watcher's checks 1 to 4 hold and 5 does not, its keeper writes `question` into `keeper.json`: since when, the leader
   and when it was last heard, and each copy that is up (a beat within 5 s saying `ready`, and itself) in the order with
   how far its changes reach. It goes when the leader is heard, answers at the link, or the route is held; a window that
   starts over on a relay blip keeps it. Every copy's app serves it in `read` (`GET /api/recovery`), and the owner
   answers there: "Go on from <reach> on <host>" (`POST /api/recovery/go-on`) or "Wait for <leader>" (`POST
   /api/recovery/wait`); the app writes `recovery.json` into the control folder and the keeper acts, for itself or by
   `POST /peer/go-on` to the copy named. That copy takes over as in ruling 5 once its checks 1 to 4 hold, within 10
   minutes, with `kind` `ceo`: its term is split, as "Go on from" takes the same kind of term as "Go on here" (spec
   3.6), and is recorded "by the CEO" in its handover. A split lease is taken and renewed with no proof and no sync
   flag, as 3.6's is, and the app leads under it; meanwhile the sync controller holds sync off (plan 9c's `hold`), so no
   split write waits on a copy. It turns normal by 3.6's rule, here for the CEO's term only (deviation, approved
   2026-11-03: 3.6 is plan 11's, but "Go on from" is this plan's and would else stay split until plan 11): while the
   relay answers and its own client holds the route, once every machine of `members` answers its beats with "I follow"
   its term or has no live data row, it releases the hold and takes a normal term with its sync controller's flag; a
   keeper that finds a normal lease under such a handover with no `normal_at` notes it then. A new sign-in in `read`
   gets a cookie `hh_read`, `<person id>.<until>.<base64url HMAC-SHA256 keyed by the company secret>` over the person
   id, `until` and a digest of the person's current password hash, so a password change or reset ends it, good for 12
   hours and only while the app does not lead; its tries count against plan 1b's limits in memory (`limiter`), since the
   database takes no writes; no session row is written. Plan 2's gate lets the sign-in and the two answers through in
   `read`. Only the owner, on his own session or that cookie, may answer.
8. **The old leader's return** (section 5 steps 1 and 2, 3.7 "No database is thrown away", plan 9's ruling 12). A follow
   keeper whose database led (`net_local.state` has a row and no `handed_to`, plan 9c) no longer stops: its copy maker
   first saves it. Its updater dumps `hornhoof` (`dump.json` with `database` `hornhoof` and `reason` `fork`, taken only
   while `replica.json` is there); its keeper seals it with plan 7's `sealBundle` to the recipients and recovery key the
   leader's `MakerView` names (the backups route answers a data keeper's view as its own), signs it with its own key and
   data certificate, and puts it to the leading keeper (`PUT /peer/led/<id>`), which checks the head against the peer's
   machine, stores it and records it; the backups route takes a fork head signed by another live data row through its
   own keeper's word. Then plan 9's remake runs as for any copy (ruling 14 there), with the led database as the old one,
   merged as `machine:<machine id>:led-<its own term number>` (reported as `old.led`, kept in `machines.copy_old_led`)
   and compared whole, since it wrote (plan 9's ruling 15 does not apply); the swap drops it only once that merge is
   `merged` or `done` and the bundle's row is in `net.backups`. The card says each step: "Copy: saving what it did while
   it led", then plan 9's "being made again, <p>%". Once its copy is `ready` after the newest handover, which named it
   the old leader, its card says "<host> ran the server until <time> and is up to date again." beside "Move the server
   here" (section 2), after a planned switch as after a takeover (the overview's plan 10 entry, from plan 9c). Plan 9b's
   ranking makes the new leader 1 at its first lead and ranks the old one as any machine; nothing moves the server back.
9. **Jobs across an unplanned switch** (spec 3.9 "Jobs", section 5 step 5). A merge is pending while a handover of kind
   `takeover` or `ceo` names an old leader whose row is live and of which no led merge made after that handover is
   `merged` or `done`. Meanwhile the new leader: does not cancel at hello a job a node lists that it has no row of, and
   notes it in `net.parked` (kind `listed`); turns a listed job whose row is `queued` (the old leader started it after
   this copy's reach) `running` on that node, so it is never sent out again; parks each `job.started`, `job.event` and
   `job.done` of a job it has no row of, each acknowledged as handled; and answers a tool call whose token matches no
   job, or a `queued` one, with 503 `merge_pending` and `Retry-After: 60`, which plan 4's `front` retries as it retries
   its other passing refusals. (Deviation, approved 2026-11-03: the spec has the new leader accept the old leader's
   tokens once it reads that machine in section 5 step 3; this plan reads and applies in one go, so the tokens arrive
   with the merge, and until the old leader is back and merged such a tool call waits, then after `front`'s budget tells
   the agent to try again in a few minutes or end its turn with what it did, which is kept: that turn's `job.done` is
   parked as any other.) The merge brings the `net.parked` rows the leader lacks, as plan 8 brings `net.backups`, and
   writes a parked job of the old leader `running` on the node of its parked rows, not closed as plan 8's ruling 7 does;
   then, and every minute while leading, the parked messages of each job whose row exists apply in order, each in one
   transaction with its `applied_at`, as if they arrived now. Test parts and computer runs of the old leader close as
   plan 8's ruling 7 says (deviation in form: only a job carries an agent's turn; a test run shows failed and is run
   again).
10. **A company with no link gets a hidden name** (spec 3.4 "Without a public link", plan 9's ruling 18). When a machine
    would qualify for a copy but for the link, the ranking first makes a hidden link: `PublicLinks.set` with no name
    (the relay picks one) and `hidden` true, with its certificate as any link. `linkOf` answers null for it, so Settings
    shows no link; the keeper's link doors answer only `GET /api/network/lease` on it and 404 for anything else; plan
    9's carry keeps `hidden`. Turning a public link on replaces it (the sync controller follows the name, plan 9's
    ruling 18); removing the public link while another data machine is listed hides it under a new random name instead
    of plan 9's 409 `link_needed`, and `no_link` remains only while hornhoof.org does not answer to make the hidden
    name.
11. **The page during a switch** (section 2 "During a switch"). Every keeper answers `GET /api/network/switch` on its
    front door and on a public link's door itself, never held, naming machines by id only, since the link door answers
    anyone: `{ moving, from, to, since, cut, question }`. `moving` while a planned switch hands over or takes over, and
    on a worker or copy while no leader answered for under 2 minutes (`to` the copy the last hello named sync, else
    null); `cut` on a copy whose leader does not answer its beats for 20 s while the leader still answers at the link
    (section 4, "Peer link down": "Mac cannot reach Debian; copy stopped."); `question` while ruling 7's question
    stands. The page polls it every 5 s, every second while moving, and shows "Moving the company to Mac. Your work is
    kept. About a minute." (with no `to`: "Lost Debian. Hornhoof is finding where to go on; your work is kept."). For 24
    hours after a handover the app's `GET /api/network/switched` gives the line after it: "Hornhoof runs on Mac now.
    Debian stopped answering at 14:02." (a takeover), "Hornhoof runs on Mac now, from what it had at 23:40, as you
    chose." (the CEO's), "Hornhoof runs on Mac now." (planned), each closed by the reader. At its first lead after a
    takeover or the CEO's choice, the app has the orchestrator write the same in his window (`enqueueTurn` with
    `answersCeo`), and what waits for the old leader's return: its jobs that still run and, after the CEO's choice, what
    it did after the time he chose. A takeover from a leader whose last beat said its disk is full says "Debian's disk
    is full; Mac leads." (section 4). The texts beyond the spec's were approved on 2026-11-03; in Russian a hostname as
    the subject takes «Машина» before it, so the feminine verbs agree. The disk warning at 85% of spec section 4 goes to
    plan 11, which carries each data machine's disk figure.
12. **What plan 9c left here** (its ruling 12). A planned switch whose peer link breaks after "go": A stays fenced and
    asks B's state; if B registered and promoted under that switch, A follows once it hears B; if B never took `go` and
    its watcher took over under another id, A follows on B's beat or route (ruling 4), whatever B says of the switch; if
    B aborted and forgot, its `none` makes A come back in by ruling 4, which follows B wherever B or another machine
    registered since; meanwhile B's watcher runs as a copy's, so if B gave up, it takes over or asks the CEO. The leader
    dying mid-update: copies keep the promise until it ends (ruling 5 does not watch while it holds), then the usual
    rule; with migrations the record was "off", so they ask the CEO (section 4). Ruling 11's banners cover the planned
    switch.
13. **Timing** (spec 3.10). Leader switched off at 0: its route goes within plan 1's `evictionBound` (30 s), B's window
    then needs 12 s, registration and promotion about 10 s, nodes back within 10 s; the lab measures it and accepts up
    to 75 s. A relay that frees a name at once gives about 20 s plus promotion (check 1 then bounds it).

## Review Focus

1. Two leaders confirming at once: an old leader renewing after B registered, coming back in by the relay while B
   attempts, waking from sleep with a lagging clock, or a copy that is not B taking over without the CEO. Tests in Task
   3 (every row of `nextWatchStep`, `nextEntryStep`, `nextLeaseStep` and section 4's rows), Task 4 (`ends the lease at
   once when another machine answers at the link`, `never comes back in after someone else registered`) and Task 11
   (`lateConfirms`, and the cut leader's own write not confirmed).
2. No leader for good: a leader whose keeper restarts while its only copy sleeps, a copy that never asks the CEO, a
   promise B never answers, a CEO's answer that reaches a copy whose checks do not hold yet. Tests in Task 3, Task 4
   (`comes back in through the relay when B does not answer`) and Task 6 (`takes over as the CEO said`).
3. A confirmed write lost: a copy taking over on a record of an older generation or an old heartbeat, a led database
   dropped before its merge and bundle, a job's end parked and never applied. Tests in Task 3 (check 5's rows), Task 7
   (`swaps a led database only once its bundle is recorded`) and Task 8 (`applies what it parked once the job is there`,
   `applies each message once across a crash`, `carries parked rows across two takeovers`).
4. The question shown wrongly: listing a copy still being made, flapping on relay blips, staying after the leader came
   back, or answered by someone not the owner. Tests in Task 3 and Task 6.
5. A company with no public link: copies refused, the hidden name shown in Settings, or the sync record lost when the
   public link is turned on or off. Tests in Task 9 (`turns a public link on over a hidden one`, `carries a hidden link
   as hidden`).

---

### Task 1: The tables of takeovers, parked results and the hidden name

**Repo:** the `network` worktree, branch `network`. **Starts from:** plan 9c's last task committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/takeover-tables.test.ts test/migrations.test.ts
test/lease-store.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing.

**Files:**
- Create: `apps/server/drizzle/0058_takeover.sql` (with its `meta/` snapshot and journal entry, as drizzle-kit writes
  them)
- Modify: `apps/server/src/db/schema.ts` (`public_links.hidden`, `machines.copy_old_led`, `machines.copy_state`'s
  values)
- Test: `apps/server/test/takeover-tables.test.ts` (new), `apps/server/test/migrations.test.ts`

**Interfaces:**
- Produces, in the migration (the hand-written part after the generated one):
  
  - `net.handovers` gains (`ALTER TABLE ... ADD COLUMN`) `kind text NOT NULL DEFAULT 'planned' CHECK (kind IN
    ('planned', 'takeover', 'ceo'))`, `heard_at timestamptz` (when the new leader last heard the old one), `reach
    timestamptz` (how far the new leader's changes reached when it took over), `members text[] NOT NULL DEFAULT '{}'`
    (the network ids of the live data rows of the last normal term but the new leader's), `normal_at timestamptz` (when
    a term by the CEO turned normal), `noted_at timestamptz` (when the orchestrator was told) and `reason text CHECK
    (reason IN ('disk_full'))` (why the old leader stopped, when it said).
  - `net.parked (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL, node jsonb NOT NULL, kind text NOT
    NULL CHECK (kind IN ('listed', 'started', 'event', 'done')), body jsonb NOT NULL, at timestamptz NOT NULL DEFAULT
    clock_timestamp(), applied_at timestamptz)`, `CREATE INDEX parked_job ON net.parked (job_id)`, and the fence trigger
    `net_fence` as plan 3 puts on every `net` table; the publication `FOR TABLES IN SCHEMA public, net` takes it as it
    is.
  - `public_links` gains `hidden boolean NOT NULL DEFAULT false`, and `machines` gains `copy_old_led bigint` (the led
    term of the old database whose merge waits, beside plan 9's `copy_old`), both from `schema.ts`.
  - `machines.copy_state`'s check takes `saving` beside plan 9's values (from `schema.ts`'s enum, the check dropped and
    made again by name).
- Drizzle: `publicLinks.hidden`, `machines.copyOldLed`, and `machines.copyState`'s enum gains `'saving'`. The `net`
  tables keep plan 3's and plan 9c's way: no Drizzle model, plain SQL in the hand-written part, read and written by
  `sql` queries.

- [ ] **Step 1: Write failing tests** in `takeover-tables.test.ts`, on `createTestSql()`:
  - `records the kind of each handover`: a row with no `kind` reads `planned` and `members` `{}`; `takeover` and `ceo`
    are taken; `other` fails with the check's name.
  - `parks a job's messages`: a row of kind `event` with a node identity and a body reads back with `applied_at` null;
    kinds `listed`, `started` and `done` are taken, `other` fails; `problems()` of plan 3's lease store has no line
    naming `net.parked`.
  - `keeps the led term of an old database`: `machines.copy_old_led` is null on a new row and takes 7.
  - `hides a link`: a `public_links` row inserted without `hidden` reads false.
  - `knows a copy that saves what it led`: `copy_state` `saving` is taken, `other` fails. And `migrations.test.ts`'s
    count of migrations grows by one.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no such column).
- [ ] **Step 3: Implement** `schema.ts`, then `npx drizzle-kit generate --name takeover` and the hand-written part.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the tables of takeovers, parked job results and the hidden link".

### Task 2: Heartbeats between data machines

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/beats.test.ts test/peer-link.test.ts
test/peer-server.test.ts test/keeper.test.ts test/follow-keeper.test.ts test/taking.test.ts` passes, then the whole
server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/beats.ts`
- Modify: `apps/server/src/net/peer-server.ts` (`PEER_PATHS.beat`, the routing of keeper paths),
  `apps/server/src/net/peer-link.ts` (`Hello`, `leader()`), `apps/server/src/modules/keeper/keeper.ts` (the leading,
  handing and taking keepers' beats and hello), `apps/server/src/modules/keeper/follow.ts` (the follow keeper's beats)
- Test: `apps/server/test/beats.test.ts` (new), `apps/server/test/peer-link.test.ts`,
  `apps/server/test/peer-server.test.ts`, `apps/server/test/keeper.test.ts`, `apps/server/test/follow-keeper.test.ts`,
  `apps/server/test/taking.test.ts`

**Interfaces:**
- Consumes: `PeerLink.ask` (plan 9c), `PeerServer`, `Peer` (plan 5), `Term`, `LeaseKind`, `Clocks` (plan 3);
  `SyncController.record()`, `generation()` (plan 9c); `Hander.holds()` (plan 9c); `Promoter.leads()` (plan 9c);
  `CopyMaker.report()` (plan 9).
- Produces:
  ```ts
  // modules/keeper/beats.ts
  export const BEAT_MS = 1_000;
  export const BEAT_WAIT_MS = 900;
  export type Stance =
    | { kind: 'lead'; term: Term; lease: LeaseKind; sync: string | null; until: number }
    | { kind: 'follow'; term: Term | null }
    | { kind: 'attempting' }
    | { kind: 'handing'; to: string }
    | { kind: 'idle'; term: Term | null };
  //   lead: sync is the network id the relay's record names "on" at the keeper's current generation, else null; until
  //   the lease's end, wall ms. follow: the term followed, "not attempting". handing: plan 9c's target's network id.
  //   idle: a leading keeper without a lease, with its own state's term
  export type Beat = { machine: string; host: string; stance: Stance; number: number | null; reach: string | null;
    ready: boolean; full: boolean };
  //   machine: the sender's network id; reach: ISO time; ready: its copy finished and its database never led (the
  //   leader: true); full: its last lease write failed for a full disk (SQLSTATE 53100)
  export type Heard = { beat: Beat; at: number; sent: Clocks | null };
  //   at: this keeper's monotonic ms when it came; sent: for an answer, when the beat it answers was sent
  export function parseBeat(body: unknown): Beat | null;
  export class Beats {
    constructor(opts: { self: () => Beat; peers: () => { machine: string; networkId: string }[];
      ask: (networkId: string, method: 'POST', path: string, body: unknown, timeoutMs: number) =>
        Promise<{ status: number; body: unknown } | null>;
      now?: () => Clocks; everyMs?: number; log: (line: string) => void });
    start(): void;
    stop(): void;
    tick(): Promise<void>;        // one round: a beat to each peer that has none in flight
    handle(peer: Peer, body: unknown): { status: number; body: unknown };   // POST /peer/beat
    last(networkId: string): Heard | null;     // the newest beat from it, either way
    answer(networkId: string): Heard | null;   // the newest answer to one of this keeper's beats, with its sent
    all(): ReadonlyMap<string, Heard>;
  }
  // net/peer-server.ts: PEER_PATHS gains beat: '/peer/beat'; PeerServerOptions gains keeperPaths?: (peer: Peer,
  //   method: string, path: string, body: unknown) => Promise<{ status: number; body: unknown } | null>, asked for
  //   every path under /peer/ that no option of plans 5 to 9c answers, null meaning 404
  // net/peer-link.ts: Hello gains term: Term | null; sync: string | null; moving: string | null (machine uuids)
  ```
- `handle`: only from a peer whose certificate's role is `data` and whose machine is the `machine` of the `peers()` row
  whose `networkId` is the beat's `machine` (403 `{ ok: false }` otherwise); a body `parseBeat` refuses is 400; else the
  beat is kept as that machine's `last` and the answer is `self()`. `tick`: for each of `peers()` with no beat in
  flight, `ask(networkId, 'POST', '/peer/beat', self(), BEAT_WAIT_MS)`, its send time taken right before; a 200 whose
  body parses is kept as `last` and `answer` with that send time; anything else changes nothing.
- The leading keeper's peers are the other live rows of the role `data` in its database with a network id, read each
  `linkEveryMs`, and its `dial` `PeerLink` keeps sessions to each of them (plan 9's dialer, its targets from the same
  read). Its beat: `lead` while it holds a lease (`term()`, the lease's kind, `sync` as above, `until`), `handing` while
  plan 9c's `Hander.holds()`, else `idle`; `number` its row's `server_order`, `reach` now, `ready` true, `full` as Task
  4 sets it (false until then). A taking keeper's: `attempting` until `Promoter.leads()`, then as a leading keeper's.
  The follow keeper's peers are its view's data machines; its beat: `follow` with a null term (Task 5 gives the term and
  `attempting`), `number` its own row's in the view, `reach` its `CopyReport.at`, `ready` its report's state `ready`,
  `full` false. Each keeper runs `Beats` from its start to its stop, also while it holds no lease.
- The leading keeper's hello: `term` `term()`, `sync` the machine of the network id its beat names, `moving` plan 9c's
  `handing.to.machine` while it hands over. `PeerLink.leader()`: of the targets whose hello says `lead`, the one with
  the highest `term` by (number, machine); a hello with no `term` counts below every term.

- [ ] **Step 1: Write failing tests.**
  - `beats.test.ts`, two `Beats` whose `ask` calls the other's `handle` with a fake `Peer` of the right row, and fake
    clocks:
    - `hears each other each second`: after one `tick` of each, each `last` holds the other's beat and `answer` the
      other's answer with the send time; after `stop`, no `ask` is made.
    - `keeps one beat in flight to a machine`: an `ask` that resolves after 3 s: two more `tick`s make no second call.
    - `keeps nothing it cannot trust`: a body with `stance.kind` `other` is 400 and leaves `last` as it was; a beat
      whose `machine` is not the peer's row is 403; an `ask` that answers null or 404 changes nothing.
  - `peer-link.test.ts`, `takes the leader with the highest term`: two data servers whose hellos say `lead` with terms
    (3, a…) and (4, b…): `leader()` names the second; with the second's hello lacking `term`, the first.
  - `peer-server.test.ts`, `asks the keeper for its own paths`: a `POST /peer/beat` reaches `keeperPaths` with the peer
    and the body, and its answer comes back; `null` gives 404; plan 7's and plan 9's paths do not reach it.
  - `keeper.test.ts`, `beats as the leader`: a leading keeper with a fake lease and one other data row: within 2 s its
    `dial` was asked `POST /peer/beat` with stance `lead`, its term, `sync` null; after a fence, `idle`; its hello has
    `term`.
  - `follow-keeper.test.ts`, `beats as a copy`: its beat says `follow`, `ready` false while its copy is being made and
    true once `ready`, and it answers a beat from the leader's row with its own.
  - `taking.test.ts`, `beats as one attempting`: a taking keeper says `attempting` until `leads()`, then `lead`.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no `beats.ts`).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let the data machines tell each other each second where they stand".

### Task 3: The keepers' decisions, as pure functions

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/takeover-step.test.ts test/takeover-rows.test.ts
test/lease.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/takeover-step.ts`
- Modify: `apps/server/src/modules/keeper/lease.ts` (`nextLeaseStep`)
- Test: `apps/server/test/takeover-step.test.ts` (new), `apps/server/test/takeover-rows.test.ts` (new),
  `apps/server/test/lease.test.ts`

**Interfaces:**
- Consumes: `Stance`, `Beat` (Task 2); `Route`, `SyncRecord` (plan 1); `Term`, `Clocks`, `LeaseKind`, `LEASE_MS`,
  `LATE_MS`, `BACK_MS`, `Held`, `leaseValid` (plan 3).
- Produces:
  ```ts
  // modules/keeper/takeover-step.ts
  export const SILENT_MS = 20_000;        // checks 1 and 2
  export const EMPTY_MS = 12_000;         // check 4
  export const RELAY_BACK_MS = 25_000;    // check 3
  export const GAP_MS = 3_000;            // a poll's send to the next poll's reply
  export const SYNC_BEAT_MS = 100_000;    // check 5: the leader's last "normal, sync on" beat
  export const UNREACHED_MS = 3_000;      // B silent this long: the old leader goes by the relay
  export const ASK_AGAIN_MS = 2_000;
  export const TAKE_MS = 30_000;          // a takeover's deadline for the name and the nonce
  export const CEO_KEEP_MS = 600_000;     // the CEO's "Go on from" holds this long
  export type Poll = { sent: Clocks; replied: number; route: Route;
    health: { up: boolean; relayStarted: number | null } } | null;
  //   null: no poll could be sent or answered this tick; replied: monotonic ms once both answers came
  export type Window = { since: number | null; generation: number | null; lastSent: number | null;
    relayStarted: number | null; relaySeen: number | null };
  export const NO_WINDOW: Window;
  export function nextWindow(w: Window, p: Poll, heardLeader: boolean): Window;
  export function windowOpenMs(w: Window, now: number): number;   // 0 while since is null
  export function relayBackMs(w: Window, now: number): number;    // 0 while relaySeen is null
  export type WatchSample = { now: number; started: number; window: Window; held: boolean; leader: string | null;
    heard: number | null; linkAnswered: number | null; syncBeat: number | null; record: SyncRecord | null;
    routeGeneration: number | null; self: string; ready: boolean; holds: boolean; ceo: number | null };
  //   monotonic ms throughout; held: the last known route answer says held; heard: the newest beat from the leader
  //   either way; linkAnswered: the newest probe at the link answered by the leader's machine; syncBeat: the newest
  //   beat from the leader saying lead, normal, sync = self; holds: the update promise or a planned switch's offer
  export type WatchAction = { do: 'none' } | { do: 'take'; kind: 'takeover' | 'ceo' } | { do: 'ask' } | { do: 'unask' };
  export function nextWatchStep(s: WatchSample, asked: boolean): { action: WatchAction; why: string };
  export type EntrySample = { now: Clocks; needed: boolean; self: string; ownTerm: Term | null; latest: Term | null;
    b: { networkId: string; answered: number | null; answer: { stance: Stance; sent: Clocks } | null } | null;
    asked: number | null; window: Window; route: { state: 'held' | 'empty'; client: string | null;
    generation: number; sent: Clocks } | null; registering: number | null; client: string; tunnel: boolean;
    flag: boolean };
  //   latest: the highest term in any beat heard (lead, follow and idle) and its own; b: the copy the record names
  //   "on" at the keeper's generation, when it last answered (monotonic) and its newest answer; asked: when it last
  //   asked B's promise (monotonic); route: the last known answer, its client the maker of its generation, held or
  //   empty; registering: the generation it saw when it started its own registration (an entry's register, or
  //   Task 5's Taking.generation), else null; tunnel: its link frpc runs; flag: its sync controller's flag is not
  //   null
  export type EntryAction = { do: 'wait'; why: string } | { do: 'take'; sent: Clocks; term: Term }
    | { do: 'ask'; term: Term } | { do: 'register'; generation: number | null } | { do: 'stop' } | { do: 'follow' };
  export function nextEntryStep(s: EntrySample): EntryAction;
  export function promiseAnswer(o: { asker: string; term: unknown; followed: Term | null; attempting: boolean }):
    { grant: Term } | { grant: null };
  export function mayTurnNormal(o: { split: boolean; kind: 'planned' | 'takeover' | 'ceo' | null; relayUp: boolean;
    holdsRoute: boolean; members: string[]; following: (networkId: string) => boolean;
    live: (networkId: string) => boolean }): boolean;
  // lease.ts
  export type LeaseStep = { do: 'take'; kind: LeaseKind; sent: Clocks; term: Term | null }
    | { do: 'fence'; why: string } | { do: 'renew'; kind: LeaseKind; endSessions: boolean; sent: Clocks }
    | { do: 'none' };
  export function nextLeaseStep(o: { now: Clocks; last: Clocks | null; held: Held | null; maintenance: boolean;
    split?: boolean; proof?: Clocks | null; ended?: string | null;
    entry?: { sent: Clocks; term: Term | null } | null }):
    LeaseStep;
  //   left out, proof is now, ended null and entry { sent: now, term: null }, which is plan 3's table
  ```
- `nextWindow`, in order: `relaySeen` becomes `p.replied` when `p.health.relayStarted` is a number other than
  `w.relayStarted` (first sight counts as the relay just back); then the window starts over (`since` null) when `p` is
  null, `p.health.up` is false, `p.route.known` is false, the route says `held`, its generation differs from a non-null
  `w.generation`, `p.replied - w.lastSent` is `GAP_MS` or more, or `heardLeader`; else `since` is `w.since ??
  p.replied`. `generation` takes a known route's, `lastSent` `p.sent.mono`.
- `nextWatchStep`, the first row that matches; "quiet" is `none`, or `unask` when `asked`; `heard` and `linkAnswered`
  count as no older than `started`:

  | When | Action | why |
  |---|---|---|
  | not `ready`, or `holds`, or `leader` null | quiet | `not watching` |
  | `held` | quiet | `the name is held` |
  | `now - heard` under `SILENT_MS` | quiet | `heard the leader` |
  | `now - linkAnswered` under `SILENT_MS` | quiet | `the leader answers at the link` |
  | `windowOpenMs` under `EMPTY_MS`, or `relayBackMs` under `RELAY_BACK_MS` | none | `window` |
  | `record` on naming `self` at `routeGeneration`, `syncBeat` within `SYNC_BEAT_MS` | take `takeover` | `checks 1-5` |
  | `ceo` within `CEO_KEEP_MS` | take `ceo` | `the CEO said go on` |
  | otherwise | `ask`, or none when `asked` | `may lack changes` |

- `nextEntryStep`, the first row that matches; "B's answer" is `b.answer`, fresh while `now` is under `LEASE_MS` past
  its `sent` on both clocks; M is the highest number of `ownTerm` and `latest`; "the next term" is (M + 1, `self`),
  split as `ownTerm`; "B's grant" is B's answer fresh and `follow` with a term of `self` above `ownTerm` and split as
  `ownTerm`; "split" is `ownTerm` split:

  | When | Action |
  |---|---|
  | not `needed` | take, `sent` now, the next term |
  | `latest` above `ownTerm` and of another machine | follow |
  | `route` known, its `client` set and not `client` | follow |
  | B's answer says `lead` | follow |
  | B's grant, and `flag` or split | take, `sent` its `sent`, that term |
  | B's grant, not `tunnel` | register at `route.generation` |
  | B's grant | wait `the sync controller` |
  | B's answer fresh and `attempting` | wait `B is attempting` |
  | `route` held by `client` at `registering + 1`, `tunnel`, `flag` or split | take the next term, `sent` `route.sent` |
  | `route` held by `client` at `registering + 1`, `tunnel` | wait `the sync controller` |
  | `route` held by `client` above `registering + 1` (or `registering` null), `tunnel` | stop |
  | `tunnel` | wait `registering` |
  | `b.answered` within `UNREACHED_MS`, `asked` null or `ASK_AGAIN_MS` ago | ask the next term |
  | `b.answered` within `UNREACHED_MS` | wait `asked B` |
  | `route` `empty`, made by `client`, window open `EMPTY_MS`, relay back `RELAY_BACK_MS` | register at its generation |
  | otherwise | wait `the relay's window` |

  Only Task 6's turning normal makes the successor of a split term unsplit. A route of its own at another generation
  proves nothing: someone may have registered between, so it stops and the window starts again.

- `promiseAnswer`: a grant of the asked term only when `term` parses as a `Term`, its machine is `asker`, `followed` is
  set with machine `asker`, the term is above `followed` and split exactly when `followed` is, and not `attempting`.
- `mayTurnNormal`: `split`, `kind` `ceo`, `relayUp`, `holdsRoute`, and each of `members` `following` or not `live`.
- `nextLeaseStep`, the first row that matches: `held` and `ended`: fence with `ended`; `held` null and `entry` null:
  none; `held` null: take (kind `maintenance` when `maintenance`, else `split` when `split`, else `normal`) with the
  entry's `sent` and `term`; a late tick: fence (plan 3's); `!leaseValid`: fence `no renewal for 10 s`; `proof` null or
  not after `held.sent` on the monotonic clock: none; else renew with `sent` `proof`, the kind as for take and
  `endSessions` as plan 3's.

- [ ] **Step 1: Write failing tests.**
  - `takeover-step.test.ts`:
    - `opens and restarts the window`, one table of `nextWindow` from `NO_WINDOW`: an empty known reply opens it at
      `replied`; the next empty reply 1 s later keeps `since`; then each of a held reply, `known: false`, health down,
      another generation, `replied` 3 s after the last `sent`, `heardLeader` true, and a null poll gives `since` null; a
      new `relayStarted` sets `relaySeen`; the first `relayStarted` seen sets it too.
    - `watches by the five checks`: every row of the table above, each with a sample where only that row's condition
      decides, and its `why`.
    - `comes back in by the rules`: every row of the entry table, likewise; the asked and taken terms are (M + 1, self),
      split when `ownTerm` is; `never unsplits a term by the CEO on the way back in`: with `ownTerm` split, every take
      and ask in the table carries a split term.
    - `promises only the machine that led`: a grant for (8, A) from A following (7, A); none from B for (8, A), none for
      (7, A), none for (8, A, split) while (7, A) is unsplit, a grant of (8, A, split) when (7, A, split) is followed,
      none while attempting, none with `followed` null.
    - `turns a term by the CEO normal once everyone follows`: true with two members following; false with one member
      silent and live; true when that member is not live; false while `relayUp` or `holdsRoute` is false, for a
      `takeover` kind, or for a lease not split.
  - `lease.test.ts`, plan 3's table unchanged with the new inputs left out, and `renews only on a proof sent after the
    last renewal`: `proof` 0.5 s after `held.sent`: renew with that `sent`; `proof` equal to `held.sent`: none; 10 s
    after `held.sent` with no newer proof: fence `no renewal for 10 s`; `ended` set: fence with it; `held` null and
    `entry` null: none; `entry` with term (8, A): take with that term; `split`: take and renew `split`.
  - `takeover-rows.test.ts`, section 4's rows, each a script replayed second by second through `nextWindow` and
    `nextWatchStep` from the copy's side (the route, the relay's health and `relayStarted`, the leader's beats and link
    answers, the record), with the second of the first `take` or `ask`; the watcher started at -300, saw the relay's
    `relayStarted` then and heard the leader each second; the leader's record names B "on" at generation 7 and its beats
    said "normal, sync on B" until it went quiet, unless a row says otherwise:

    | Row | Script | Expected |
    |---|---|---|
    | Leader switched off | beats and link answers stop at 0; route held until 25, then empty at 7 | take at 37 |
    | A relay that frees names at once | as above, empty from 1 | take at 20 |
    | A relay that frees them after 30 s | empty from 30 | take at 42 |
    | Leader loses internet, copy elsewhere | beats and link stop at 0; empty from 25 | take at 37 |
    | Leader loses internet, copy in the same home | beats go on; every route answer unknown | none in 300 s |
    | Leader's Docker quits for 8 s | beats and link stop 0 to 8, empty at 7 then, held from 8 | none in 300 s |
    | Keeper crash-loops | beats stop 5 s in every 15, empty then, held at a new generation after | none in 300 s |
    | Leader laptop sleeps | as switched off | take at 37 |
    | Relay restarts | unknown, down 0 to 5; new `relayStarted` at 5, held at 8 from 5; beats go on | none in 300 s |
    | Relay restarts as the leader dies | beats stop at 0; down 0 to 5, new `relayStarted` at 5, empty 7 | take at 30 |
    | Relay down 60 s, the leader dies in it | beats stop at 0, health down 0 to 60, empty at 7 from 60 | take at 85 |
    | Relay down 75 s, the leader dies in it | as above to 75 | ask at 100 |
    | Relay down 90 s, the leader dies in it | as above to 90 | ask at 115 |
    | Leader and sync copy stop together, seen from a third | the record names B; empty from 25 | ask at 37 |
    | Their home loses the internet, seen from a third elsewhere | as the row above | ask at 37 |
    | An "on" record of an older generation | record at 6, route at 7 | ask at 37 |
    | The leader's last "sync on" beat is old | its beats said sync null from -200 | ask at 37 |
    | A generation change in the window | empty at 7 from 25 to 30, then at 8, the record on B at 8 | take at 43 |
    | A late poll | the reply of 30 comes 3.5 s after the send of 29 | take at 42 or later, never before |
    | Update promise holds until 600, migrations | `holds` to 600, the record "off" | ask at 600 |
    | A planned switch's offer holds | `holds` throughout | none in 300 s |
    | A copy still being made | not `ready` | none in 300 s |
    | The CEO says go on at 40, the record names another | | ask at 37, take `ceo` at 40 |

    And the leader's side, through `nextLeaseStep` and `nextEntryStep`: `the leader keeps its lease by its copy in the
    same home` (no probe answers, B's answers each second: renewals go on); `the leader fences within 10 s of losing the
    internet` (no probe answers, B silent: fence at 10); `a laptop that wakes with a lagging clock fences at once` (a
    probe answered by B's machine: fence with its `ended` at the next tick); `a keeper that restarts comes back by B`
    (no lease, B answers `follow` (T + 1, A), the flag set: take at the next tick); `a keeper that restarts while B
    sleeps comes back by the relay` (B silent, the route empty with its own client as maker at 7: register at 7 once the
    window is 12 s open and 25 s passed since the relay was first seen, then take once its own client holds the route at
    8 and the flag is set; held by it at 9 instead: stop); `a keeper that re-registered after an frps restart and
    crashed still comes back` (the route empty at 8, made by its own client: the window, not a follow); `a takeover
    between the windows makes it follow` (the route empty at 8 made by B's client: follow); and `takes B's promise only
    with a flag` (B answers `follow` (T + 1, A), the flag null and the tunnel stopped: register; tunnel running: wait;
    the flag set: take with that term and the ask's send time).
- [ ] **Step 2: Run** Done when. Expected: FAIL (no `takeover-step.ts`).
- [ ] **Step 3: Implement** the functions above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Decide the lease, the takeover and the way back in from what the keepers see".

### Task 4: The leader renews by proof, and comes back in

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 3 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/proofs.test.ts test/keeper.test.ts
test/lease-store.test.ts test/handing.test.ts test/sync.test.ts` passes, then the whole server suite; from the worktree
root `npm run test:real` passes; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/proofs.ts`
- Modify: `apps/server/src/modules/keeper/keeper.ts` (the lease loop, the entry, the link frpc),
  `apps/server/src/modules/keeper/lease-store.ts` (`take`'s term), `apps/server/src/modules/keeper/sync.ts` (the link
  frpc's start 30 s after lease end goes), `apps/server/src/modules/keeper/handing.ts` (`reenter`, `abort`, following a
  takeover), `apps/server/test/fake-lease.ts`
- Test: `apps/server/test/proofs.test.ts` (new), `apps/server/test/keeper.test.ts`,
  `apps/server/test/lease-store.test.ts`, `apps/server/test/handing.test.ts`, `apps/server/test/sync.test.ts`,
  `apps/server/test/real/lease-store.test.ts`

**Interfaces:**
- Consumes: `nextLeaseStep`, `nextEntryStep`, `nextWindow`, `NO_WINDOW`, `UNREACHED_MS` (Task 3); `Beats` (Task 2); plan
  9c's `probe(nonce)`, `seedView`, `PEERS_FILE`, `REPLICA_FILE`, the keeper's exit, `SyncController.record()` and
  `generation()`; plan 1's `route` and `health`.
- Produces:
  ```ts
  // modules/keeper/proofs.ts
  export const PROMISE_PATH = '/peer/promise';
  export function othersFinished(sql: Sql, networkId: string): Promise<boolean>;
  //   a live row of the role data with another network id whose copy_state is ready, remaking, stopped or saving,
  //   or that the newest net.handovers row names as from
  export class LeaseProofs {
    constructor(opts: { probe: (nonce: string) => Promise<{ machine: string; nonce: string } | null>; beats: Beats;
      self: string; term: () => Term | null; b: () => string | null; now?: () => Clocks; everyMs?: number });
    //   b: the network id the record names "on" at the keeper's current generation, else null
    start(): void;
    stop(): void;
    tick(): Promise<void>;      // one probe, with 22 random base64url characters as nonce, 2 s to answer
    proof(): Clocks | null;     // the newest send time of a probe answered by self with its nonce, or of a beat
                                //   whose answer from b() said follow with term()
    ended(): string | null;     // why the lease must end now, else null
    clear(): void;              // forgets ended and the proofs; the keeper calls it at each take
  }
  // lease-store.ts: take(kind, until, sync, term?: Term): with term, the state and the lease take exactly it, and it
  //   throws when it is not above the state's; sync null for a split lease
  ```
- `ended()` says `another machine answers at the link` once a probe comes back with this nonce and another machine, and
  `<host> leads under term <n>` once any beat (from or to any peer) says `lead` with a term above `term()`.
- The leading keeper, each tick, besides plan 3's and plan 9's work:
  - `needed` is the last `othersFinished` (read each `linkEveryMs`; before the first answer, no take).
  - Holding a lease: `nextLeaseStep` with `proof` `proofs.proof()` when `needed` and the term is not split, else now;
    `ended` `proofs.ended()`. A fence by `ended` logs `The lease ended (<why>).` and stops the link frpc at once.
  - A take, renewal or fence that fails with SQLSTATE 53100 sets the beat's `full` until one succeeds; at lease end the
    link frpc stops even when the fence's own write fails, so a leader whose disk is full drops its route within 10 s
    (section 4, "Leader disk full").
  - Holding none and `needed`: each second `route` and `health` of its link (with the link's key) make a `Poll` and the
    window is `nextWindow(window, poll, false)`; then `nextEntryStep`: `ask` sends `POST /peer/promise { term }` to B
    over `PeerLink.ask` (its answer becomes B's answer, as a beat's would); `register` keeps its `generation` as
    `registering`, in memory, and starts the link frpc; `stop` stops it and clears `registering`; `take` becomes
    `nextLeaseStep`'s `entry`, and after the take the link frpc starts when it is stopped; `follow` writes `PEERS_FILE`
    from `seedView`, then `REPLICA_FILE`, logs `<host> leads now, or the name moved on; this machine follows.`, and
    exits; `wait` logs its `why` once per change. `split` for `nextLeaseStep` is its own term's.
  - While plan 9c's `Hander.holds()`, the lease loop still takes nothing, but a beat saying `lead` under a term above
    its own, or a route whose last registration (held or empty) is another client's, ends the planned switch: one log
    line, `handing.json` removed, and the `follow` above, whatever B answers about that switch.
  - At lease end the link frpc stops (plan 3's fence 4); while `needed` it stays stopped until the entry registers or
    takes, and plan 9's start 30 s later runs only while `needed` is false.
  - The sync controller starts with the keeper, leading or not (plan 9: at its first lead); a taking keeper's still
    starts only at `leads()` (plan 9c).
- Plan 9c's `Hander`: `reenter` and `abort` neither start the link frpc nor take a term by plan 3's ruling 8; the lease
  loop's entry does both, so a B that took over by Task 5's rule is followed. A taking keeper's `registering` is its
  `taking.json`'s `generation` (Task 5), so after `leads()` it takes its lease on its own registration.

- [ ] **Step 1: Write failing tests.**
  - `proofs.test.ts`, with a fake probe, fake `Beats` and fake clocks:
    - `proves by the link`: a probe answered with self and its nonce: `proof()` is its send time; one answered with a
      wrong nonce: no proof.
    - `proves by B`: B's answer `follow` with `term()`: its `sent`; the same from a copy that is not `b()`: no proof;
      `follow` with an older term: no proof.
    - `ends when another machine answers at the link`, and `ends when a beat says lead under a higher term`, each with
      its `ended()` text; `clear()` forgets both.
  - `lease-store.test.ts`: `takes the term it is given`: `take('normal', until, 'relay_off', { number: 9, machine: id,
    split: false })` makes state and lease term 9; a term not above the state's throws and changes nothing; a split take
    writes `sync` null.
  - `keeper.test.ts`, a leading keeper with a fake lease, probe, relay and `Beats`, injected clocks:
    - `renews without proof until a copy finished`: one data row `making`: renewals each tick with no probe answered;
      `needs proofs after a takeover with two machines`: the other row is the newest handover's `from`, its copy state
      null: renewals only on a proof.
    - `renews only on a proof once a copy finished`: the row `ready`, probes answered: renewals carry each probe's send
      time; probes unanswered and B silent: no renewal, and `fence` 10 s after the last proof.
    - `ends the lease at once when another machine answers at the link`: a probe answered with another network id:
      `fence` at the next tick, the link frpc stopped, `keeper.json` `read`.
    - `comes back in on B's promise`: no lease, a `ready` copy B answering beats: one `POST /peer/promise` with (T + 1,
      A); B answers `follow` (T + 1, A): the link frpc starts; once the fake sync controller's flag is set, `take` with
      that term and the ask's send time.
    - `comes back in through the relay when B does not answer`: B silent, the route empty at 7 with its own client as
      maker: no frpc start before the window is 12 s open and 25 s passed since the relay was first seen; then the frpc
      starts; once the fake relay's route names its client at 8 and the sync controller's flag is set, `take`.
    - `takes no proof from its own route at another generation`: as above, but the route names its client at 9: the frpc
      stopped, no `take`, and the window starts again.
    - `never comes back in after someone else registered`: the route empty at 8 made by another client: `PEERS_FILE` and
      `REPLICA_FILE` written, the exit called, no `take`, no frpc start.
    - `follows a newer leader it hears`: a beat saying `lead` at (T + 2, B): the same follow.
    - `steps down when its disk is full`: renewals throwing 53100 for 10 s: the link frpc stopped although `fence`
      throws too, and the beat's `full` true.
    - `keeps its link frpc stopped while it waits`: 60 s after a lapse with B silent and the route empty at 7, made by
      its own client, while the relay's health fails every fifth poll, the frpc never started.
  - `handing.test.ts`, `follows a takeover after a broken go`: `go` sent for switch S, B silent, then a beat from B
    saying `lead` (T + 2, B) from a takeover of another id: `handing.json` gone, `PEERS_FILE` and `REPLICA_FILE`
    written, the exit called, no `take`; the same with the route last registered by B's client and no beat.
  - `handing.test.ts`, `comes back in after an abort only by the entry`: after `reenter`, the fake lease records no
    `take` until B's answer says `follow` (T + 1, A) and the flag is set.
  - `sync.test.ts`: plan 9's case of the frpc started 30 s after lease end still starts it with no finished copy, and
    with a `ready` copy expects no start; `samples before the first lead`: a keeper with no lease whose own client holds
    the route posts off and has the flag `relay_off`.
  - `real/lease-store.test.ts`, `takes the term it is given` on real Postgres, as on PGlite.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Renew the lease only on a proof once a copy holds the data, and come back in by B or the
  relay".

### Task 5: The copy watches, promises and takes over

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 4 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/watch.test.ts test/taking.test.ts
test/switch-step.test.ts test/promote.test.ts test/follow-keeper.test.ts test/keeper-role.test.ts` passes, then the
whole server suite; from the worktree root `npm run test:real` passes after the disk check; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/watch.ts`
- Modify: `apps/server/src/modules/keeper/follow.ts` (the watcher, its stance, `/peer/promise`, the take),
  `apps/server/src/modules/keeper/taking.ts` (`Taking`, the `Promoter`'s takeover), `apps/server/src/modules/keeper/
  switch-step.ts` (`TakeSample`, one row), `apps/server/src/modules/keeper/promote.ts` (`writeTerm`, `recordHandover`)
- Test: `apps/server/test/watch.test.ts` (new), `apps/server/test/real/takeover.test.ts` (new),
  `apps/server/test/taking.test.ts`, `apps/server/test/switch-step.test.ts`, `apps/server/test/promote.test.ts`,
  `apps/server/test/follow-keeper.test.ts`, `apps/server/test/keeper-role.test.ts`

**Interfaces:**
- Consumes: `nextWindow`, `NO_WINDOW`, `nextWatchStep`, `WatchSample`, `promiseAnswer`, `TAKE_MS` (Task 3); `Beats`,
  `Beat`, `Stance` (Task 2); plan 9c's `Taking`, `writeTaking`, `readTaking`, `Promoter`, `nextTakeStep`, `TakeSample`,
  `writeTerm`, `recordHandover`, `dropSubscriptions`, `CopyUpdating.holds()`; plan 9's `CopyMaker.report()`; plan 1's
  `route` and `health`; plan 9c's `probe(nonce)`.
- Produces:
  ```ts
  // modules/keeper/watch.ts
  export const FOLLOWED_FILE = 'followed.json';   // keeper folder: { term }, 0600, written whole and then moved
  export function readFollowed(dir: string): Term | null;
  export function writeFollowed(dir: string, term: Term): void;
  export class Watcher {
    constructor(opts: { dir: string; self: { networkId: string };
      link: () => { name: string; key: string } | null;
      relay: { route(name: string, key: string, timeoutMs?: number): Promise<Route>;
        health(timeoutMs?: number): Promise<{ up: boolean; relayStarted: number | null }> };
      probe: (nonce: string) => Promise<{ machine: string; nonce: string } | null>;
      beats: Beats; leader: () => { networkId: string } | null;   // copy-state.json's leader, never PeerLink's
      ready: () => boolean; holds: () => boolean; reach: () => string | null;
      take: (t: Taking) => Promise<void>;
      ask: (on: boolean, s: WatchSample) => void;    // Task 6 makes the question of it
      ceo: () => number | null;                      // Task 6: when the CEO's "Go on from" for it came (monotonic)
      now?: () => Clocks; everyMs?: number; log: (line: string) => void });
    start(): void;
    stop(): void;
    tick(): Promise<void>;
    attempting(): boolean;   // true from the turn it decided to take over
    followed(): Term | null;
    stance(): Stance;        // attempting, else follow with followed()
    heard(from: string, beat: Beat): void;   // a beat or answer from the network id from
    promise(from: string, body: unknown): { status: number; body: unknown };   // POST /peer/promise
  }
  // taking.ts: Taking gains kind?: 'planned' | 'takeover' | 'ceo' (missing reads as planned), heard?: number | null
  //   (wall ms of the last beat from the old leader), reach?: string | null (ISO, how far its copy reached), full?:
  //   boolean (the old leader's last beat said its disk is full), generation?: number (the route's generation its
  //   window saw empty)
  // switch-step.ts: TakeSample gains kind: 'planned' | 'takeover' | 'ceo' and foreign: boolean
  // promote.ts: writeTerm(sql, o: { above: number; machine: string; split?: boolean }); recordHandover's h gains
  //   kind?: 'planned' | 'takeover' | 'ceo', heardAt?: Date | null, reach?: Date | null, members?: string[],
  //   reason?: 'disk_full' | null
  ```
- `tick`, every `everyMs` (1000): the send time; the link's `route` and `health` at once, 2 s each, and the reply time,
  as a `Poll` (null with no link); `heardLeader` when `beats.last(<leader>)` is newer than at the last tick;
  `nextWindow`; one probe at the link in flight at most (a new nonce, 2 s), whose answer with the leader's network id
  and its nonce sets `linkAnswered` to its reply time; `syncBeat` the `at` of `beats.last(<leader>)` when its stance is
  `lead` with lease `normal` and `sync` its own network id, kept until a newer such beat; then `nextWatchStep` with
  `started` its start, `asked` its last `ask`, `ceo()`, `ready()`, `holds()`.
- `take`: `attempting()` turns true in the same turn as the step, before any `await`; then `take({ switch: randomUUID(),
  from: { networkId: <leader> }, term: <the highest of followed() and the terms of every beat kept, else { number: 0,
  machine: <leader>, split: false }>, at: now.wall, deadline: now.wall + TAKE_MS, phase: 'go', w: null, copies: null,
  slots: null, why: null, kind, heard: <the wall time of the leader's newest beat, null with none>, reach: reach(),
  full: <that beat's full>, generation: <the window's generation> })`. `ask` and `unask` call `ask(true | false,
  sample)`; each change is one log line: "This copy may lack changes; asking the CEO." and "The question is gone."
- `heard`: a beat from the network id `leader()` names whose stance is `lead` with a term above `followed()`, or with
  none kept, writes `followed.json` with it; from any other machine nothing.
- `promise(from, body)`: 400 without a `term`; else `promiseAnswer({ asker: from, term: body.term, followed: followed(),
  attempting: attempting() })`; a grant writes `followed.json` first; the answer is 200 with the keeper's own beat after
  it, so its stance says what was decided.
- `leader()` is the network id of `copy-state.json`'s `leader` (plan 9c: the leader the copy was made on or last
  joined), so a lost session or a restart never erases the machine watched.
- The follow keeper: the `Watcher` runs from its start to its stop; its beat's stance is `watcher.stance()`; every beat
  it hears and every answer it gets goes to `watcher.heard`; `POST /peer/promise` from a data certificate goes to
  `watcher.promise` with the network id of the peer's row; `ready` is `report().state === 'ready'`; `holds` is plan 9c's
  `CopyUpdating.holds()` or a `taking.json` `offered`; `reach` is `report().at`; `take` is `writeTaking`, then the
  subscription disabled, then `exit()`, as plan 9c's `go`. `ask` logs only until Task 6; `ceo` answers null.
- The `Promoter`, for a `Taking` of kind `takeover` or `ceo`: `TakeSample.kind` from it; `registered` only when the
  route names its own client at exactly `taking.generation + 1`; `foreign` when the route's generation is above
  `taking.generation` and made by another client, held or empty, or above `taking.generation + 1`, so any registration
  since its window aborts; the promotion is `writeTerm({ above: taking.term.number, machine: <own network id>, split:
  kind === 'ceo' })`; `applied` read as `pg_replication_origin_progress` of its subscription's origin (`'pg_' || <the
  subscription's oid>`, flushed) before `dropSubscriptions`, `'0/0'` without one; `raiseSequences`; the publication; no
  `makeSlots`; `recordHandover({ id: taking.switch, from: taking.from.networkId, term: taking.term, applied, to: <own
  network id>, at: now, slots: {}, kind, heardAt: taking.heard, reach: taking.reach, members, reason: taking.full ?
  'disk_full' : null })`, `members` the network ids of the live rows of the role `data` but its own; then as plan 9c's.
  Its log line at `go` for a takeover: "Taking the server over from <host>: it has not answered since <time>."; for the
  CEO's: "Going on from <time> as the CEO chose."
- `nextTakeStep` gains a row after `go`, `termWritten`: `go`, kind not `planned`, `foreign`: abort `no_link`. An abort
  of a takeover is plan 9c's (the tunnel stopped, the subscription enabled, `aborted`, `exit`); the follow keeper's
  watcher then starts with a closed window.

- [ ] **Step 1: Write failing tests.**
  - `watch.test.ts`, a `Watcher` with a fake relay, probe, `Beats` and clocks, the leader A beating each second from
    -300 s with stance `lead` normal sync on this copy B, `followed` (7, A):
    - `takes over once the leader is gone`: beats and probe answers stop at 0, the route held until 25 then empty at 7,
      the record on B at 7: `take` once at 37 with kind `takeover`, phase `go`, `from` A, term (7, A), deadline now + 30
      s, `heard` the wall time of the beat at 0, `reach` the fake's, `generation` 7; `attempting()` true and `stance()`
      `attempting` from then.
    - `asks the CEO when check 5 fails, and stops asking when the leader is back`: the record on C: no `take`,
      `ask(true)` once at 37; a beat from A at 60: `ask(false)` once.
    - `keeps the question through a relay blip`: asking, then health down for 2 s: no `ask(false)`.
    - `keeps watching a leader it lost`: the leader's session gone (the fake link names no leader) at 0: still the
      takeover at 37, with `copy-state.json`'s leader as `from`.
    - `watches nothing while a promise holds or its copy is not ready`: `holds()` true, or `ready()` false, through the
      script above: no `take`, no `ask(true)`.
    - `grants nothing once it decided`: the fake `take` calls `promise(A, { term: (8, A) })` before it resolves: the
      answer's stance is `attempting`, and `followed.json` still (7, A).
    - `promises the next term to the machine it follows`: `promise(A, { term: (8, A) })`: `followed.json` (8, A) and
      stance `follow` (8, A); `promise(C, { term: (8, C) })`, `promise(A, { term: (7, A) })` and `promise(A, { term: (9,
      A, split) })`: no grant, stance `follow` with what was kept; with no `followed.json`: no grant; no `term`: 400.
    - `follows the leader's term`: no `followed.json`, `heard(A, lead (5, A))`: (5, A); `heard(C, lead (9, C))`: still
      (5, A); `heard(A, lead (4, A))`: still (5, A).
  - `switch-step.test.ts`, `gives a takeover up at once when another holds the name`: phase `go`, kind `takeover`,
    `foreign`: abort `no_link`; kind `planned`: register, as plan 9c's row; `termWritten` also set: promote.
  - `promote.test.ts`: `writes a split term`: `writeTerm({ above: 7, machine: B, split: true })` gives (8, B, split);
    `records a takeover`: `kind` `takeover`, `heard_at`, `reach`, `members` and `reason` as given, `slots` `{}`.
  - `taking.test.ts`:
    - `promotes after a takeover with no slots`: kind `takeover`, the fake route naming B's client, the probe right; the
      real promotion on `createTestSql` with a fake subscription: no slot made, one `net.handovers` row of kind
      `takeover` with `members` the other live data rows, `taking.json` `promoted`, `leads()` true.
    - `gives a takeover up when anyone registered since its window`: `generation` 7 and the route held by A's client at
      8, or empty at 8 made by A's client, or held by B's own client at 9: the tunnel stopped, the subscription enabled,
      `aborted` `no_link`, `exit` called, no term written; held by B's client at 8: it promotes.
    - `promotes the CEO's choice under a split term`: kind `ceo`: the state's term split, the handover's kind `ceo`.
  - `follow-keeper.test.ts`: `takes over by writing taking.json and exiting`: a fake watcher decision: `taking.json`
    `go` of kind `takeover`, the subscription disabled, then `exit`; `beats as follow, then attempting`; `answers the
    promise`: `POST /peer/promise` from A's certificate reaches `watcher.promise` with A's network id.
  - `keeper-role.test.ts`: `taking` for a `taking.json` `go` of kind `takeover` with `replica.json` there.
  - `real/takeover.test.ts`, section 12's "a third copy remade after an unplanned switch", on three `realCluster`s as
    plan 9's pairs: A leads, B and C subscribed as plan 9's maker subscribes them; rows written on A in `tasks`,
    `task_events` and `agent_events` until both have them; A's container stopped; on B the steps of the promotion above
    (no slot); C's subscription to A dropped, and C made again from B into `hornhoof_next` as plan 9's remake makes it;
    then rows written on B reach C within 10 s, every table of `public` and `net` has the same ids on B and C, and a
    `task_events` row made on B has an id above every one made on A; A started again: its `hornhoof` is as it was, and
    every id it holds is on B.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Check the disk, then run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let the sync copy take over by itself once the leader is gone and the relay says it has every
  change".

### Task 6: The CEO's question and "Go on from"

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/question.test.ts test/recovery-routes.test.ts
test/read-cookie.test.ts test/auth.test.ts test/app-mode.test.ts test/keeper.test.ts test/follow-keeper.test.ts` passes,
then the whole server suite; from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run
test/RecoveryQuestion.test.tsx test/i18n.test.tsx` passes; the `tsc` commands print nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/question.ts`, `apps/server/src/modules/recovery/routes.ts`,
  `apps/server/src/auth/read-cookie.ts`, `apps/web/src/ui/RecoveryQuestion.tsx`
- Modify: `apps/server/src/modules/keeper/state.ts` (`KeeperState.question`), `apps/server/src/modules/keeper/
  follow.ts` and `keeper.ts` (the question, `recovery.json`, `/peer/go-on`, the CEO's term turning normal),
  `apps/server/src/modules/keeper/app-mode.ts` (`modeGate`, `mode()` under a split lease),
  `apps/server/src/modules/auth/routes.ts` (sign-in and sign-out outside `lead`), `apps/server/src/auth/session.ts`
  (`requirePerson`), `apps/server/src/modules/keeper/ lease-store.ts` (`normal` on a handover), `apps/server/src/app.ts`
  (the routes), the web app's layout (where it shows the update's banner), `apps/web/src/api.ts`,
  `apps/web/src/i18n/en.ts`, `ru.ts`
- Test: `apps/server/test/question.test.ts` (new), `apps/server/test/recovery-routes.test.ts` (new),
  `apps/server/test/read-cookie.test.ts` (new), `apps/web/test/RecoveryQuestion.test.tsx` (new), and the existing tests
  of the modified modules

**Interfaces:**
- Consumes: `Watcher`'s `ask` and `ceo` (Task 5); `mayTurnNormal`, `CEO_KEEP_MS` (Task 3); `Beats` (Task 2); plan 2's
  `KeeperState`, `writeKeeperState`, `readKeeperState`, `modeGate`, `AppMode`; plan 3's `mode()`, `problems()` and
  `LeaseStore.take`; plan 9c's `SyncController.hold` and `Promoter.leads()`; plan 7's 403 `not_owner_session`; plan 1b's
  `SIGN_IN_LIMITS`; `limiter`, `startSession`, `requirePerson`, `Person` of today.
- Produces:
  ```ts
  // modules/keeper/question.ts
  export type Question = { since: string; leader: { networkId: string; host: string; heard: string | null };
    copies: { networkId: string; host: string; number: number | null; reach: string | null; self: boolean }[];
    waiting: string | null };
  //   ISO times; copies: itself and each other data machine whose newest beat, either way, came within 5 s and says
  //   ready, in the server order (null numbers last); waiting: until when the CEO chose to wait
  export const RECOVERY_FILE = 'recovery.json';   // control folder, the app's, 0600, whole and then moved
  export type RecoveryWord = { id: string; by: string; at: string }
    & ({ goOn: string; reach: string } | { wait: true });
  export function makeQuestion(o: { since: number; leader: Beat | null; leaderId: string; heard: number | null;
    self: Beat; beats: ReadonlyMap<string, Heard>; now: number }): Question;
  export class Recovery {
    constructor(opts: { controlDir: string; self: string; reach: () => string | null;
      ask: (networkId: string, path: string, body: unknown) => Promise<{ status: number; body: unknown } | null>;
      now?: () => number; log: (line: string) => void });
    tick(): Promise<void>;     // reads recovery.json once a second, acts, then removes it
    go(): number | null;       // monotonic ms of the CEO's word to go on here, kept CEO_KEEP_MS
    waiting(): number | null;  // wall ms until which the CEO chose to wait
    handle(from: string, body: unknown): { status: number; body: object };   // POST /peer/go-on
  }
  // modules/keeper/state.ts: KeeperState gains question?: Question | null
  // auth/read-cookie.ts
  export const READ_COOKIE = 'hh_read';            // __Host-hh_read over the link, as plan 1b names the session's
  export const READ_MS = 12 * 3_600_000;
  export function signRead(personId: string, passwordHash: string, until: number, secret: Buffer): string;
  //   <person id>.<until ms>.<base64url HMAC-SHA256 of "<person id>.<until>.<base64url SHA-256 of passwordHash>" under
  //   HMAC-SHA256("hh_read v1", secret)>, so a password change or reset ends every read cookie of that person
  export function readPerson(value: string | undefined): string | null;   // the person id of a well-formed value
  export function checkRead(value: string | undefined, passwordHash: string | null, secret: Buffer, now: number):
    boolean;
  //   true while until is ahead, passwordHash is not null and the MAC matches (timingSafeEqual)
  // modules/recovery/routes.ts
  export function recoveryRoutes(app: FastifyInstance, ctx: Ctx): void;
  // lease-store.ts: LeaseStore gains turnedNormal(handover: string): Promise<void> (net.handovers.normal_at now)
  ```
- The follow keeper: `Watcher.ask(true, s)` keeps a `Question` from `makeQuestion` (since its first ask; the leader's
  host and term from its newest beat; `heard` that beat's wall time), made again each tick while asking, and writes it
  into `keeper.json`; `ask(false)` removes it. `Watcher.ceo` is `recovery.go()`. `Recovery`:
  - `goOn` naming itself, with `reach` equal to `reach()`: `go()` is now; naming another copy: `POST /peer/go-on { reach
    }` to it (5 s); one log line either way: "The CEO chose to go on from <reach> on <host>."
  - `wait`: `waiting()` is now + `CEO_KEEP_MS`, `go()` cleared, and `POST /peer/go-on { wait: true }` to each other copy
    of the question; `Question.waiting` shows it.
  - `handle`, from a data certificate of a live data row: `{ reach }` equal to `reach()`: `go()` now, 200; another
    `reach` 409 `{ ok: false, why: 'reach' }`; `{ wait: true }`: as `wait`, without sending on; else 400.
- The app (`recoveryRoutes`), each `requirePerson`; the owner is the person with `isOwner` on his own session or read
  cookie (`via` unset), else 403 `forbidden` with `not_owner_session`:
  - `GET /api/recovery`: `{ question: Question | null, canAnswer: boolean }` from `readKeeperState(config.controlDir)`,
    question null in `lead`.
  - `POST /api/recovery/go-on { networkId, reach }`: owner only; 409 `conflict` 'The question changed. Look again.'
    (reason `question_changed`) unless the question lists that copy with that `reach`; else `recovery.json` `{ id, goOn,
    reach, by, at }`, 202.
  - `POST /api/recovery/wait`: owner only; 409 `question_changed` with no question; `recovery.json` `{ id, wait: true,
    by, at }`, 202.
- Sign-in outside `lead` (`modules/auth/routes.ts`): the password checked as today against the readable `people`; the
  tries counted in memory by `limiter` with each of `SIGN_IN_LIMITS`, as plan 1b counts them in the database; a right
  password sets `READ_COOKIE` (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` over the link, `Max-Age` 43200) to
  `signRead(<person>, <its password_hash>, now + READ_MS, <the company secret>)` and answers as today's sign-in; no
  session row. Sign-out outside `lead` clears both cookies and deletes nothing. `requirePerson`: with no session,
  `readPerson`'s person read, and `checkRead` with its current `password_hash`; outside `lead`, a valid read cookie of
  an `active` person gives that person with `via` unset; in `lead` a valid read cookie of an `active` person is traded
  once for a session (`startSession`) and cleared, so nobody signs in again after a switch; of a person not `active` it
  is cleared and gives nobody. The company secret is the app's `HORNHOOF_SECRET` (`config.secret`, as plan 7's
  `secrets()` reads it).
- `modeGate`: in `read`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/recovery/go-on` and `POST
  /api/recovery/wait` pass.
- The CEO's split term, end to end (ruling 7):
  - The `Promoter`, for kind `ceo`, calls `sync.hold(true)` before `leads()` turns true, and a leading keeper whose
    `net_local.state` term is split calls it at its start, so the sync controller's first sample already holds and
    `synchronous_standby_names` names nobody.
  - A split lease is taken and renewed with no flag and no proof (`nextLeaseStep`'s `split`, Task 3); plan 9's gate of a
    take and a renewal on the sync controller's flag is for a normal lease only. Its take waits for one read of `SHOW
    synchronous_standby_names` that is empty, so no split write waits on a copy.
  - `mode()` (plan 3's): `lead` when `leaseValid(held, now())`, `held.kind` is `normal` or `split`, and the last
    `problems()` answered `[]`. Plan 3's fence trigger already commits under `{ kind: 'split', sync: null }`.
- The leading keeper, holding a split lease whose newest `net.handovers` row of kind `ceo` names it `to` with
  `normal_at` null, each tick: `mayTurnNormal` with `relayUp` its last `health`, `holdsRoute` the last route held by its
  own client, `members` the handover's, `following` a beat or answer within 5 s from that network id saying `follow`
  with its term, `live` a live data row of that network id; when true: `sync.hold(false)`, and once the sync controller
  has a flag at the route's current generation (split writes meanwhile may wait on the copy it names, which only
  confirms them): `lease.take('normal', <the read's send time + LEASE_MS>, <flag>, { number: <M + 1>, machine: <own
  network id>, split: false })`, M the highest number it knows, then `turnedNormal(<handover>)` and one log line: "Every
  machine follows the term the CEO chose; it is a normal term now." The take fences first, so the app's sessions end and
  `front` holds for those seconds, as at any take. A leading keeper whose state's term is not split while the newest
  `ceo` handover naming it `to` has `normal_at` null (it stopped between the take and `turnedNormal`; only this take
  unsplits a term) calls `turnedNormal` at its start.
- `RecoveryQuestion` (shown by the layout while `GET /api/recovery`, polled every 5 s outside `lead`, has a question):
  with one copy `question.oneCopy`, with more `question.moreCopies`; one button per copy, `question.goOn` with one copy
  and `question.goOnAt` with more; `question.wait`; `question.warning` under them; `question.waiting` while `waiting` is
  ahead; without `canAnswer` the text and `question.ceoOnly`, no buttons. A press posts, then shows the next poll. Times
  as `HH:MM`, with the day when it is not today, in the page's locale.
- The strings, EN / RU:
  - `question.oneCopy`: "{leader} stopped answering at {heard}. This {host} may not have what {leader} did after
    {reach}. That comes back when {leader} does." / «Машина {leader} перестала отвечать в {heard}. У {host} может не
    быть того, что машина {leader} сделала после {reach}. Это вернется вместе с {leader}.»
  - `question.moreCopies`: "{leader} stopped answering at {heard}. The copies that are up may not have all {leader} did.
    That comes back when {leader} does." / «Машина {leader} перестала отвечать в {heard}. У копий, которые сейчас в
    сети, может не быть всего, что сделала машина {leader}. Это вернется вместе с {leader}.»
  - `question.goOn`: "Go on from {reach}" / «Продолжить с {reach}»; `question.goOnAt`: "Go on from {reach} on {host}" /
    «Продолжить с {reach} на {host}»; `question.wait`: "Wait for {leader}" / «Ждать {leader}»
  - `question.warning`: "Only if {leader} is off. If {leader} works too, both sides get changes; Hornhoof merges them
    later and the orchestrator asks you about real conflicts." / «Только если машина {leader} выключена. Если машина
    {leader} тоже работает, изменения будут на обеих сторонах; Hornhoof потом сольет их, а оркестратор спросит вас о
    настоящих конфликтах.»
  - `question.waiting`: "Waiting for {leader}. You can still choose a copy to go on from." / «Ждем {leader}. Вы все еще
    можете выбрать копию, с которой продолжить.»
  - `question.ceoOnly`: "Only the CEO answers this, from their own session." / «Ответить может только CEO, из своей
    сессии.»

- [ ] **Step 1: Write failing tests.**
  - `question.test.ts`:
    - `lists the copies that are up in the server order`: beats within 5 s from C (number 3, `ready`) and D (number 2,
      `ready`), one from E 6 s old, one from F not `ready`: `copies` D, C and itself by number, each with its reach; the
      leader's host and `heard` from its last beat.
    - `goes on here on the CEO's word`: `recovery.json` naming itself with its reach: `go()` set, the file gone; with
      another reach: no `go()`; `go()` null again after 10 minutes.
    - `passes the word to the copy named`: naming C: one `POST /peer/go-on { reach }` to C; C's `handle` with its own
      reach 200 and `go()` set, with another 409.
    - `waits on the CEO's word`: `wait`: `waiting()` 10 minutes ahead, a `go()` cleared, `{ wait: true }` to each other
      copy.
  - `follow-keeper.test.ts`, `writes the question while it asks`: the fake watcher's `ask(true)`: `keeper.json` has the
    question; `ask(false)`: it goes; `takes over as the CEO said`: `go()` set and the watcher's checks 1 to 4 met:
    `taking.json` of kind `ceo`.
  - `read-cookie.test.ts`: `signs and checks`: a cookie checks with its person's password hash until `until`, not after;
    a changed person id, `until` or MAC, another secret, or a null hash: false. `ends with a new password`: a cookie
    signed with one hash checks false with another.
  - `auth.test.ts`, the app in `read` (`keeper.json` `read`):
    - `signs in with a read cookie and no session row`: a right password: 200, a `hh_read` cookie, `sessions` unchanged;
      `GET /api/me` with it: the person; in `lead`, the same cookie: the person, a new `hh_session`, and the read cookie
      cleared.
    - `ends read cookies with the password`: a read cookie, then the person's password changed (or reset): `GET /api/me`
      401 in `read`, and in `lead` no session made.
    - `trades no read cookie of a person not active`: a valid read cookie of a person made inactive: in `lead` 401, no
      `hh_session`, the read cookie cleared.
    - `counts sign-in tries in memory`: 10 wrong passwords for one email from one address: the 11th is 429, and
      `sign_in_attempts` unchanged.
    - `signs out without writing`: sign-out in `read`: both cookies cleared, 200.
  - `recovery-routes.test.ts`, the app in `read` with a question in `keeper.json`:
    - `shows the question`: any person gets it; `canAnswer` true only for the owner on his own session or read cookie.
    - `takes the CEO's answer`: `go-on` with a listed copy and its reach: 202 and `recovery.json` with it; another reach
      or copy: 409 `question_changed`; by another person, or by the orchestrator acting for the owner: 403
      `not_owner_session`; `wait`: 202 and its file.
    - `passes the gate in read`: the two posts are not 503.
  - `keeper.test.ts`, `leads under the CEO's split term`, on PGlite with plan 3's fences: the state (8, B, split), the
    fake sync controller's flag null: `hold(true)` before the first sample, a take of kind `split` with no flag,
    `mode()` `lead`, an insert into `agents` on the app's session commits; `synchronous_standby_names` set to a copy
    before the take: no take until it reads empty. `notes a normal term it took before a crash`: the state (9, B)
    unsplit and the `ceo` handover's `normal_at` null: `turnedNormal` once at start.
  - `keeper.test.ts`, `turns the CEO's term normal once everyone follows`: a split lease, its `ceo` handover with
    members C and A; C answers `follow` with the term, A silent and live: no take; A answers too: `hold(false)`, no take
    while the fake sync controller has no flag, then one `take('normal', ...)` with term M + 1 unsplit, then `normal_at`
    set, and `mode()` `lead` again after it; A's row not live instead: the same; the relay down: no take.
  - `RecoveryQuestion.test.tsx`: one copy: the text and two buttons; three copies: three "Go on from ... on ..." and the
    wait; without `canAnswer`: no buttons and the CEO line; a press posts `go-on` with the copy's network id and reach.
  - `i18n.test.tsx`: every `question.*` key in both languages.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Ask the CEO when a copy may lack changes, and go on from where he chooses".

### Task 7: The old leader comes back as a copy

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 6 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/led.test.ts test/copy-maker.test.ts
test/keeper.test.ts test/backups-routes.test.ts test/updater.test.ts test/machines-routes.test.ts test/ranking.test.ts
test/merger.test.ts` passes (the existing files of those modules where a name differs), then the whole server suite;
from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/MachineCard.test.tsx test/i18n.test.tsx` passes;
the `tsc` commands print nothing; `bash -n` and `shellcheck` on `apps/updater/updater.sh` print nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/led.ts`
- Modify: `apps/server/src/modules/keeper/copy.ts` (the `led` guard becomes `saving`, the remake's source, the swap's
  wait), `apps/server/src/modules/keeper/follow.ts` (runs `LedSaver`), `apps/server/src/modules/keeper/keeper.ts` (`PUT
  /peer/led/<id>`), `apps/server/src/modules/backups/routes.ts` (the maker's view to a data keeper, a fork head from
  another data row), the merger's making of a `machine:` merge and its `MACHINE_SOURCE` (`modules/merge/source.ts`, plan
  9), plan 9's report route and `workerView` (`copy.old`), `apps/updater/updater.sh` (`dump_request` of `hornhoof` on a
  copy), `apps/server/src/modules/network/machines.ts` (or where plan 9c's `GET /api/machines` is: `copy.state`
  `saving`, `led`), `apps/web/src/types.ts`, the machine card (plan 9's copy lines), `apps/web/src/i18n/en.ts`, `ru.ts`
- Test: `apps/server/test/led.test.ts` (new), and the existing tests of the modified modules

**Interfaces:**
- Consumes: plan 7's `sealBundle`, `checkHead`, `BundleStore`, `MakerView`, `recordBundle`, `pickHolders`, the keeper's
  `secrets()`; plan 8's fork `dump.json`; plan 9's `CopyMaker`, `CopyReport`, `COPY_STATE`, the remake and swap (ruling
  14), `peerSource`; plan 9c's `dropSlots`, `termOf`, `PeerLink.ask`; plan 5b's `PeerLink.stream`; Task 1's `copy_state`
  `saving`; Task 5's handovers.
- Produces:
  ```ts
  // modules/keeper/led.ts
  export type LedState = { id: string; term: number; asked: string | null; sealed: boolean; recorded: boolean;
    failed: string | null; at: string };
  //   kept in copy-state.json as led; term: the led database's net_local.state term number
  export class LedSaver {
    constructor(opts: { dir: string; controlDir: string; sql: Sql; key: MachineKey; held: () => HeldCertificate | null;
      age: { identity: string; recipient: string }; secrets: () => BundleSecrets;
      leader: () => { networkId: string } | null;
      view: () => Promise<MakerView | null>;                       // GET /api/network/backups?as=maker on the leader
      put: (networkId: string, id: string, file: string) => Promise<number | null>;   // PUT /peer/led/<id>, its status
      now?: () => Date; everyMs?: number; log: (line: string) => void });
    tick(): Promise<void>;
    state(): LedState | null;
    done(): boolean;   // recorded
  }
  // copy.ts: CopyReport.state gains 'saving'; the report's old gains led?: number (the led term's number), which the
  //   report route writes into machines.copy_old_led beside copy_old (null when old is null or has no led)
  // merge/source.ts: MACHINE_SOURCE becomes /^machine:([0-9a-f-]{36}):(led-)?([1-9][0-9]{0,8})$/
  // GET /api/machines: each machine's copy.state may be 'saving'; each machine gains led: { until: string } | null
  ```
- A follow keeper's database led when its `net_local.state` has a row whose `handed_lsn` is null (plan 9c). Then,
  instead of plan 9's `stopped` with `led`, the maker reports `saving` and runs `LedSaver.tick` each `everyMs` (10 s)
  until `done()`; nothing of plan 9's remake starts before. The saver, each step checked first so a restart goes on:
  1. `dropSlots` on its database (no copy reads from it any more), and `ALTER SYSTEM RESET synchronous_standby_names`
     with a reload when it is set.
  2. `led` written with a new `id` and the state's term number; `dump.json` `{ id, database: 'hornhoof', reason: 'fork'
     }`. `dump_request` takes `hornhoof` with `reason` `fork` only while `replica.json` is in the control folder, and
     dumps it as plan 8's fork dumps; anything else stays refused as plan 8 says.
  3. With `dumps/<id>.json` and its `.sql.gz`: `view()`; `sealBundle` with the dump, `reason` `fork`, the view's
     `recipients` with its own `age.recipient`, the view's `recovery`, its own key and certificate, into its own store;
     `sealed`.
  4. `put(<leader>, id, <the bundle's file>)`: 201 or 200 is `recorded` and the dump goes; anything else is tried again
     at the next tick. A `.failed` dump: `failed` with its line, which is logged; the report `stopped` with `copy_error`
     `disk_full` when the line says `No space left on device`, else `setup` (plan 9's codes); a new `dump.json` 10
     minutes later.
- The leading keeper's `PUT /peer/led/<id>`, from a data certificate of a live data row: the body streamed into its
  `BundleStore` by `store().take(body, head => checkHead(head, { authorityPem, company }), { id })`, refused unless the
  head's signer is that peer's machine and its `reason` is `fork`; then `POST /api/network/backups { head, from: <the
  peer's machine id> }` to its own app; that answer's status is the answer (201, 200 for a row there already). The
  backups route takes `from` only from its own keeper, a `fork` head signed by that live data row and not the leader;
  `pickHolders` as for any bundle. `GET /api/network/backups?as=maker` from a keeper of a live data row answers its
  `MakerView` with `holders` `{}`, `wanted` `[]` and `order` null.
- Then plan 9's remake runs as for any copy, the led `hornhoof` the old database; its report's `old` carries `led`. The
  leader's merger, at `discover`, makes for a live row with `copy_old_led` set the merge `machine:<row
  id>:led-<copy_old_led>` (instead of `machine:<row id>:<copy_old>`), label "<hostname>'s database from when it led",
  run through `peerSource` as plan 9's; it is `done` once the row's `copy_old_led` is no longer that number or the row
  is not live; `workerView`'s `copy.old` is that merge's status while `copy_old_led` is set. It is compared the whole
  way (plan 9c counts only a handed database as one that never wrote). The swap of a led database waits also for
  `led.recorded`; plan 9's wipe keeps its guard.
- `GET /api/machines`: `led` is `{ until }` for the machine the newest `net.handovers` row names as the old leader
  (`from`), when its copy is `ready` with `copy_at` after that handover's `at`; `until` is its `heard_at`, else its
  `at`. Plan 9b's ranking gives the new leader 1 at its first lead and ranks the old one as any machine; nothing offers
  the server back but "Move the server here".
- The card: `copy.state` `saving`: `machines.copySaving`; `led`: `machines.led` beside "Move the server here".
  - `machines.copySaving`: "Copy: saving what it did while it led" / «Копия: сохраняет то, что сделано, пока она держала
    сервер»
  - `machines.led`: "{host} ran the server until {time} and is up to date again." / «Машина {host} держала сервер до
    {time}, ее копия снова актуальна.»

- [ ] **Step 1: Write failing tests.**
  - `led.test.ts`, a `LedSaver` with fakes for the view and `put`, on `createTestSql` with a state row of term 7 and no
    `handed_lsn`:
    - `saves what it led before anything else`: the first tick: slots dropped, `dump.json` `{ id, database: 'hornhoof',
      reason: 'fork' }`, `led.term` 7; with the dump there: one sealed bundle whose head says `fork` and is signed by
      this machine; `put` 201: `done()`, the dump gone.
    - `goes on after a restart in each step`: a new saver on `led` with `sealed` true: no new dump, `put` again.
    - `tries the leader again`: `put` null, then 503, then 201: three ticks, one bundle.
    - `says when the disk is full`: a `.failed` "No space left on device": the report `stopped` with `copy_error`
      `disk_full`, the line logged, no new `dump.json` until 10 minutes later; another line: `setup`.
  - `copy-maker.test.ts`: `saves a led database before remaking it`: the report `saving` until `done()`, then plan 9's
    remake; its `old` has `led` 7; `swaps a led database only once its bundle is recorded`: the leader's view says the
    merge `merged` and `led.recorded` false: no swap; true: the swap; `still remakes a handed database at once` (plan
    9c's case unchanged).
  - `keeper.test.ts`, `takes a led bundle from a data machine`: a `PUT /peer/led/<id>` from B's certificate with a
    bundle B signed: stored, the app's fake `POST /api/network/backups` gets `{ head, from: <B's machine id> }`, 201; a
    bundle signed by C from B's certificate: 403, nothing stored.
  - `backups-routes.test.ts`: `records a fork from another data machine through its keeper`: `from` B with B's
    signature: 201 and holders picked; `from` B from a worker: 403; a `timer` head with `from`: 400; `answers the
    maker's view to a data keeper`: `?as=maker` from B's keeper: `recipients` and `recovery`, no holders.
  - `updater.test.ts`: `dumps hornhoof on a copy only`: `dump.json` `{ database: 'hornhoof', reason: 'fork' }` with
    `replica.json` there: a `pg_dump` of `hornhoof`; without it: `.failed` "Not a kept database.".
  - `machines-routes.test.ts`: `notes the old leader once it is up to date`: a handover of kind `takeover` from A with
    `heard_at` 14:02: A's `led` null while its copy is `making`, `{ until: 14:02 }` once `ready` after it; a later
    handover from B: A's `led` null.
  - `merger.test.ts` (plan 9's machine merges): `merges a led database under its own source`: B's row with `copy_old` 3
    and `copy_old_led` 7: one merge `machine:<B>:led-7`, compared whole (no `fastWay`), and none `machine:<B>:3`; the
    report's `old` null afterwards: `done`; `MACHINE_SOURCE` takes `machine:<id>:led-7` and `machine:<id>:3`, not
    `machine:<id>:led-0`.
  - `ranking.test.ts`: `ranks the new leader first after a takeover and the old one as any`: B leads after a takeover
    from A, number 1 before: B is 1, A ranked by its score.
  - `MachineCard.test.tsx`: `saving` shows `machines.copySaving`; `led` shows `machines.led` beside the move button.
  - `i18n.test.tsx`: the two keys in both languages.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Save and merge what an old leader did before it becomes a copy again".

### Task 8: Jobs keep running while a merge is pending

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 7 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/parked.test.ts test/nodes.test.ts test/tools.test.ts
test/merger.test.ts test/front-calls.test.ts` passes (the existing files of those modules where a name differs), then
the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/nodes/parked.ts`
- Modify: `apps/server/src/modules/nodes/messages.ts` (`hello`, `job.started`, `job.event`, `job.done`,
  `agent.restarted`; `agent.unheard` unchanged), `apps/server/src/modules/tools/job.ts` (`jobOf`), plan 8's reading
  (`read.ts`), applier (`apply.ts`: `CLOSING` and its step 5) and completion check (`check.ts`), plan 8's merger where a
  merge ends `merged` or `done` and its picks (`picks.ts`), `apps/server/src/errors.ts` (`merge_pending`), plan 4's
  `net/front-calls.ts`
- Test: `apps/server/test/parked.test.ts` (new), and the existing tests of the modified modules

**Interfaces:**
- Consumes: Task 1's `net.parked` and `net.handovers` columns; Task 7's `machine:<id>:led-<n>` source; plan 8's merges,
  `runMerge`, `complete`, `backupsOf`, `CLOSING` and picks; plan 4's `frontCalls`, `CALL_HOLD_MS`; `handleNodeMessage`,
  `NodeIdentity`, `jobsOf`, `jobStarted` of today, and main's `agent.restarted`, `agent.unheard`, `job.done`'s `failure`
  and `afterFailure` (overview: the turn failures).
- Produces:
  ```ts
  // modules/nodes/parked.ts
  export function mergePending(db: Db, now?: number): Promise<boolean>;
  //   a net.handovers row of kind takeover or ceo whose from names a live machines row, with no net.merges row of
  //   source machine:<that row's id>:led-<any> made (created_at) after that handover's at and merged or done; read at
  //   most once a second, the answer cached
  export type ParkedKind = 'listed' | 'started' | 'event' | 'done';
  export function park(db: Db, o: { jobId: string; node: NodeIdentity; kind: ParkedKind; body: unknown }):
    Promise<void>;                                            // a listed row at most once per job
  export function parkedJobs(db: Db): Promise<Map<string, NodeIdentity>>;
  //   job ids with a row, each with the node of its newest listed or started row (else of its newest row)
  export function applyParked(ctx: Ctx): Promise<number>;
  //   for each job with rows whose applied_at is null and whose jobs row now exists, its started, event and done rows
  //   in order of at, each in its own transaction: handleNodeMessage with the stored identity on that transaction,
  //   then applied_at clock_timestamp() on the row; answers how many it applied. A done with failure goes through
  //   main's afterFailure there, once, as a done that arrives now does
  // merge/read.ts: parkedOf(q: Query): Promise<Row[]>   // net.parked, empty on a side without the table
  // errors.ts: ErrorReason gains 'merge_pending'
  // net/front-calls.ts
  export const CALL_WAITING = 'Hornhoof is bringing back work from another machine, so this call did not run. Try it '
    + 'again in a few minutes; if it keeps failing, end your turn with what you have done, and it is kept and applied '
    + 'once that machine is back.';
  ```
- While `mergePending`:
  - `hello`: a listed job with no `jobs` row is not cancelled and is parked as `listed`; a listed job whose row is
    `queued` becomes `running` on that node, as today's `jobStarted` writes it, so it is never sent out again; any other
    listed job is handled as today.
  - `job.started`, `job.event`, `job.done`, and main's `agent.restarted` when it names a job, of a job with no `jobs`
    row are parked with the whole message as `body` (`agent.restarted` as kind `event`) and answered as today's handled
    message (a `job.done` with `job.ack`).
  - Main's `agent.unheard` is never parked: it needs only the agent and its node, never the job row, so it is handled as
    on main, also while a merge is pending.
  - `jobOf`: a token whose hash matches no `jobs` row, or a `queued` one, throws `new ApiError(503, 'unavailable',
    'Hornhoof is bringing back work from another machine. Try again in a few minutes.', 'merge_pending')` with
    `Retry-After: 60`; a token of a job that ended stays 401 as today. Otherwise each is today's.
- `frontCalls` also tries again a 503 whose reason is `merge_pending`, as it tries `starting`; when `holdMs` runs out
  and the last answer was that 503, the agent gets `CALL_WAITING` (the app refused before the tool ran).
- The merge (plan 8's `runMerge`):
  - Step 4's `CLOSING` leaves a `jobs` row of the source `running` when its id has a `net.parked` row on the leader or
    in the source, with the node of `parkedJobs` (a `queued` one becomes `running` the same way); every other open row
    closes as `CLOSING` says. Test parts and computer runs close as `CLOSING` says.
  - Step 5 also adds the source's `net.parked` rows the leader lacks, by id, with their `applied_at` as in the source (a
    row the source applied is in the source's rows the merge brings).
  - `complete` also requires every `net.parked` row of the source on the leader.
- `applyParked(ctx)` runs after a merge ends `merged` or `done`, after a pick commits, at the app's first lead, and
  every 60 s while it leads.

- [ ] **Step 1: Write failing tests.**
  - `parked.test.ts`:
    - `knows when a merge is pending`: no handover: false; a `takeover` handover from A, A's row live: true; A's merge
      `machine:<A>:led-7` made after it and `running`: true; `merged`: false; a `merged` one made before the handover
      instead: true; A's row not live: false; a `planned` handover: false.
    - `keeps a job running that it does not know`: pending, a hello listing an unknown job: no `job.cancel`, one
      `listed` row; the same hello again: still one; a listed job `queued` here: `running` on that node; a known job
      closed here: `job.cancel` as today; not pending: the unknown job gets `job.cancel`.
    - `parks what an unknown job sends`: a `job.started`, an event, an `agent.restarted` and then a done: four rows in
      order, one `job.ack`.
    - `asks a tool call to wait`: an unknown token while pending, or the token of a `queued` job: 503 `merge_pending`
      with `Retry-After: 60`; the token of a job that ended: 401; not pending: 401 as today.
    - `applies what it parked once the job is there`: the job's row added open: `applyParked` answers 3, the job
      `running`, its events appended, then `done` with its result, every row `applied_at` set; again: 0. A parked done
      with `failure` kind `overloaded`: exactly one retry queued, as main's `afterFailure` queues it; with
      `usage_limit`: no retry, the plan held; neither again on a second run.
    - `handles unheard words at once`: pending, an `agent.unheard` naming a job with no row: no parked row, the words
      kept for the agent's next turn as on main.
    - `applies each message once across a crash`: `handleNodeMessage` throws inside the second row's transaction: the
      first row applied, the second's event not appended and `applied_at` null; the next run applies the second and the
      done once.
    - `applies once a pick brings the job`: the job's row comes by a pick of plan 8: its parked done applied right after
      the pick.
  - `merger.test.ts` (plan 8's merges on PGlite):
    - `keeps a parked job open`: a source with a `running` job whose id is parked on the leader: the merged row is
      `running` on the parked node; a `queued` one parked in the source: `running`; another `running` job of the source:
      `failed` as `CLOSING` says; then `applyParked` closes the first with its parked `job.done`.
    - `carries parked rows across two takeovers`: B parked a job's `done` as leader, C took over by the CEO and B comes
      back: B's led merge adds the row to C with `applied_at` null and `complete` holds only with it; `applyParked` on C
      closes the job; a row B had applied comes with its `applied_at` and is not applied again.
  - `front-calls.test.ts`: `waits out a pending merge`: a 503 `merge_pending` and then 200: one answer, the 200;
    `merge_pending` until `holdMs`: `CALL_WAITING` with `isError` true.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep the old leader's jobs running across a takeover and apply their results after the merge".

### Task 9: A hidden name for a company with no link

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 8 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/link.test.ts test/copies-order.test.ts
test/keeper.test.ts test/network-join.test.ts test/seed-view.test.ts test/worker-config.test.ts
test/worker-keeper.test.ts test/settings.test.ts test/carry.test.ts` passes (the existing files of those modules where a
name differs), then the whole server suite; from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run
test/i18n.test.tsx` passes; the `tsc` commands print nothing.

**Files:**
- Modify: `apps/server/src/modules/link/link.ts` (`PublicLinks.ensureHidden`, `set`, `remove`, `linkOf`,
  `writeTunnelSettings`), `apps/server/src/modules/copies/order.ts` (`rank` makes the hidden name),
  `apps/server/src/modules/network/join.ts` (`workerView`'s `link`), `apps/server/src/modules/keeper/seed-view.ts`, the
  keeper's link doors (where plan 3 answers `GET /api/network/lease` over the link),
  `apps/server/src/modules/keeper/worker-config.ts` (`followConfig`), `apps/server/src/modules/keeper/worker.ts` (the
  renewal's addresses), plan 9's carry (`apps/updater/carry.sql`, `Carry` in `modules/backups/types.ts`, `applyCarry` in
  `modules/backups/restore.ts`), `apps/web/src/i18n/en.ts`, `ru.ts` (`no_link`'s words)
- Test: the existing tests of the modified modules, and plan 9's `carry.test.ts`

**Interfaces:**
- Consumes: Task 1's `public_links.hidden`; plan 9's `rankOf`, `Unfit` `no_link`, `link_needed`; plan 9c's `seedView`;
  plan 5b's `WorkerView`, the renewal's order.
- Produces:
  ```ts
  // modules/link/link.ts
  //   PublicLinks.set(companyId, name?, o?: { hidden?: boolean }): a hidden link is bound with no name (the relay picks
  //   one) and saved with hidden true; ensureHidden(companyId): Promise<boolean> makes one when the company has no
  //   public_links row, true once a row is there; linkOf answers null for a hidden row; tunnel.json gains hidden
  // WorkerView.link gains hidden: boolean; plan 9's Carry.link gains hidden: boolean
  ```
- `rank`, before `rankOf`: with no `public_links` row, `ensureHidden`, its answer being `rankOf`'s `link`; a relay that
  does not answer leaves `link` false, so `no_link` now means only that, with new words (below).
- `PublicLinks.remove` while another live data row is listed: `set(companyId, undefined, { hidden: true })`, so the
  public name goes and a new hidden one takes its place; plan 9's 409 `link_needed` is gone. `set` with a name over a
  hidden row replaces it as any rename does, and the sync controller follows the new name (plan 9's ruling 18).
- A hidden link is the link for everything of the keepers': `tunnel.json`, the sync controller's `link()`, the probe's
  base, `seedView`, `workerView`'s `link` (with `hidden`), its certificate as plan 1b orders it for any link. For people
  it is none: `linkOf` and `publicUrl` answer as with no link, so Settings offers to turn a link on. The keeper's link
  doors answer on a hidden name only `GET /api/network/lease`, and 404 `{ ok: false }` for anything else. Every route a
  link door answers, today's and later plans' (plan 3's lease, Task 10's switch word), checks `hidden` first.
  `followConfig` and a worker's renewal never take a hidden link's url; with no join server, `followConfig` takes
  `http://<address>:<web port>` of the view's first data machine with an address.
- The carry keeps it: `carry.sql` answers the link row's `hidden`, and `applyCarry` writes it with the rest of the row,
  so a restore never turns a hidden name into a public link.
- `no_link`: "the company's hidden name at hornhoof.org is not made yet; Hornhoof makes it once hornhoof.org answers" /
  «скрытое имя компании на hornhoof.org еще не создано; Hornhoof создаст его, как только hornhoof.org ответит»

- [ ] **Step 1: Write failing tests.**
  - `copies-order.test.ts`, `makes a hidden name for a company with no link`: no link and a qualifying machine: the fake
    relay saw one bind with no name, the row has `hidden` true, the machine is number 2; the relay down: no row, the
    reason `no_link`; a second `rank`: no second bind.
  - `link.test.ts`:
    - `hides the hidden name from people`: `linkOf` null, `publicUrl` the configured one, `tunnel.json` with `hidden`
      true and the name.
    - `turns a public link on over a hidden one`: `set(companyId, 'acme')`: the row is `acme`, not hidden, and the
      hidden name was let go after it; the sync controller's next record goes to `acme`, and the leading keeper's
      `registering` starts over for that name.
    - `hides the name when the public link goes while copies need it`: with another data row, `remove`: a new random
      name, `hidden` true, the public name let go, no 409, and the next sync record goes to the new name; with no other
      data row it goes as today.
  - `settings.test.ts` (the Settings route of the link): `shows no link for a hidden one`: the link part says none.
  - `keeper.test.ts`, `answers only the lease on a hidden name`: through the link door with `hidden`: `GET
    /api/network/lease?nonce=` answers; `GET /` and `GET /api/health` 404.
  - `network-join.test.ts` and `seed-view.test.ts`: `carry the hidden link to the machines`: the view's link with
    `hidden` true and its secrets.
  - `worker-config.test.ts`, `never follows a hidden link's url`: no join server, a hidden link and one data machine
    with an address: its `http://<address>:<port>`.
  - `worker-keeper.test.ts`, `renews past a hidden link`: the renewal tries the join server, then the data machines,
    never the hidden url.
  - `carry.test.ts`, `carries a hidden link as hidden`: `carry.sql` answers `hidden` true for a hidden row; `applyCarry`
    of it onto a database whose link is public: the row hidden, with the carry's name and keys; of a public one onto a
    hidden row: public.
  - `i18n.test.tsx`: `no_link`'s new words in both languages.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Give a company with no link a hidden name at hornhoof.org, so its machines keep copies".

### Task 10: The page during a switch

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 9 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/switch-word.test.ts test/switched.test.ts
test/keeper.test.ts test/follow-keeper.test.ts test/worker-keeper.test.ts` passes, then the whole server suite; from
`apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/SwitchBanner.test.tsx test/i18n.test.tsx` passes; the
`tsc` commands print nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/switch-word.ts`, `apps/server/src/modules/network/switched.ts`,
  `apps/web/src/ui/SwitchBanner.tsx`
- Modify: `apps/server/src/modules/keeper/keeper.ts`, `follow.ts` and `worker.ts` (`GET /api/network/switch` on the
  front and link doors), `apps/server/src/app.ts` (the route, the note at the first lead), the web app's layout,
  `apps/web/src/api.ts`, `apps/web/src/i18n/en.ts`, `ru.ts`
- Test: `apps/server/test/switch-word.test.ts` (new), `apps/server/test/switched.test.ts` (new),
  `apps/web/test/SwitchBanner.test.tsx` (new), and the existing tests of the modified modules

**Interfaces:**
- Consumes: plan 9c's `Hander.holds()`, `Handing.to`, `Promoter.leads()`; Task 2's `Hello.sync`; Task 5's `Watcher`;
  Task 6's question; plan 5b's `PeerLink.leader()`; `enqueueTurn` of today.
- Produces:
  ```ts
  // modules/keeper/switch-word.ts
  export const LOST_MS = 120_000;
  export type SwitchWord = { moving: boolean; from: string | null; to: string | null; since: string | null;
    cut: boolean; question: boolean };
  //   from, to: machine ids (never hostnames, since the link door answers anyone); since: ISO
  export function switchWord(o: { now: number; kind: 'lead' | 'handing' | 'taking' | 'follow' | 'worker';
    self: string; handingTo: string | null; leads: boolean; leader: string | null; lastLeader: string | null;
    lastSync: string | null; lostSince: number | null; cut: boolean; question: boolean }): SwitchWord;
  //   handing: moving, from self, to handingTo; taking and not leads: moving, from lastLeader, to self; follow or
  //   worker with leader null and lostSince under LOST_MS ago: moving, from lastLeader, to lastSync (null when that is
  //   the lost one); else not moving
  // modules/network/switched.ts
  export function switchedRoutes(app: FastifyInstance, ctx: Ctx): void;   // GET /api/network/switched
  export function noteSwitch(ctx: Ctx): Promise<void>;                     // at the app's first lead
  ```
- Every keeper answers `GET /api/network/switch` on its front door and on a public link's door itself (a hidden link's
  door answers it 404, as Task 9 says), never passed on or held, with `switchWord` of what it knows: `lostSince` when
  `leader()` turned null (cleared once it names one), `lastLeader` and `lastSync` from the last hello that said `lead`,
  `cut` on a follow keeper whose leader's newest beat is over 20 s old while its watcher's `linkAnswered` is under 20 s
  old, `question` while the question stands.
- `GET /api/network/switched` (`requirePerson`): the newest `net.handovers` row whose `at` is within 24 hours, as `{ id,
  kind, reason, from: <hostname>, to: <hostname>, heard: ISO | null, reach: ISO | null, at: ISO }`, else `null`.
- `noteSwitch`: at the app's first lead (`whenLead`'s enter), the newest handover of kind `takeover` or `ceo` whose `to`
  is this machine, within 24 hours and with `noted_at` null: `enqueueTurn` to the orchestrator with `answersCeo` true,
  as `modules/computer/routes.ts` does, then `noted_at` now. Its prompt:
  - `takeover`: "Hornhoof runs on {to} now: {from} stopped answering at {heard}, and {to} had every change it confirmed.
    Tell the CEO so in your window in a sentence or two, and that jobs {from} started that still run carry on; their
    results arrive once {from} is back and merged."
  - `ceo`: "Hornhoof runs on {to} now, from what it had at {reach}, as the CEO chose after {from} stopped answering at
    {heard}. Tell the CEO so in your window in a sentence or two, and that what {from} did after {reach} comes back,
    merged, once {from} is back."
- `SwitchBanner`, in the layout above every screen: polls `GET /api/network/switch` every 5 s, every second while
  `moving`, a failed poll counting as no change; it names machines by their hostnames from the page's last `GET
  /api/machines`. While `moving`: `switch.moving` with `to` named, `switch.movingSomewhere` with `to` null or unknown;
  with `from` known and `to` null: `switch.lost`, else `switch.lostLeader`. While `cut`: `switch.cut`. Else, once `GET
  /api/network/switched` (read every minute, and once a move ends) gives a handover whose id the reader has not closed:
  `switched.diskFull` (a takeover with `reason`), `switched.takeover`, `switched.ceo` or `switched.planned`, with
  `switched.close`; the closed ids are kept in `localStorage` in a try and catch, as a convenience. `question` shows
  Task 6's `RecoveryQuestion` at once.
- The strings, EN / RU:
  - `switch.moving`: "Moving the company to {to}. Your work is kept. About a minute." / «Компания переезжает на {to}.
    Ваша работа сохранена. Около минуты.»
  - `switch.movingSomewhere`: "Moving the company to another machine. Your work is kept. About a minute." / «Компания
    переезжает на другую машину. Ваша работа сохранена. Около минуты.»
  - `switch.lost`: "Lost {from}. Hornhoof is finding where to go on; your work is kept." / «Связь с {from} потеряна.
    Hornhoof ищет, где продолжить; ваша работа сохранена.»
  - `switch.lostLeader`: "Lost the machine that ran the server. Hornhoof is finding where to go on; your work is kept."
    / «Связь с машиной, которая держала сервер, потеряна. Hornhoof ищет, где продолжить; ваша работа сохранена.»
  - `switch.cut`: "{self} cannot reach {from}; copy stopped." / «Машина {self} не может связаться с {from}; копия
    остановлена.»
  - `switched.takeover`: "Hornhoof runs on {to} now. {from} stopped answering at {time}." / «Hornhoof теперь работает на
    {to}. Машина {from} перестала отвечать в {time}.»
  - `switched.ceo`: "Hornhoof runs on {to} now, from what it had at {time}, as you chose." / «Hornhoof теперь работает
    на {to}, с того, что было на {time}, как вы выбрали.»
  - `switched.planned`: "Hornhoof runs on {to} now." / «Hornhoof теперь работает на {to}.»
  - `switched.diskFull`: "{from}'s disk is full; {to} leads." / «Диск машины {from} заполнен; сервер теперь держит
    {to}.»
  - `switched.close`: "Close" / «Закрыть»

- [ ] **Step 1: Write failing tests.**
  - `switch-word.test.ts`, one test per case of `switchWord`: handing; taking before and after `leads`; a follow keeper
    and a worker 10 s after the leader went, with `lastSync` another machine and with `lastSync` the lost one; 121 s
    after: not moving; `cut` and `question` passed through.
  - `keeper.test.ts`, `answers where the company moves`: a handing keeper's front and link doors answer `moving` with
    `to` the target's machine id, at once, also while the app is down; through a hidden link's door: 404;
    `follow-keeper.test.ts`, `says the copy is cut off`: beats from the leader stop, its probe still answered: `cut`
    after 20 s; `worker-keeper.test.ts`, `says the company moves when the leader is lost`: `moving` with the last
    hello's `sync` as `to`.
  - `switched.test.ts`:
    - `says where the company runs now`: a `takeover` handover 1 h ago: its hostnames, `heard` and `reason`; 25 h ago:
      null.
    - `tells the orchestrator once`: at the first lead with a `takeover` handover to this machine: one `enqueueTurn`
      with `answersCeo` and the takeover's prompt with the hostnames and time, `noted_at` set; a second lead: none; a
      `planned` handover: none.
  - `SwitchBanner.test.tsx`: `moving` with a known `to`: the moving line with its hostname, then polls each second; an
    unknown `to`: the other line; a lost leader with no `to`: `switch.lost`; `cut`; a `switched` takeover: its line and
    close, and after close not again for that id; one with `reason` `disk_full`: `switched.diskFull`; a failed poll
    keeps the last line.
  - `i18n.test.tsx`: every `switch.*` and `switched.*` key in both languages.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep the page open through a switch and say where the company runs".

### Task 11: The lab: number 1 cut off, and the leader and its sync copy stopped together

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 10 committed. **Done when:** from the worktree
root `npm run test:lab` passes with Docker running, after the disk check; from `apps/server`, `VITEST_MAX_WORKERS=2 nice
-n 10 npx vitest run test/lab/overlap.test.ts` passes; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/test/lab/takeover.test.ts`, `apps/server/test/lab/overlap.ts`
- Modify: `apps/server/test/lab/lab.ts` (`cut`, `mend`, and plan 9c's `edge`), `apps/server/test/lab/writer.ts` (plan
  9's `startWriter`)
- Test: `apps/server/test/lab/overlap.test.ts` (new, a unit test of the checker)

**Interfaces:**
- Consumes: plan 5b's `Lab`, `LabMachine`, `steps.ts`; plan 9's `startWriter`, `checkRows`, `relay()`; plan 9c's
  `edge()`, its scenario's first step; plan 3's `net.journal` (`tbl`, `op`, `key`, `term_number`, `term_machine`,
  `term_split`).
- Produces:
  ```ts
  // test/lab/lab.ts
  //   cut(m: LabMachine): Promise<void>   // docker network disconnect of m from the lab's network; m noted as cut
  //   mend(m: LabMachine): Promise<void>  // and connect again; the note gone
  //   edge(...) as plan 9c's, but it answers 502, without running curl, when the machine holding the route is noted
  //   as cut or its keeper container is not running, so docker exec never reaches past a cut
  // test/lab/writer.ts
  //   startWriter(target: LabMachine | (() => Promise<LabMachine | null>), session: string, everyMs = 200):
  //   { stop(): Promise<Written[]> }   // a function target is asked before each write; null skips that write
  export type Written = { id: string; at: number; machine: string };   // at: the test's clock at the 2xx answer
  export function leaderOf(ms: LabMachine[]): () => Promise<LabMachine | null>;
  //   the machine whose /api/keeper says lead, read once a second, null while none or two say it
  // test/lab/overlap.ts
  export type Confirmed = Written & { term: { number: number; machine: string; split: boolean } };
  export function confirmedOf(m: LabMachine, written: Written[]): Promise<Confirmed[]>;
  //   each id's term from the net.journal row of its insert into tasks on m (tbl 'tasks', op 'insert', key { id })
  export function lateConfirms(ws: Confirmed[]): [Confirmed, Confirmed][];
  //   pairs (a, b), b answered after a by the test's clock, b's term below a's (number, then machine), neither split:
  //   an older leader's write confirmed once a newer one's was
  ```
- The writer uses one session on whichever machine leads, as `sessions` is a replicated table; plan 9's and 9c's
  scenarios keep passing a `LabMachine`.
- `takeover.test.ts`, one scenario, 75 minutes at most, the disk check first:
  1. Plan 9c's scenario's step 1 (m1 a server with the lab's relay and edge, m2 number 2 named sync, m3 number 3, both
     `ready`). The writer with `leaderOf([m1, m2, m3])` for the rest of the scenario. The test plays frps for the link
     name: it drops the name when the machine holding it is cut or stopped, after the fake's `evictionBound`, and
     registers the client whose `taking.json` says `go`, or whose link frpc config names the client at its start.
  2. "Number 1 cut off": `cut(m1)` at t0. Within 75 s of t0, m2's `/api/keeper` says `lead`, under a term above m1's;
     `GET /api/machines` from m2 has m2 number 1; m2's newest `net.handovers` row is of kind `takeover` from m1. Once
     the writer has a write answered by m2, the test creates a task on m1's own API from inside m1's `app` container
     (`docker exec`, which a cut does not stop): no 2xx within 30 s.
  3. "Coming back": `mend(m1)`. Within 2 minutes m1's `/api/keeper` says `read` with m2 as leader; m1's card says
     `saving`, then the copy is made again; within 15 minutes m1's copy is `ready`, its `led` is set, `net.backups` on
     m2 has a `fork` bundle signed by m1, and the merge `machine:<m1>:led-<n>` is `merged` or `done`. m2 is still number
     1.
  4. "The leader and its sync copy stopped together": with the copy m2 names sync (X) and the third (Y), `docker stop`
     of every container of m2 and X at t1. Within 90 s Y's `GET /api/recovery` (the owner's read cookie, signed in on
     Y's own address) has a question listing Y alone, and Y does not lead. The test posts `go-on` with Y's network id
     and reach: within 75 s Y leads under a split term, its handover of kind `ceo`, and the writer's writes are answered
     by Y. Then m2 and X start again: within 15 minutes both follow Y, m2's led database is merged and remade as in step
     3, X is remade, and Y's handover has `normal_at` set and Y's lease is `normal`.
  5. The writer stopped. Once every copy is `ready` and at Y's `pg_current_wal_lsn()` (2 minutes at most), `checkRows`
     of m1, m2, m3 for every id the writer kept is empty, the rows X held past Y's reach included, which came back by
     the merges; `lateConfirms(await confirmedOf(Y, <the kept writes>))` is empty.

- [ ] **Step 1: Write the failing test** and `cut`, `mend`, the `edge` and writer changes, `overlap.ts` with
  `overlap.test.ts` (a write of (7, A) answered after one of (8, B): one pair; the other order: none; of one term: none;
  either split: none; a lower machine at the same number after: one pair); `npm run test:lab` fails at step 2.
- [ ] **Step 2: Fix** what it finds in Tasks 1 to 10, each fix with its failing test first in that task's test file.
- [ ] **Step 3: Check the disk, then run Done when,** as plan 7's Task 10 Step 3. Expected: PASS.
- [ ] **Step 4: Commit** "Test takeovers in the lab: number 1 cut off and back, and the leader and its sync copy stopped
  together".

### Task 12: Run everything and review

**Repo:** the `network` worktree, branch `network`. **Starts from:** Tasks 1 to 11 committed and reviewed. **Done
when:** Steps 1 and 2 pass for the agent; Step 3 is the team lead's, never an agent's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` and `npm run
  test:lab` (after the disk check) → pass; the `tsc` commands → no output; `bash -n` and `shellcheck` on
  `apps/updater/updater.sh` → no output.
- [ ] **Step 2: Check the public-repo rule.** As plan 7's Task 11 Step 2.
- [ ] **Step 3: Review.** The team lead reads the branch against the spec sections this plan names, the overview's plan
  10 entry and this plan's rulings, with Review Focus first; the CLI agent that did not write a task reviews it too; one
  fix pass, each fix with its failing test first.

The rehearsal, the merge into main, Ivan's Updates and the worktree's close are done once, for the whole series, at its
end. This plan's part of that rehearsal is Task 11's scenario and, on the rehearsal's company, its leader's power pulled
once with the page open.

## Addendum: the relay outage at 2 minutes (spec 3.5, spec:1125, ov:228)

Spec 12 asks for "the leader dying in a relay outage of 90 s leaving its sync copy a CEO question"; the overview and
spec 3.5 give the range, "between about 75 s and 2 minutes". Task 3's table has 60 s (take at 85), 75 s (ask at 100)
and 90 s (ask at 115), which pin the spec's row and the range's lower edge, where check 5's 100 s is passed. No row is
missing here, and none is added: to this plan, every outage from 75 s up reads the same, so a row at 120 s would prove
nothing that 90 s does not. The upper edge is where the question meets a split, and splits are plan 11's: that plan's
Task A1 tests it.
