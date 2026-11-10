You are the writer for Task 3 of 2026-11-03-network-phase-1-plan-10-takeover in Hornhoof's network build. Read everything below before you start.

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

# How you work (writer)

The top of your notes says how; a task's "Commit" step is your hand-in's commit. Change only the task's files. No `npm install`/`npm ci` unless the task names a dependency to add. Never run prettier or any formatter. Shell is bash on Debian Linux, x86_64, GNU tools. Python for the relay: standard library only, runnable on Python 3.12 (`/home/altera/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12`; 3.14 at `/home/altera/hornhoof-network/quality/python/cpython-3.14-linux-x86_64-gnu/bin/python3.14`). There is no pytest. Stop and report when a fact the task rests on proves wrong in the code.

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
2. The author check, on that commit. Hornhoof: `REMOTE_HORNHOOF_TREE=/home/altera/hornhoof-network/wt/<lane> /home/altera/hornhoof-network/network-build/remote.sh run <lane>-check 'cd /home/altera/hornhoof-network/hornhoof && /home/altera/hornhoof-network/network-build/author-check.sh lanebase'`. Relay: `REMOTE_EDGE_TREE=/home/altera/hornhoof-network/wt/<lane> /home/altera/hornhoof-network/network-build/remote.sh run <lane>-check 'cd /home/altera/hornhoof-network/hornhoof-edge && /home/altera/hornhoof-network/network-build/author-check-relay.sh lanebase "<the unittest modules your change reaches, each as relay.test.<module>>"'`. It may queue. Start it in the background and wait with `/home/altera/hornhoof-network/network-build/remote-wait.sh <lane>-check` in the foreground, calling it again while it says WAITING. Never end your turn while it is pending.
3. Red: at most two tries to fix your own red, each commit followed by the check. Still red: stop and tell the lead.

**Reply to the lead:** the status (DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT), the commit, and the log path `network-build/runs/remote-<lane>-check-*.log`, in at most five lines. That log on that commit is the evidence, and nobody reruns it. There is no review agent per task; tasks land in batches, and the batch gets one review and one fix round. A deviation from the plan, and every place where the plan proved wrong, goes in your commit message's body and your reply, as a line `Ruling: <what> - why: <why> - cost if wrong: <cost>`. Never push. No subagents.


# Notes for this task from the build lead

- Your lane: `/home/altera/hornhoof-network/wt/p10t3`, Hornhoof repo, branch `task-p10t3`. Kind: known behaviour, test-first as the plan says. Pure tables, with section 4's rows replayed by the second. A mutator target at the end of phase 1, so the table of cases matters. No database, no process, no clock.
- Plan 10 Task 3, whole, with Plan 10 Task 2's types. "Starts from" is paper here: Task 1 and Task 2 are not written. Your files: `apps/server/src/modules/keeper/takeover-step.ts`, `apps/server/src/modules/keeper/beats.ts` holding ONLY `BEAT_MS`, `BEAT_WAIT_MS`, `Stance`, `Beat`, `Heard`, `parseBeat` (Task 2's text for these is in `/home/altera/hornhoof-network/plans/2026-11-03-network-phase-1-plan-10-takeover.md`: read Task 2's lines for them, the `Beats` class stays for Task 2's writer since it needs `Peer` from Plan 5), `apps/server/test/takeover-step.test.ts`, `takeover-rows.test.ts`, `beats.test.ts` (`parseBeat` only); and modify `keeper/lease.ts`, `apps/server/test/lease.test.ts`. The peer-server and peer-link changes stay out.
- `LeaseStep` only gains fields, so Plan 3's keeper, not written yet, still compiles. `Route` (`modules/link/relay.ts:40`) has the `known` the window reads. `SyncRecord` (`:26`). `Health`'s `DOWN` (`:46`) has `relayStarted: null`, which fits `Poll.health`.
- `Term`, `Clocks`, `LEASE_MS`, `LATE_MS`, `BACK_MS`, `Held`, `leaseValid` are below your `lanebase` (Plan 3 Tasks 1 and 2 and the pure `lease.ts`, not landed yet). Ruling in `lease.ts`, earlier: renew's kind is maintenance or normal, also for a held split lease, "plan 10 task 3 adds the input". That line is yours to replace.
- Commit subject: the plan's, as this finishes Task 3. Ruling lines for anything where the plan's table proves to disagree with itself. `/* */` comments, as `apps/server` writes them.

# The plan, from its top to the end of Review Focus (quality rules inserted after its Global Constraints)

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

**One repository.** Hornhoof, `/home/altera/hornhoof-network/hornhoof`, in the series' worktree
`/home/altera/hornhoof-network/hornhoof/.claude/worktrees/network` on its branch `network`, after plan 9c's last task is
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
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
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


# Quality rules (from the team lead, 2026-11-03)

These come after the plan's Global Constraints. Where they disagree, the plan's Global Constraints and the build rulings win: no prettier and no formatter (black, isort, ruff format are not run), the plan's file layout, the plan's names, the plan's test framework.
"Commit and Push" and "Push your branch" below do not apply to you: the build lead commits, nobody pushes. The gates crapper and dryer run on every task, on the changed code, through the commands in the task notes. Mutator runs once, at the end of phase 1, on the riskiest pure logic with its fast tests only, by the lead: writers do not run it (Ivan's word). No chasing of coverage: the rules below on crapper are met by splitting first.
For Hornhoof that means: vitest as the tests are written today, the code style of the file you change, no new dependency unless the task names it.

## Engineering rules (ub-mode), word for word

Every time you are asked to make a change follow:
* First Make it Work.
* Then Make it Right.
* Follow Practice

### First Make it Work

#### Laziness Protocol

* One decision lives in one place.
* Ship the smallest edit that solves the problem.

#### Foundational Thinking

* Get the data shape right before you write the logic.
* Do first whatever helps every later phase.
* If a concurrent writer would matter, do not share state.

#### TDD

* Write the failing test before you change the code.
* See it fail for the reason you expect.
* Make the smallest change that makes it pass.
* If an honest test is impractical, do not write a bad one.

#### Redesign From First Principles

* Do not bolt a new requirement onto the old design.
* Ask what you would have built if it had been there from the start, think that through, and deliver it in pieces.

#### Attack the Premise

* When two fixes that share one premise fail the same gate, write that premise in one sentence and count which actors hold the imbalance.
* Remove the assignment.
* Do not start another fix until you have done that.

#### Subtract Before You Add

* Take complexity out before you add anything.

#### Outcome-Oriented Execution

* Aim at the end state you can check.
* A break in the middle is allowed when you planned it and can undo it.

#### Build the Lever

* If the work is not obvious at a glance, build the tool that does it.
* Do one unit by hand, then make the tool match that unit.

#### Architecture

##### Model the Domain

* Put the domain in a structure that makes the illegal states impossible.
* Maintain a glossary of domain terms.
* If the code is already clear and local, leave it.

##### Boundary Discipline

* Check the data where it enters.
* Inside, trust it.
* Keep the business logic in a pure function.

##### Type System Discipline

* Make the illegal value impossible to write.
* Parse outside data once, where it comes in.
* Do not silence the compiler.

##### Make Operations Idempotent

* Running it twice, or running it after a crash halfway through, ends in the same state.

##### Separate Before Serializing Shared State

* If they do not need the same mutable thing, give each its own.
* If they do, allow one writer, and enforce that in the structure.

### Then Make it Right

#### Fix Root Causes

* Reproduce it.
* Fix the cause.
* A guard that only hides the crash is not a fix.

#### Sequence work into verifiable units

* Finish one small unit and check it.
* Then start the next.

#### Test Behavior, Not Implementation

* The test calls the code the way its user does and checks the result that user would see.
* If the test would still pass when every function returned nothing, throw it out.

#### Crapper

* Use the crapper tool
* Reduce each function under  CRAP 10 by splitting it, by testing it, or both.
* Consider whether case statements are worth reducing.

#### Dryer

* Use the dryer tool to eliminate duplication that rank 0.8 or above.

#### Mutator

* Use the mutator tool
* Cover the uncovered.
* Kill the survivors.
* Delete dead code.

#### Refactoring

* Pin what the code does.
* Change the structure.
* Prove the behavior did not change.

### Practice

#### Keep a Log

* Keep a log of every action you take and the reason you took it.
* Report that log upon completion.

#### Guard the Context Window

* Keep the main thread small.
* Send the bulk elsewhere, and keep the summary.

#### Worktree Cleanup

* Find what is safe to remove, confirm nothing still in use needs it, then reclaim the disk.
* Uncommitted work waits for a decision.

#### Commit and Push

* Commit often, in small ordered commits.
* Each commit says why, what changed, and how you proved it.
* Push to the main line at the end.

### In Hornhoof

* crapper, dryer and mutator are installed on your machine. Run them from the repository root on the files your branch changed, `git diff --name-only --diff-filter=d <main line>...HEAD`: `--changed` sees only uncommitted files. Their coverage comes from the project's own test tools; install what is missing in your home folder.
* Push your branch, not the main line: the main line takes it after the gates and the CEO's approval.

## ECC typescript rules

### coding-style.md
# TypeScript/JavaScript Coding Style

> This file extends [common/coding-style.md](../common/coding-style.md) with TypeScript/JavaScript specific content.

## Types and Interfaces

Use types to make public APIs, shared models, and component props explicit, readable, and reusable.

### Public APIs

- Add parameter and return types to exported functions, shared utilities, and public class methods
- Let TypeScript infer obvious local variable types
- Extract repeated inline object shapes into named types or interfaces

```typescript
// WRONG: Exported function without explicit types
export function formatUser(user) {
  return `${user.firstName} ${user.lastName}`
}

// CORRECT: Explicit types on public APIs
interface User {
  firstName: string
  lastName: string
}

export function formatUser(user: User): string {
  return `${user.firstName} ${user.lastName}`
}
```

### Interfaces vs. Type Aliases

- Use `interface` for object shapes that may be extended or implemented
- Use `type` for unions, intersections, tuples, mapped types, and utility types
- Prefer string literal unions over `enum` unless an `enum` is required for interoperability

```typescript
interface User {
  id: string
  email: string
}

type UserRole = 'admin' | 'member'
type UserWithRole = User & {
  role: UserRole
}
```

### Avoid `any`

- Avoid `any` in application code
- Use `unknown` for external or untrusted input, then narrow it safely
- Use generics when a value's type depends on the caller

```typescript
// WRONG: any removes type safety
function getErrorMessage(error: any) {
  return error.message
}

// CORRECT: unknown forces safe narrowing
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unexpected error'
}
```

### React Props

- Define component props with a named `interface` or `type`
- Type callback props explicitly
- Do not use `React.FC` unless there is a specific reason to do so

```typescript
interface User {
  id: string
  email: string
}

interface UserCardProps {
  user: User
  onSelect: (id: string) => void
}

function UserCard({ user, onSelect }: UserCardProps) {
  return <button onClick={() => onSelect(user.id)}>{user.email}</button>
}
```

### JavaScript Files

- In `.js` and `.jsx` files, use JSDoc when types improve clarity and a TypeScript migration is not practical
- Keep JSDoc aligned with runtime behavior

```javascript
/**
 * @param {{ firstName: string, lastName: string }} user
 * @returns {string}
 */
export function formatUser(user) {
  return `${user.firstName} ${user.lastName}`
}
```

## Immutability

Use spread operator for immutable updates:

```typescript
interface User {
  id: string
  name: string
}

// WRONG: Mutation
function updateUser(user: User, name: string): User {
  user.name = name // MUTATION!
  return user
}

// CORRECT: Immutability
function updateUser(user: Readonly<User>, name: string): User {
  return {
    ...user,
    name
  }
}
```

## Error Handling

Use async/await with try-catch and narrow unknown errors safely:

```typescript
interface User {
  id: string
  email: string
}

declare function riskyOperation(userId: string): Promise<User>

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unexpected error'
}

const logger = {
  error: (message: string, error: unknown) => {
    // Replace with your production logger (for example, pino or winston).
  }
}

async function loadUser(userId: string): Promise<User> {
  try {
    const result = await riskyOperation(userId)
    return result
  } catch (error: unknown) {
    logger.error('Operation failed', error)
    throw new Error(getErrorMessage(error))
  }
}
```

## Input Validation

Use Zod for schema-based validation and infer types from the schema:

```typescript
import { z } from 'zod'

const userSchema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150)
})

type UserInput = z.infer<typeof userSchema>

const validated: UserInput = userSchema.parse(input)
```

## Console.log

- No `console.log` statements in production code
- Use proper logging libraries instead
- See hooks for automatic detection

### patterns.md
# TypeScript/JavaScript Patterns

> This file extends [common/patterns.md](../common/patterns.md) with TypeScript/JavaScript specific content.

## API Response Format

```typescript
interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  meta?: {
    total: number
    page: number
    limit: number
  }
}
```

## Custom Hooks Pattern

```typescript
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(handler)
  }, [value, delay])

  return debouncedValue
}
```

## Repository Pattern

```typescript
interface Repository<T> {
  findAll(filters?: Filters): Promise<T[]>
  findById(id: string): Promise<T | null>
  create(data: CreateDto): Promise<T>
  update(id: string, data: UpdateDto): Promise<T>
  delete(id: string): Promise<void>
}
```

### security.md
# TypeScript/JavaScript Security

> This file extends [common/security.md](../common/security.md) with TypeScript/JavaScript specific content.

## Secret Management

```typescript
// NEVER: Hardcoded secrets
const apiKey = "sk-proj-xxxxx"

// ALWAYS: Environment variables
const apiKey = process.env.API_KEY

if (!apiKey) {
  throw new Error('API_KEY not configured')
}
```

## Agent Support

- Use **security-reviewer** skill for comprehensive security audits

### testing.md
# TypeScript/JavaScript Testing

> This file extends [common/testing.md](../common/testing.md) with TypeScript/JavaScript specific content.

## E2E Testing

Use **Playwright** as the E2E testing framework for critical user flows.

## Agent Support

- **e2e-runner** - Playwright E2E testing specialist

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


# The task

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

