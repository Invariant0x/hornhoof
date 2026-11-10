You are the writer for Task A1 of 2026-11-03-network-phase-1-plan-7-backups in Hornhoof's network build. Read everything below before you start.

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

- Your lane: `/home/altera/hornhoof-network/wt/p7a1`, relay repo (`hornhoof-edge`), branch `task-p7a1`. Kind: unknown way: one acceptance test from the plan first, against the real frps and Caddy the harness starts, and change `Caddyfile` or `relay/frps.toml` only if the test finds a limit. Python standard library only, runnable on 3.12 and 3.14.
- You write Plan 7 Task A1: new `relay/test/test_big_body.py`. `Stack(tmp, caddy=True)`, `client(via='caddy')`, `https_port`, `certificates.ca` exist in `relay/test/harness.py`.
- What moved since the plan was written: its `Caddyfile:72-81` cite and others are stale. Read them fresh. `request_body`, `max_size` and `read_body` are still absent (a grep says), `vhostHTTPTimeout = 60` holds in `relay/frps.toml`. `MAX_BODY` in `relay/relay.py` is at lines 49 and 1515, and it limits the relay's own API, not a tunnel's traffic: say in your report whether it plays any part.
- The test is plain traffic: one large ordinary POST body through the local stack to a local echo. About 70 s and 300 MiB, so it runs on the test machine, by name, as the plan says. No request of any special shape, and nothing leaves the test machine. Real hornhoof.org is never touched.
- Hand-in check: name `relay.test.test_big_body` to `author-check-relay.sh`, plus any other module your change reaches. Keep the memory use of the test itself small: stream the body and hash it on both sides; do not hold 300 MiB in a Python string. Deploying anything stays David's.
- If a limit is found, say what a person restoring a backup would get before you change anything, with a Ruling line.

# The plan, from its top to the end of Review Focus (quality rules inserted after its Global Constraints)

# Network Phase 1, Plan 7: Encrypted Backups on Other Machines, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every 6 hours and before every update, the company's leading machine turns a dump of its database and the
`.env` secrets a restore needs into a bundle: sealed with age to the machines that hold the data and to the recovery
key, signed with the machine's certificate, recorded in `net.backups`. Up to three other machines of the company pull
each bundle over the peer link and keep the latest two, which they cannot open. The CEO saves the recovery file in
Settings and restores the company from a bundle any online machine holds; after a total loss, a fresh server restores
from the recovery file with the bundles a surviving machine sends it, or one uploaded in the browser.

**Architecture:** Two migrations: `0052_backups` (generated: `machines.age_key`, `keeps_backups` and `held_backups`,
and the hidden table `recovery_keys`) and `0053_net_backups` (custom: `net.backups` with plan 3's fence). The folder
`modules/backups/` holds the bundle's format (`bundle.ts`: seal, check, open, the recovery challenge), the store bundles
are kept in on disk (`store.ts`), and the app's side: the records (`records.ts`), the holders (`holders.ts`), the
recovery file (`recovery.ts`), restores (`restore.ts`), the total loss (`total-loss.ts`) and the routes (`routes.ts`).
The updater makes each dump into the control folder and swaps a restored database in, with a journal for each step
and, at the moment the old database closes, a copy of who may get in now (`carry.sql`). The data machine's keeper
(`modules/keeper/backups.ts`, `restore.ts`) seals and signs each dump, records it through its app, serves bundles on the
peer port and opens one for a restore. A worker's keeper (`modules/keeper/holder.ts`) pulls, checks and keeps bundles,
and when no leader answers for 10 minutes, challenges a new server and sends them. The web app gets the backups part of
Settings, a banner, the card's tick and the setup screen's restore.

**Tech Stack:** TypeScript on Node 22 (`node:crypto` Ed25519, `node:http2`, streams); `age-encryption` 0.3.1 (typage),
pinned already in `apps/web` and `apps/node` and now in `apps/server`; Fastify 5; drizzle-orm 0.45.4 on node-postgres
and PGlite; bash 3.2 and BusyBox for `updater.sh`; React for the web app; vitest with PGlite; Docker for `npm run
test:real` and `npm run test:lab`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.8 ("Keys", "Recovery file", "Making", "Holding",
"Restoring", "Total loss"), 3.3 ("Who may hold data"), 3.2 (the leader keeper's backups endpoint, which the `-app`
service reaches too), 3.1 (the updater's row: backups), section 10 ("Backups", "A stolen machine") and section 12
("Backups and certificates"). Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 7's entry, and its
discrepancy 15 (`SECURITY.md`'s backups).

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/home/altera/hornhoof-network/hornhoof`, in a new worktree
`/home/altera/hornhoof-network/hornhoof/.claude/worktrees/backups` on a new branch `backups` from main (`git worktree
add`, then `npm ci` there once), after plan 6 is merged into main and shipped.

**Handed over** (merged and shipped before this plan starts):
- Today's code: `apps/updater/updater.sh` (`backup`, `restore`, `applied`, `healthy`, `handle_request`, `interrupted`,
  `say`, `compose`, `env_value`, the loop that runs `handle_request` every 2 s and `computer_runs` in the background,
  `KEEP_BACKUPS`, `--once`, `HORNHOOF_HEALTH_WAIT`) and its tests (`test/updater.test.ts`, `test/updater-stubs`);
  `modules/setup/code.ts` (`setupCode`, `isSetupCode`, `setupNeeded`) and `modules/setup/routes.ts` (`setupOnly`,
  `GET /api/setup`); `modules/link/link.ts` (`linkOf`, `saveLink`, `writeTunnelSettings`, `TUNNEL_FILE`, `PublicLinks`)
  and `public_links`; `modules/nodes/routes.ts` (`LendBody`, `PATCH /api/machines/:id`, `ownMachine`, `GET
  /api/machines`); `modules/nodes/disconnect.ts` (`disconnectMachines`); `people.status`, `people.is_owner`,
  `sessions`; `nodes.status` (`needs_login`); `encryptSecret`, `decryptSecret`; `db/client.ts` (`MIGRATIONS`);
  `config.secret` (32 bytes), `config.relayUrl`, `config.controlDir`; `modules/updates/control.ts` (`UpdaterControl`,
  `status`, `request`) and `modules/updates/routes.ts` (`POST /api/updates`, `sendWhenIdle`, `send`); in `apps/web`
  `screens/Settings.tsx` (the dialog titled "Share access", `t.settings`), `screens/Setup.tsx`, `screens/Machines.tsx`
  (`LendSetting`), `screens/Shell.tsx` (`AccountMenu`, `onSettings`), `api.ts`; `apps/node/src/keys.ts`
  (`nodeIdentity`, the way a key file is made); `SECURITY.md`, `README.md`, `guide/`.
- Plan 1b: `linkMode`, the tunnel settings' `mode` (`http` until the company holds a certificate).
- Plan 2: `updaterBusy(dir)` and `AppMode`; the keeper's link child, whose `read` is `tunnelSettings(db, config)`;
  `TunnelKeeper`; compose's `keeper` service and `compose.test.ts`'s exact list of its environment keys.
- Plan 3: the schemas `net` and `net_local`, `net.fence_check()`, the `net_fence` trigger and `problems()` (`net.<table>
  has no fence trigger`); `net_local.state` (`term_number`, `cluster`) and `net_local.lease`; `LeaseStore.take` (the
  highest of the state's and the lease's numbers, plus one); `HIDDEN`, `CLOSED`, `migrateDb`, `AFTER_MIGRATIONS`; the
  test fixture's endless lease (`createTestSql`, `openTestDb`); `npm run test:real` with `realDatabase()`
  (`test/real/pg.ts`) on Postgres 17.11.
- Plan 5: `modules/network/authority.ts` (`makeAuthority`, `issueCertificate`, `certFacts`, `CertFacts`, `issuedBy`,
  `Authority`), `store.ts` (`authorityOf`, `findThisMachine`, `thisMachine`, which retires and revokes every other
  `server:` row), `via.ts` (`askerOf`, `OWN_VIA`); `certificates`; `POST /api/network/report`; the keeper's
  `KEEPER_DIR`, `machineKey`, `MachineKey`, `HeldCertificate`, `CertificateKeeper`, `Measures` (`diskFree` of the
  keeper's volume); `net/peer-server.ts` (`PeerServer`, `PeerServerOptions`, `PEER_PATHS`, `Peer`), listening as
  `peer` on 7070 and as `app` on 7071, which the `-app` stcp service reaches.
- Plan 5b: `keeperAsker` and the keeper's mark; `PeerLink` (`use`, `leader`, `request`, HTTP/2 sessions with a 1 MiB
  window); `WorkerKeeper`, `WorkerConfig`, `workerConfig`, the worker's report and its `peers.json` view (`data`,
  `link.url`); `onlineShare`; `machines.network_id`, `role`, `addresses`, `disk_free`, `report_at`; `revokeMachineRows`
  in Disconnect; compose's `compose.worker.yaml` and `${VAR:-}` rule; `updater.sh`'s worker mode; the lab
  (`apps/server/test/lab/lab.ts`, `Lab`, `LabMachine`, `join.test.ts`, `npm run test:lab`).
- Plan 6: migration `0051_computer_access` (`machine_access`, `computer_runs` and its state `lost`); `GET
  /api/machines`'s `core`.
- Where main's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys, certificates and recovery files made at run time.
- One npm dependency more: `age-encryption` 0.3.1 in `apps/server`, the version `apps/web` and `apps/node` pin, so
  the lockfile gains no new package. Two new migrations, never an edit of an older one: `0052_backups` by `npx
  drizzle-kit generate --name backups`, then `0053_net_backups` by `npx drizzle-kit generate --custom --name
  net_backups`, both from `apps/server`.
- No private key ever leaves the machine that made it: a machine's age key and Ed25519 key stay in its keeper's volume;
  the recovery identity exists only in the file the CEO saves and, while a restore needs it, in the memory of the app
  and of the data keeper, and nowhere else. It crosses only the keeper's own request to its app (`GET
  /api/network/backups`, whose request and answer are never logged), the keeper drops it when the order ends or is
  called off, and it is never written into `/control/restore`, a status or a log line. None of them goes into the
  database, a bundle, a log line or a file of the control folder.
- No plaintext dump stays anywhere but on a data machine: a dump in the control folder is sealed and deleted, or
  deleted after a day; a worker only ever holds sealed bundles. Today's plaintext dump before an update stays in
  `backups/` on the server, as the spec allows. A restore's carry (ruling 14) holds password hashes: it is 0600 in the
  server's control folder and removed once applied.
- The age library's errors can quote the key they were given: none reaches a log, an answer or a thrown error's
  message; each is replaced by a fixed message without its cause.
- Ivan's rules: only a machine's owner opens computer access to it (plan 6, unchanged); no step of this plan asks Ivan
  to type a command. Everything Ivan does here is a click: saving the recovery file, a restore, a tick.
- Messages between keepers and the app change only by additions; a keeper one version apart keeps working (ruling 18).
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; `npm run test:real` and `npm run test:lab` need Docker. Types, from the worktree root: `npx tsc
  -p apps/server/tsconfig.json --noEmit`, and `apps/web` likewise when touched, each printing nothing. `bash -n` and
  `shellcheck` on `apps/updater/updater.sh` print nothing when it is touched. Never run prettier.


# Quality rules (from the team lead, 2026-11-03)

These come after the plan's Global Constraints. Where they disagree, the plan's Global Constraints and the build rulings win: no prettier and no formatter (black, isort, ruff format are not run), the plan's file layout, the plan's names, the plan's test framework.
"Commit and Push" and "Push your branch" below do not apply to you: the build lead commits, nobody pushes. The gates crapper and dryer run on every task, on the changed code, through the commands in the task notes. Mutator runs once, at the end of phase 1, on the riskiest pure logic with its fast tests only, by the lead: writers do not run it (Ivan's word). No chasing of coverage: the rules below on crapper are met by splitting first.
For the relay that means: Python standard library only (no dotenv, no pytest: tests are `unittest`), runnable on Python 3.12; type annotations on new function signatures where the code around does so. fastapi.md applies to no file here.

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

## ECC python rules

### coding-style.md
# Python Coding Style

> This file extends [common/coding-style.md](../common/coding-style.md) with Python specific content.

## Standards

- Follow **PEP 8** conventions
- Use **type annotations** on all function signatures

## Immutability

Prefer immutable data structures:

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class User:
    name: str
    email: str

from typing import NamedTuple

class Point(NamedTuple):
    x: float
    y: float
```

## Formatting

- **black** for code formatting
- **isort** for import sorting
- **ruff** for linting

## Reference


### fastapi.md
# FastAPI Rules

Use these rules for FastAPI projects alongside the general Python rules.

## Structure

- Put app construction in `create_app()`.
- Keep routers thin; move persistence and business behavior into services or CRUD helpers.
- Keep request schemas, update schemas, and response schemas separate.
- Keep database sessions and auth in dependencies.

## Async

- Use `async def` for endpoints that perform I/O.
- Use async database and HTTP clients from async endpoints.
- Do not call `requests`, sync SQLAlchemy sessions, or blocking file/network operations from async routes.

## Dependency Injection

```python
@router.get("/users/{user_id}")
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ...
```

Do not create `SessionLocal()` or long-lived clients inside route handlers.

## Schemas

- Never include passwords, password hashes, access tokens, refresh tokens, or internal auth state in response models.
- Use `response_model` on endpoints that return application data.
- Use field constraints instead of hand-written validation when Pydantic can express the rule.

## Security

- Keep CORS origins environment-specific.
- Do not combine wildcard origins with credentialed CORS.
- Validate JWT expiry, issuer, audience, and algorithm.
- Rate-limit auth and write-heavy endpoints.
- Redact credentials, cookies, authorization headers, and tokens from logs.

## Testing

- Override the exact dependency used by `Depends`.
- Clear `app.dependency_overrides` after tests.
- Prefer async test clients for async applications.


### patterns.md
# Python Patterns

> This file extends [common/patterns.md](../common/patterns.md) with Python specific content.

## Protocol (Duck Typing)

```python
from typing import Protocol

class Repository(Protocol):
    def find_by_id(self, id: str) -> dict | None: ...
    def save(self, entity: dict) -> dict: ...
```

## Dataclasses as DTOs

```python
from dataclasses import dataclass

@dataclass
class CreateUserRequest:
    name: str
    email: str
    age: int | None = None
```

## Context Managers & Generators

- Use context managers (`with` statement) for resource management
- Use generators for lazy evaluation and memory-efficient iteration

## Reference


### security.md
# Python Security

> This file extends [common/security.md](../common/security.md) with Python specific content.

## Secret Management

```python
import os
from dotenv import load_dotenv

load_dotenv()

api_key = os.environ["OPENAI_API_KEY"]  # Raises KeyError if missing
```

## Security Scanning

- Use **bandit** for static security analysis:
  ```bash
  bandit -r src/
  ```

## Reference


### testing.md
# Python Testing

> This file extends [common/testing.md](../common/testing.md) with Python specific content.

## Framework

Use **pytest** as the testing framework.

## Coverage

```bash
pytest --cov=src --cov-report=term-missing
```

## Test Organization

Use `pytest.mark` for test categorization:

```python
import pytest

@pytest.mark.unit
def test_calculate_total():
    ...

@pytest.mark.integration
def test_database_connection():
    ...
```

## Reference


## Rulings made while planning

1. **One plan, in the order a bundle travels.** Making, holding, the recovery file, restoring and the total loss are
   one chain that only works whole, and each task below ends in something a reviewer can reject alone, so the plan is
   not split. Left to later plans: fork dumps (spec section 5) are plan 8's, and so is merging the database a restore
   sets aside; copies, and with them more recipients, a recovery pair renewed when a machine loses whole-company scope,
   "Debian leads; restore there" and taking the name with no leader, are plan 9's, the first plan with a second data
   machine.
2. **Each machine's age key is its keeper's.** Plan 5's ruling 4 left it here. Every keeper, the data machine's and a
   worker's, makes an X25519 key for age in its volume (`age.key`, mode 0600, as the node makes its own today) and
   reports the public half, which the app keeps as `machines.age_key`. A keeper that loses its volume, or finds a key
   that does not decode whole, makes a new one; bundles sealed to the old key then open only with the recovery file.
3. **Bundles are sealed to the machines that hold the data, and to the recovery key.** The spec says "every machine
   that may hold data (3.3)". This plan reads that as the live rows of the role `data`: the leader now, its copies
   from plan 9. A CEO's worker that could take a copy is not a recipient while it is a worker: plan 5b's rule is that a
   worker holds no company secret, the spec's section 12 that a holder cannot decrypt, and a worker may be a holder.
   (Deviation to rule on.) The leader's own key is always among them, also before its row has it.
4. **The bundle.** One file, three parts, so it travels as one stream and is checked before it is opened:
   - the line `hornhoof-bundle v1`;
   - the head, one JSON line `{ "manifest": "<text>", "signature": "<base64url>", "certPem": "<PEM>" }`, at most 64 KiB.
     `manifest` is the exact text signed: the JSON `{ v: 1, id, company, dumpedAt, madeAt, reason, size, sha256,
     recipients, recovery, recoveryLink, migrations, signer, serial }`, where `dumpedAt` is the dump's time, the
     moment a restore brings the company back to, `madeAt` the time it was sealed and signed, `reason` `timer` or
     `update`, `size` and `sha256` are of the age part, `recipients` the age keys it is sealed to, `recovery` the
     recovery key among them or null, `recoveryLink` the `{ name, url }` of the link that key was saved with or null
     (a survivor's challenge needs that name, ruling 16), `migrations` the count the dumped database had applied,
     `signer` the signing machine's row and `serial` its certificate's. The signature is Ed25519 by the machine's key
     over `hornhoof-bundle-manifest v1\n` and the text;
   - the age part, whose plaintext is the line `hornhoof-bundle-content v1`, a JSON line `{ id, company, secrets: {
     HORNHOOF_SECRET, NODE_KEY, RELAY_URL } }` and the gzipped `pg_dump`. Not `POSTGRES_PASSWORD`, and no private key.
   On disk a store keeps `<id>.head` and `<id>.age`. It takes each transfer into a temporary file of its own, stops
   it as soon as it passes the signed size, with too little free disk or after 30 s without a byte, and publishes a
   bundle once: what it published is never written again, and a restore hashes the stored file again before opening
   it. A check, before anything is opened: the head parses; the
   certificate is `issuedBy` the company's authority, names the role `data` and the manifest's `signer` and `serial`,
   and its `notBefore` and `notAfter` hold `madeAt`, so a later expiry does not matter (a dump sealed after an update is
   signed with the certificate its keeper holds then, which may be newer than the dump); the signature verifies with the
   certificate's key; `company` is the company; the age part's size and SHA-256 are the manifest's. Opening checks the
   content's line and that its `id` and `company` are the manifest's, so an age part moved under another head is
   refused.
5. **The updater dumps; the keeper seals, signs and records.** The keeper holds the signing key and the age key, and
   only the updater reaches `pg_dump` (in `db`), so: the data keeper writes `/control/dump.json` `{ id }`; the
   updater (root) dumps to `/control/dumps/<id>.sql.gz` with `<id>.json` `{ id, reason, at, migrations }`, or
   `<id>.failed`, and then removes `dump.json`. The folder `dumps/` is 0700 and every file in it 0600, all given to
   the control folder's owner, which is the keeper's user, so the keeper reads and deletes what root wrote. After its
   own dump before an update, the updater puts a copy there too, with the reason `update`. The keeper seals each dump
   it finds there to the recipients its app names, writes the bundle into its store, records it (`POST
   /api/network/backups`), and deletes the dump; a dump whose id its store holds already is deleted unsealed, and a
   dump not sealed within a day is deleted, whether its app answers or not. A timer bundle is due 6 hours after the
   newest in `net.backups`, at once when there is none, and at once when the recovery key changed since the newest, so
   a new recovery file soon has a bundle. One dump at a time: no new `dump.json` while one is there or a dump waits to
   be sealed, and at most one per 10 minutes, but for the first dump after a new recovery key. The keeper keeps its own
   latest 2. It makes nothing while its app does not lead, or without a data certificate.
6. **`net.backups` is written by the app, on its own keeper's word.** The table is in `net`, with the `net_fence`
   trigger, out of the agents' reach (plan 3). The record route takes only the data keeper's own request: the head
   must check (ruling 4) against the database's authority, its signer must be this machine's live row with the role
   `data` and its serial a live certificate of that row, and `madeAt` within a day of now. So no worker records a
   bundle, and a restore with a database left checks a bundle against its row.
7. **Holders are picked per bundle.** For each bundle with a recovery key, the app picks up to 3: live rows with a role
   but `data`, `keeps_backups` on, an active owner, a report within 2 minutes and `disk_free` at least 3 times the
   bundle; first those that share a `/24` with the leader's addresses, then by `onlineShare`, then by free disk. One
   place is off site: when none of the picks is outside the leader's `/24` and a machine outside it qualifies, the best
   such one takes the last place, so a home lost to fire, theft or flood does not take every copy with it; with none
   outside, all three are at home. The picks are kept on the bundle's row. Every hour the newest 2 such bundles are
   looked at again, and a holder that was ticked off, disconnected, or has not reported for a day gives its place to the
   next. A bundle without a recovery key gets no holder: until the first save the bundles stay on the data machine
   (spec), since no one could open them once it is lost.
8. **The backups endpoint is the leader keeper's, on both of its peer listeners.** `GET /peer/backups/<id>` streams a
   bundle to a machine the app picked for it, and `PUT /peer/backups/<id>` takes one from a holder the app asked for it
   (ruling 12); every other machine gets 403. On 7070 and on 7071, so a worker on the relay reaches it too (spec 3.2).
   The holder pulls; nothing is pushed into a worker.
9. **A holder keeps what it can still use.** Every minute while it has a leader, a worker's keeper asks its app which
   bundles to hold, fetches what it lacks into its volume, and checks each against the authority it holds. It deletes
   a bundle only when the answer names at least one bundle, it holds every one named complete, and the one it deletes
   is not named and older than the newest it holds of them; or when its owner unticked "Keep company backups" (the
   answer's `keeps` false). So an empty answer, as a restored database gives before its first new bundle, deletes
   nothing, and without an answer it deletes nothing either: a holder keeps its bundles through a total loss. It
   fetches only with 3 times the bundle free, and reports what it holds.
10. **The recovery file.** "Save the recovery file", by the CEO on his own session while the app leads: the app makes an
    age key pair and answers the file once, `no-store`. The file is a comment line, then one JSON line `{ v: 1, kind:
    'hornhoof-recovery', company, companyName, identity, recipient, madeAt, link, authorityPem }`, `link` being the
    tunnel settings (`url`, `name`, `key`, `tunnel`) or null. The app keeps only the public half, in `recovery_keys`
    with the print, name and url of the link it was saved with. The newest key whose print matches the link now is the
    company's recovery key; a save retires the older ones, and the screen says the old file opens only older bundles.
    When the link changes (taken, renamed, removed, or its key changed by a later plan), the key no longer matches:
    later bundles are sealed without it and a banner asks for a new file. Losing whole-company scope renews nothing in
    this plan: no machine but the server holds data before plan 9, which renews the pair with the role change.
    (Deviation to rule on: the spec renews it on a lost scope too.)
11. **Settings.** The dialog the account menu opens as "Share access" becomes "Settings" (`Настройки`), with its link
    part as today and, for the CEO alone, a part "Backups": the last bundle's time, the recovery file, the bundles and
    where they are held, and "Restore". A banner for the CEO asks for the recovery file while there is none. Each
    card of a machine with a core but the server's has the tick "Keep company backups", which its owner or a person
    who sees the whole company changes, as "Lend to test runs".
12. **Restore from a backup runs on the leader, by its keeper and its updater.** The CEO picks a bundle that the
    leader's keeper or an online holder holds. The warning names what the restore undoes: everything after its time
    stays in the database it replaces, which is kept on this machine until plan 8 merges it; machines that joined and
    people added after it are not in it. The keeper gets the bundle (from its store, or from the holder, which the app
    asks to send it), checks it, with the database's `net.backups` row too, and opens it with its own age key, or with a
    recovery file the CEO adds in the dialog, held in the memory of the app and of its keeper for an hour at most
    (Global Constraints). It writes the dump and the secrets into `/control/restore/` and asks the updater, which swaps
    the databases (ruling 13). A bundle made by a newer build than this one (more migrations than it knows) is refused:
    "Update first." Each restore is an attempt with its own id, so a failed one can be tried again with the same bundle.
    Restores and updates share one claim on the updater, taken before anything else is checked: a restore is refused
    while an update is out, also while it waits for idle or sits in `request.json`, and an Update while a restore is
    out.
13. **The swap.** The updater stops `app` and `node` and loads the dump into `hornhoof_restore` as `restore()` does
    today (a failed load changes nothing). Before each change after that it writes a journal
    (`/control/restore-journal.json`: the attempt, the stamp and the last change made), so an updater restarted at any
    point puts everything back from it. It checks the secrets and saves `.env` as `backups/env-before-<stamp>` before
    anything is switched. Then, in one session on `hornhoof`, it turns its connections off, ends every other session
    and waits until none is left (10 s at most, else nothing changed), and reads the highest term number of its state
    and lease, its `machine` and `cluster`, and the carry (ruling 14): nothing can change them after that. The restored
    state takes that `machine`, `cluster` and a term number no lower, and an empty lease. It renames `hornhoof` to
    `hornhoof_before_<stamp>` (connections stay off), the restored one to `hornhoof`, writes the bundle's three secrets
    into `.env`, and only then marks the step `start`: a status at `start` means the swap is committed. It starts every
    service but `db` and `updater` again; when the company answers within `HORNHOOF_HEALTH_WAIT`, the restore is
    `done`, also when the updater was restarted at `start`; else it puts the old database and `.env` back, and only
    then writes `failed`. The plaintext files go in every outcome. The keeper shows the maintenance page meanwhile:
    `updaterBusy` is also true while `restore-status.json` says `running` at a step of the updater's.
14. **A restore keeps who may get in now.** Until plan 8 merges, the restored database would bring back a machine
    disconnected, a person disabled, a password reset, a scope narrowed or a recovery file replaced after the bundle.
    So the updater takes the carry from the old database at the moment it closes (ruling 13), with `carry.sql`: every
    person's status, password hash, scope, `is_owner` and access; the invites open now; each machine's revocation and
    its owner's ticks; the revoked serials; the recovery keys. Once the swap is committed, the app applies it at its
    first lead to everyone and everything both databases have, closes computer access on every machine (its owner
    opens it again, plan 6), marks every computer command not done `lost`, and ends every session, so everyone signs
    in again; until then every route but `/api/health` answers 503. A restore from a recovery file has no database to
    take this from. (An addition to rule on.)
15. **Total loss.** A fresh `install.sh server`'s setup screen offers "Restore from a recovery file", guarded by the
    setup code as setup is. The app keeps the file in memory and writes its link to `/control/recovery-link.json`, which
    the keeper's link child uses, in `http` mode, while the database has no link; the relay hands the name over once the
    old route is gone (plan 1, R1.1 and R3.1). It takes a challenge (`POST /api/recovery/challenge`, at most 1 KiB):
    only when the age file opens with the recovery identity and its plaintext is exactly
    `hornhoof-recovery-challenge v1`, the link name and a 32-byte nonce, line by line, does it answer, and then with a
    proof made from the nonce (an HMAC keyed by it), never the nonce; anything else is refused before or after
    opening, so a bundle never passes as a challenge. Each bundle sent after it carries a second proof made from the
    nonce and that bundle's id, so the relay, which sees both proofs, can neither learn the nonce nor send another
    bundle with them; a challenge sent again keeps its first hour. It takes bundles with such a proof, for an hour, or
    with the setup code from the browser, each checked against the file's authority, company and recovery key, two at a
    time at most and each within the bounds of ruling 4. The CEO picks one, and the keeper and the updater restore it
    as in rulings 12 and 13, without the `net.backups` check, which needs a database. A plan whose sign-in was only on
    a lost machine is signed in again on a machine that is on, under Subscriptions, as a new plan is; the last screen
    says so in one line rather than listing them. (Deviation to rule on: the spec has the restore screen list them.)
16. **Survivors.** A worker's keeper that holds bundles with a recovery key and has had no leader for 10 minutes
    challenges, every 5 minutes, the url of the link that key was saved with (the manifest's `recoveryLink`), its
    cached link's `url` when another, its join server, then each data machine's web address from its view: a new
    server at the old address is found without a link too. The challenge carries the manifest's link name, so a link
    renamed or removed since does not stop it. When one answers with the right proof, it sends that server every
    bundle it holds for that recovery key, newest first, and remembers the target for that key: later rounds send it
    only bundles it has not sent yet, and challenge it again after 50 minutes. A send that moves no byte for 30 s is
    cut, and the next target is tried. Each challenge is one log line with the target and how it ended, never a nonce
    or a proof. After the restore it renews as plan 5b says (its row is in the bundle) and finds the new leader. The
    lab shortens the 10 minutes by the keeper's `HORNHOOF_SURVIVOR_S`, as it shortens other waits.
17. **What phase 1 leaves open.** (Deviations to rule on, each with its reason.) a) Machines that joined after the
    bundle's time are not in the restored database. Their keepers' renewals get plan 5b's unsigned 404, which they do
    not take as a disconnection, so they keep trying and do nothing for the company; their cards are gone from
    Machines, and their owners join them again with a new command from the Machines tab. A signed answer for a machine
    the database does not know comes with plan 8's merge. The warning names them. b) A restore from a recovery file
    cannot carry what was taken away after the bundle (ruling 14); the Machines tab shows every machine of the
    restored company, and the CEO disconnects one he lost. With no database, such a restore also trusts any bundle a
    data certificate of the authority signed while valid at its `madeAt`: a data machine's old signing key, if
    stolen, could sign a backdated one; with a database, the recorded hash closes that. c) Without a public link, a
    new server is found only at an old address (ruling 16). d) Nothing downloads a bundle to the browser, since the
    bundles sit in the keeper's volume and the app has no stream from it: the survivors are the way that needs only
    clicks, and the upload is for a bundle copied off a machine some other way. e) A bundle a survivor sends through
    hornhoof.org crosses the relay as one long request body; the lab has no relay, so Task 11's review reads plan 1's
    Caddy and relay settings for a body limit or timeout below a bundle's size, and stops the merge when it finds one;
    a survivor cut off there goes on to the old addresses.
18. **One version apart.** Workers follow the leader's build (plan 5b), so a holder is newer than its leader only
    while it follows an Update back, and a worker before this plan neither asks nor holds. The report's new fields are
    optional; a keeper that gets 400 from a report sends it again without them. Routes this plan adds answer 404 on an
    older app, which keepers take as "nothing to do", deleting nothing. The first update to this build is run by plan
    6's updater, which makes no bundle before it; from then on every update has one.
19. **The texts.** `SECURITY.md`'s backup lines (written ahead, overview discrepancy 15) and `README.md`'s become
    exact: the machines that hold the data and the recovery file open a bundle; the dump before an update stays
    unencrypted on the server, which holds the database anyway. `guide/backups.md` tells where each click is.

## Review Focus

1. A bundle that must not be restored: an age part swapped under another head, a head with another signature, a
   bundle a worker signed, a certificate not valid at `madeAt` or of another authority, another company's bundle, one
   with no `net.backups` row or another hash while a database is there, one made by a newer build, a challenge file
   offered as a bundle, a second upload of the same id racing the first, a body longer than its signed size. Each is
   refused before anything is opened or written to `.env`. Tests in Task 2 (`refuses what it must not open`, `takes
   each bundle once, whole`), Task 7 (`restores only a bundle its database knows`) and Task 8 (`takes only bundles of
   its recovery key`).
2. Anything but a recipient reading a bundle: a holder's own age key, the app's database, a log line, an error's
   message, the control folder. A worker's key is never a recipient; no plaintext dump is left in `/control/dumps`
   after sealing or after a day, nor in `/control/restore` after a keeper restart; the recovery identity is never
   stored and lives only in the memory of the app and the data keeper. Tests in Task 2 (`a holder cannot open it`,
   `never shows a key it cannot read`), Task 3 (`seals only to data machines`), Task 5 (`leaves no plaintext dump`),
   Task 7 (`leaves nothing open after a restart`, `keeps the recovery identity in memory only`, `hands the identity
   over without logging it`) and Task 8 (`keeps the recovery file in memory only`).
3. A restore that fails half way: a dump that does not load, a session that does not end, a rename that fails, a
   value `.env` cannot hold, a new company that does not answer, the updater restarted at each change, an Update asked
   meanwhile. The company comes back as it was, with its `.env`, and says so; or, once committed, stays restored and
   says so. Tests in Task 4 (`puts the old database back when the restored one does not answer`, `goes back from
   every change it was stopped at`, `keeps a committed restore that answers`) and Task 7 (`one restore or update at a
   time`).
4. A holder that loses its last bundles it could restore from: its leader gone, an empty answer after a restore, a
   new bundle without a recovery key, its disk short, a download cut half way. It keeps what it had. Tests in Task 6
   (`keeps its bundles without an answer`, `keeps its bundles through an empty answer`, `deletes only after the new
   ones are complete`).
5. The total loss's doors: a challenge with another string, link name or size, a proof used after an hour or for
   another bundle, a challenge or upload replayed by the relay, an upload without a proof or code, any recovery route
   once a company exists. Each is refused and writes nothing. Tests in Task 8 (`answers only its own challenge`,
   `gives the relay nothing to reuse`, `closes once a company exists`).
6. A restore bringing back a disconnected machine, a disabled person, an old password, a wider scope, a replaced
   recovery file or open computer access. Tests in Task 4 (`takes the carry when the old database closes`) and Task 7
   (`keeps who may get in now`).

---


# The task

### Task A1: A bundle's size and time through the relay

**Repo:** relay repo, branch `main`. **Starts from:** plan 1's Task 9 committed. **Done when:** `python3 -m unittest
relay/test/test_big_body.py -v` passes on Python 3.12 and 3.14, then `python3 -m unittest discover -s relay/test -v`.

**Files (relay repo):**
- Create: `relay/test/test_big_body.py`
- Modify, only if the test finds a limit: `Caddyfile`, `relay/frps.toml`

**Interfaces:**
- Consumes: plan 1's `Stack(tmp, caddy=True)`, `Stack.client(..., via='caddy')`, the public https port and its test
  CA.
- The way a survivor's `PUT` goes while a recovering machine's link is in `http` mode (ruling 15): frps on 443, the
  edge client, Caddy, frps's vhost port, the company's frpc.

- [ ] **Step 1: Write the tests**:
  - `test_long_upload_reaches_the_company`, on `Stack(tmp, caddy=True)` with a client in http mode holding `acme`,
    whose local port is a backend of the test's that reads a request's whole body as it comes, hashes it and answers
    201 with its size and SHA-256: over TLS to the public port with the name `acme.hornhoof.org`, a chunked `PUT` of
    314572800 bytes (300 MiB) in chunks of 1 MiB, paced to last at least 70 s, so past `vhostHTTPTimeout`: the answer
    is 201, its size and hash are what was sent, and at least 65 s passed.
  - `test_no_body_limit_is_set`: the repo's `Caddyfile` holds none of `request_body`, `max_size`, `read_body`;
    `relay/frps.toml`'s `vhostHTTPTimeout` is at least 60.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_big_body.py -v`. It pins what is there, so expect PASS.
  Watch it fail once: add `request_body { max_size 100MB }` to the name's block in the rendered test Caddyfile by
  hand: the first test fails with 413, the second too in the repo's file. Take it out.
- [ ] **Step 3: If it fails with nothing added,** lift the limit in `Caddyfile` or `relay/frps.toml` until it passes,
  and write the setting and why in the commit; plan 13's Task 14 deploys it.
- [ ] **Step 4: Commit** (`commit -s`) "Test that a large, slow upload reaches a company through the relay".
