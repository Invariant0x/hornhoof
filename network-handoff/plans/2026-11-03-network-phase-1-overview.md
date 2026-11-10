# Network phase 1: overview and order of plans

Status: plan of plans, 2026-11-03. Nothing here is built.
Spec: `notes/specs/2026-11-02-single-network-design.md` (sections 3 to 10, phases in 11, tests in 12).
Model: `notes/plans/2026-11-02-step0-plans-anywhere.md` (Step 0, merged as 8de55ce and 1f51233).
Code read: main at 04bec1d. Relay read: `~/.hornhoof-edge/droplet/relay/` (relay.py, frps.toml, setup-relay.sh) and
`notes/ops/hornhoof-org.md` in the main checkout.

## Rules every plan keeps

- The network series (plans 1 to 13, on the `network` branch in its worktree) merges into main once, at its end,
  after its rehearsal; no plan merges alone. Each plan ends green
  (`VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000` from the repo root, plus `tsc` for each app it
  touched) and leaves a one-machine install working as today: same localhost port, same public link, same data, same
  Update button.
- A plan that changes what runs on a machine ships through the Update flow (`apps/updater/updater.sh:257-263` runs the
  new build's `install.sh`), with rollback to the build before it. No plan asks Ivan to type a command, except the one
  join command the spec allows (section 9, plan-node-only machines).
- At the series' merge its migrations are numbered again, after main's newest. Drizzle skips a migration whose journal
  `when` is not above the last one applied, so every network migration, not only the last, gets a `when` above that of
  main's newest migration at that moment (on 2026-11-03 main's `0046_turn_failures`, 1793700000000, 2026-11-03 10:00
  UTC).
- Network behavior turns on only when a second machine joins. Until then the keeper runs the one-data-machine rules
  (3.4 "One data machine").
- Keeper messages and node messages stay readable across one version (section 9, step 11).
- Tests that need Docker (Pebble from plan 1b, real Postgres 17.11 pairs from plan 3, the lab) run as
  `npm run test:real`, which CI runs on every push and each network plan runs before it merges (decision 2). `npm test`
  and the PGlite suite stay as fast as today. The relay's tests run real frps, frpc and Caddy binaries in the
  `hornhoof-edge` repository and need no Docker.
- Relay deploys follow decision 4: at most one relay restart per deploy, between 03:00 and 05:00 at UTC-3, and only
  while no company's link carries traffic.
- Steps the team lead runs, never a plan's executor: pushing `hornhoof-edge` to GitHub; every relay deploy, at night
  (decision 4); a check that hornhoof.org's CAA records, if any, allow `letsencrypt.org`, before plan 1b ships; Let's
  Encrypt's rate-limit adjustment form when new links near 30 a week; the Public Suffix List request once Hornhoof
  serves thousands of companies (the TLS section says why not before).
- The lab of section 12 grows with the plans: plan 1 brings the local frps with the contract, plan 5 the
  Docker-in-Docker machines, plan 9 the writer and checker of confirmed writes. Plan 13 runs it all.

## The real order

Each plan's own first task names what it starts from, and those lines make one chain; it satisfies every "Depends on"
below. "Main with plan N merged" in a plan means plan N's last task committed on the `network` branch, since the series
merges once, at its end.

| # | Plan | Starts from |
|---|------|-------------|
| 1 | 1 relay contract | nothing |
| 2 | 1b company certificate | plan 1 |
| 3 | 2 keeper and front | plan 1b |
| 4 | 3 fences and journal | plan 2 |
| 5 | 4 work survives restart | plan 3 |
| 6 | 5 authority and peer link | plan 4 |
| 7 | 5b machines join | plan 5 |
| 8 | 6 computer access | plan 5b |
| 9 | 7 backups | plan 6 |
| 10 | 8 merge | plan 7 |
| 11 | 9 copies | plan 8 |
| 12 | 9b server order | plan 9 |
| 13 | 9c planned switch | plan 9b |
| 14 | 10 takeover | plan 9c |
| 15 | 11 splits | plan 10 |
| 16 | 11b the work | plan 11 |
| 17 | 13 lab and real tests | plan 11b |

## The plans, in order

Each line: scope (spec sections), depends on, what the owner sees when it lands, risk.

### 1. The relay contract

- Scope: 3.4 "The relay contract" R1 to R5; section 10's "change key" call (as R6); 3.2 path 2 at the relay side
  (stcp services allowed per name); 3.4 "Without a public link" (a hidden name is an ordinary random binding); the
  relay half of section 12's second bullet. The relay's code gets its own repository, `hornhoof-edge`, set up from
  day one as a public open-source project with no private detail in it (decision 1), and tests against a real frps
  0.71.1; the fake relay in `apps/server/test/fake-relay.ts` speaks the same contract; Hornhoof's `Relay` client
  (`apps/server/src/modules/link/relay.ts`) gains `route`, `setSync`, `health`, `changeKey` and `visitorKey`, read
  fail-closed. Visitor keys are new (R6.2): workers hold no link key (section 10) but must log in to frps to reach the
  stcp `app` service. A blocked name restarts nothing, and a freed name is not bound again while its old tunnel lives
  (decision 3, R1.5). The relay half of "Our own TLS on the public link" (section below): frps takes port 443 and
  routes by the TLS server name, Caddy moves behind it on loopback through the droplet's own `edge` client, the plugin
  takes a company's `https` proxy (one route per name across both kinds), refuses each new connection to a blocked or
  freed name, and health says `passthrough`. The relay's tests grow a real Caddy.
- Depends on: nothing.
- Owner sees: nothing new. Links keep working; the relay's tunnel server restarts once at deploy, at night and while
  links are quiet (every link drops for a few seconds). Today's tunnels, with their old frpc settings, keep working
  unchanged, in http mode, through Caddy as before.
- Risk: high. The relay carries every company's link and now hornhoof.org itself on a new path: a plugin bug that
  refuses logins or connections takes every link down, and a Caddy or edge client fault takes the stub, the API and the
  tunnels' entry with it. Covered by tests against the real frps and Caddy, a deploy that keeps the old files for a
  one-command rollback, and checks of hornhoof.org and Ivan's link after the deploy.

### 1b. The company's own certificate

- Scope: the company half of "Our own TLS on the public link": an ACME client in the app (HTTP-01 through the tunnel,
  one Let's Encrypt account per company, renewal at ARI's window, an hour's backoff after a failure); certificate and
  key in the database, the key under `HORNHOOF_SECRET` as the link key is; a TLS listener on a port inside the
  company's network that reads the PROXY v2 header and serves the certificate (a self-signed stand-in until it
  exists); the link frpc moves from `http` to `https` with `proxyProtocolVersion = "v2"` once the relay's health says
  `passthrough` and the certificate is in, and stays on `http` otherwise. The mitigations for public names: nothing
  before sign-in names the company (pinned by a test), `/api/version` needs a session over the link and `/api/health`
  gives `{ok}` there, `X-Robots-Tag: noindex, nofollow` and a `robots.txt`, a sign-in limit per address across emails,
  failed sign-ins counted in the database so a restart does not reset them, the `__Host-` session cookie on the link.
  `SECURITY.md:53` rewritten. Adds `npm run test:real` and its CI job (decision 2), for the ACME tests against Pebble,
  Let's Encrypt's test server, in Docker.
- Depends on: 1, deployed.
- Owner sees: after one Update, the same link; the browser's lock shows a certificate for the company's own name;
  Settings says "Encrypted to this machine" ("Зашифровано до этой машины"); a new company's link shows in setup once
  its certificate is in, under a minute.
- Risk: medium. A certificate that fails to renew takes the link down: renewal starts at ARI's window, weeks ahead, and
  the Machines tab warns 14 days before expiry. Covered by Pebble tests and a switch back to `http` if the relay stops
  saying `passthrough`.

### 2. Keeper and front on one machine

- Scope: 3.1 (`front` and `keeper` entry points in the app image, the keeper runs the link `frpc` as its child, the
  `tunnel` service goes, `db` gets `wal_level=logical`, `max_replication_slots=10`, `max_wal_senders=10`,
  `max_prepared_transactions=0`); section 6 (host-wide port registry in volume `hornhoof-ports`, the lock container,
  `HORNHOOF_PEER_PORT`, folders `~/hornhoof-<company>`); section 9 "Move in by Update" (web port moves from `app` to
  `front`, same number); 3.9 "Modes" (`lead`, `read`, `maintenance`, `off`, set by the keeper; `read` serves pages and
  reads); section 9 "The maintenance state" and the one-shot `migrate` entry point (migrations leave the app's start,
  `apps/server/src/db/client.ts:23`), on one machine; the link frpc gets R1's client id and R3's transport settings;
  plan 1b's TLS listener moves from the app into the keeper, which answers the link (3.10).
- Depends on: 1 (the relay must be deployed before any frpc drops its heartbeat) and 1b.
- Owner sees: after one Update, the same localhost and link; `front` and `keeper` containers in place of `tunnel`; a
  third and fourth company install side by side without a port clash; the Update screen says "maintenance" while
  migrations run.
- Risk: high. It changes the update path of every install. Rollback restores the old compose shape and `tunnel`;
  `apps/server/test/install-script.test.ts` and `updater.test.ts` cover the move both ways.

### 3. Fences and the journal on one machine

- Scope: 3.4 fences 1, 2 and 4, "The orchestrator's SQL" (rights, the `pgsql-parser` check, the statements before
  `COMMIT`, any WARNING at commit means not confirmed, the lint), the keeper's own lease writes with
  `synchronous_commit = local`, the late-tick rule, "One data machine" (lease renewed each second, sync flag "alone");
  3.7 schemas `net` and `net_local`, the journal trigger, foreign keys `DEFERRABLE INITIALLY IMMEDIATE`, the uuid
  column on `task_events`; 3.9 the tables `public.applied` and `public.tool_calls` (schema only, used in plan 4); the
  keeper refusing `lead` while a table lacks its trigger or the agent grants and PUBLIC revokes are missing; the
  keeper answering `/api/network/lease` (3.4 proof (a), 3.10). A real Postgres 17.11 test harness in Docker.
- Depends on: 2 (the keeper renews the lease; without it fence 1 refuses every commit).
- Owner sees: nothing, but for orchestrator SQL that tried `COMMIT`, `SET` or a refused function, which now gets a
  plain refusal.
- Risk: high. A fence bug stops every write. Covered by real Postgres tests of every fence and by the keeper's start
  checks; the app shows read mode, not errors, when the lease is missing.

### 4. Work that survives a restart

- Scope: 3.9 "Where a change came from" (`applied` rows, request ids the web page sends and keeps on retry), "Node
  messages survive" (numbered, kept in the node's volume, confirmed by the highest committed number, reconnect backoff
  capped at 10 s), "Tool calls" (`front` stamps and keeps invocation ids, `tool_calls` holds the stored answer,
  "started" rows for run and computer tools, the "may have run" error text), "Built-in node" (its own key derived from
  `NODE_KEY` and the machine id, pointed at its machine's `front`), and `front` holding requests up to 60 s, then 503
  with `Retry-After`.
- Depends on: 2 and 3.
- Owner sees: an Update or an app restart no longer fails the built-in node's running turns as `machine_restarted`;
  the page does not lose a change it was sending during the restart.
- Risk: medium. It changes the node protocol; old nodes must keep working for one version (tested with an old hello).

### 5. Machines join the network

- Scope: 3.2 (the company authority, machine certificates with roles, keepers over mutual TLS on HTTP/2, CONNECT
  streams, `x-hornhoof-via`, what each role's certificate reaches, direct path and stcp path, address discovery on Linux
  and the Mac); 3.3 the load report additions (uptime, fsync p99, free disk, 7-day online share), which plan 9's score
  reads; 3.8 "Keys" (an X25519 age key and an Ed25519 signing key per machine; plan credentials re-sealed to machine
  keys, see discrepancy 1); section 2 "Joining" (the join command installs the small core: `front`, `keeper`,
  `updater`); 3.9 "Finding the leader" (every node points at its machine's `front`; a worker's keeper forwards to the
  leader's app); Machines tab: the "Company server here" badge following the real leader, "Open here: localhost:8081",
  "Make Mac a full machine of the company" (section 9); section 10 certificates (30 days, weekly renewal, revocation
  list, expired certificate may only ask for a new one) and "A stolen machine" (Disconnect revokes, renews stcp secrets,
  changes the link key through R6). The lab gets its Docker-in-Docker machines.
- Depends on: 1 to 4.
- Owner sees: the Mac opens the company at `http://localhost:<port>`; the server's card has "Company server here";
  Disconnect cuts a machine off for good.
- Risk: high. It opens a network port and trusts a header; the tests prove a worker's certificate never reaches `db`
  and a forged `x-hornhoof-via` gains nothing.

### 5b. Machines join the company

- Scope: section 2 "Joining" (the join command installs the small core, `front`, `keeper` and `updater`, in a folder of
  its own, with a one-use ticket); 3.2 from a worker's side (a `worker` certificate, the peer link direct on the local
  network and else through hornhoof.org as an stcp visitor, never `db`); 3.9 "Finding the leader" on a worker, with its
  page of the data machines' addresses when no server answers; address discovery on Linux and on a Mac; the load report's
  measures and the 7-day online share (3.3); section 9's workers following the server's build one at a time, between
  turns, and "Make Mac a full machine of the company"; section 10's expired certificate asking for a new one, and
  Disconnect cutting a worker off for good; each person's own key in their join command, for plan 6; the Machines tab's
  badge and "Open here"; the lab's Docker-in-Docker machines.
- Depends on: 5.
- Owner sees: one command from Connect a machine, and the Mac opens the company at its `localhost`; its card says "Open
  here: localhost:8081", and it updates by itself; Disconnect cuts a machine off for good.
- Risk: high. Machines join on a ticket and talk over an open port. The tests prove a worker's certificate never reaches
  `db`, a worker holds no company secret, and its update never cuts a running turn.

### 6. Computer access per machine

- Scope: section 8 (table `machine_access`, each keeper writes its own `computer.json`, commands travel leader app to
  target keeper to its updater, tools take a machine, cards and log lines name the machine, only the machine's owner
  opens access, the localhost hint in the account menu).
- Depends on: 5.
- Owner sees: "Open access to Debian for a day" on each machine's card, and "Close access" works on the machine it
  names.
- Risk: medium. It hands root on a machine to the orchestrator; owner-only opening is tested for every role.

### 7. Encrypted backups on other machines

- Scope: 3.8 "Recovery file", "Making" (every 6 hours and before every update; dump plus the `.env` secrets a restore
  needs; age to every data-eligible machine and the recovery key; signed; `net.backups`), "Holding" (up to 3 machines
  pull with their own certificate, keep the latest 2, "Keep company backups" tick), "Restoring" (on the leader, signer
  checks, into a one-machine network; the old database is kept beside it until plan 8 merges it), "Total loss"
  (restore from a recovery file, the challenge). `SECURITY.md` corrected (discrepancy 15).
- Depends on: 3 (`net.backups` is fenced and journaled) and 5 (certificates, machine keys, the backups endpoint).
- Owner sees: Settings, "Save the recovery file" and "Restore from a backup"; a fresh `install.sh server` offers
  "Restore from a recovery file"; each card has "Keep company backups".
- Risk: medium to high. A restore runs SQL from a dump; the signer and role checks are tested with a swapped file, a
  worker-signed bundle and a bundle sent as a challenge.

### 8. Merge

- Scope: section 5 (safe merge from the journal, both directions by journal ids, sources skipped, per-column proof,
  unique-key rules, append-only logs by uuid, jobs and parked results, savepoint per row group, `net.merges`, the
  completion set check, the orchestrator's merge task with `merge_conflicts` and `merge_pick`, people and access
  conflicts to the CEO, code branches listed); "After a restore"; 3.7 "No database is thrown away"; fork dumps as
  bundles (3.8); the merge of the database a restore kept (plan 7).
- Depends on: 3, 5 and 7.
- Owner sees: after a restore, what the old database held and the restore lacked comes back as additions or as one
  orchestrator task listing conflicts with both values.
- Risk: high. It is the only place that may change rows on the leader from another history; every rule has a test
  from section 12's merge bullets.

### 9. Copies, the server order and the planned switch

- Scope: 3.7 (logical replication of `public` and `net`, a new copy from a schema dump with `copy_data = true`, text
  format, `max_slot_wal_keep_size`, sequences on promotion, promotion steps with the app's first write making its
  machine number 1, remake after migrations into a side database); 3.3 who may hold data and qualification, losing
  whole-company scope (with plan 8's restricted upload and the wipe), and the server order: the columns
  `server_order`, `server_pin` and `server_why` on `machines`, the score (online share with the 95% class first,
  network to number 1 and to the internet, fsync, memory and cores; ties by owner and join date; the 5-point margin;
  newcomers under 3 days below the rest), its measurements (round trip from the heartbeats, throughput from transfers
  of 4 MB or more that flow anyway, the internet check's round trip and a daily 4 MB download from github.com),
  ranking daily, on join or leave and after a leader change, pins and "Does not take the server" with their refusals,
  numbers 1 to 3 holding copies and a copy handed over when the ranking changes (at most one a day); synchronous
  replication as fence 3 with the relay's sync record (R2 posts "sync off" and "sync on"), the sync copy named by the
  order (the lowest number from 2 up that keeps pace, a higher one while the lower is away, a lower one replacing it
  through "sync off"), when a copy counts as silent; 3.4 the first copy of a one-machine network and "Planned switch"
  started by "Move the server here" (a copy made first on number 4 or later, the target named sync first); section 9
  "Updates across machines" (the "updating" promise, the slot wait before the dump, sync off for migrations, rollback
  with slots, copies remaking); section 2's "Priority" row as in the approved mockup
  (https://claude.ai/artifact/Twnj15fdFN4Z1gT4Z2AgxT): the number and its why line, "Automatically" / "By hand" with
  the 2 to N select, "Does not take the server", "Move the server here" with its inline confirm, the reasons a machine
  cannot take the server, the copy states, "Only Debian holds changes since 23:40", the "Company server here" badge
  following the real leader, and the sortable Priority column. Real Postgres pairs `linux/amd64` with `linux/arm64`;
  the lab's writer and checker. On the relay (decision 5): a traffic counter per month (the public interface's
  outbound bytes, which DigitalOcean bills, kept across reboots, since frps's own counters reset when it restarts), and
  a runbook line to resize the $4 droplet when a month's transfer passes 300 GB.
- Depends on: 1 to 5, and 8 (a remake runs the compare before it drops a database).
- Owner sees: each card's number and why ("Always online, best connection to machine 1" / «Всегда в сети, лучшая связь
  с машиной 1»); "Move the server here" / «Перенести сервер сюда» moves the company in about 10 s; one Update moves
  every machine.
- Risk: very high. Durability now rests on replication; an update with migrations is the most likely place to lose
  the copy, and a ranking that changes the sync copy passes a few seconds of "sync off". Covered by pair tests, the
  lab, a rollback test with slots and section 12's server order bullet.

### 9b. The server order

- Scope: 3.3 "The server order" from number 2 on: the score and its measurements (online share with the 95% class first,
  round trip and throughput to number 1 and to the internet, fsync, memory and cores), ties and the 5-point margin,
  newcomers under 3 days below the rest, ranking once a day, on a join or leave and after a change of leader; pins,
  "Does not take the server" and their refusals; a copy handed over when the ranking changes, at most one a day; section
  2's Priority row and the sortable column; section 4's row on pins and the daily ranking.
- Depends on: 9.
- Owner sees: each card's number and one line on why; "Automatically", "By hand" with a place, "Does not take the
  server"; the Machines table sorted by it.
- Risk: medium. A new ranking can change the sync copy, which passes a few seconds of "sync off", and a handover drops a
  copy. Covered by the score's table tests, the ranking's tests and the lab's pin steps.

### 9c. The planned switch and updates across machines

- Scope: 3.4 "Planned switch" started by "Move the server here" (a copy made first on number 4 or later, the target named
  sync first), its abort, 3.7 promotion and sequences; 3.9 "Built-in node" per data machine; section 9 "Updates across
  machines" and "The maintenance state" (the "updating" promise, the slot wait before the dump, sync off for migrations,
  rollback with slots, copies remaking, each machine installing in its turn); decision 5's traffic counter on the relay
  (addendum A2 to plan 1).
- Depends on: 9 and 9b.
- Owner sees: "Move the server here" moves the company in about 10 s, with one question first; one Update moves every
  machine; the old leader follows as a copy.
- Risk: very high. It is the first time the server changes machines, and an update with migrations is the likeliest place
  to lose the copy. Covered by real Postgres pairs, the switch's decision table, a restart at each phase and the lab's
  moves there and back.

### 10. Takeover

- Scope: 3.4 heartbeats (naming the sync copy), the lease and its proofs (a) and (b), re-entry, takeover by B with
  checks 1 to 5, B's promise, the question "Go on from 23:40" (section 2, listing each copy that is up in the server
  order with the time its changes reach), terms; the old leader ranked again on return and never given the server back
  without "Move the server here", with its card's note; 3.9 "Jobs" across an unplanned switch (unknown jobs keep
  running while a merge is pending, parked results, tool tokens of X's open jobs) and the recovery API in `read`; 3.7
  "Rejoining" after an unplanned switch; 3.10 timing; the switch banners of section 2; the keeper's decisions as a pure
  function of observations and two clocks, table-tested with section 4's rows (section 12, first bullet), including
  the leader and its sync copy stopping together and the leader dying in a relay outage of 75 s to 2 minutes (both a
  CEO question).
- From plan 9 (its rulings 12 and 18, approved 2026-11-03):
  - Section 5's step 2 for a machine that led: the bundle of its database, signed by a data machine that is not the
    leader. A copy that plan 9 left at "Copy: stopped" with the error `led` (its database once held a term, so plan
    9's remake, swap and wipe never drop it) has that database bundled and merged as a `machine:` source, compared
    whole since it wrote; only once that merge is `merged` and the bundle is in `net.backups` is the database dropped
    and the copy made again, and its card says each step.
  - The hidden name of spec 3.4 "Without a public link" for a company with no link, with the sync record and
    takeover through it, and plan 9's `link_needed` lifted: such a company's machines then qualify for copies (no more
    `no_link`), and its link can be removed while copies exist. Companies with no link must have copies before the
    series ships.
- From plan 9c (its ruling 12, approved 2026-11-03):
  - A planned switch whose peer link breaks after "go": the old leader stays fenced until the new one answers, and the
    takeover rule settles it (spec 3.4 "Planned switch", step 8).
  - The leader dying mid-update while copies hold the "updating" promise (section 4's row "Update fails, or the leader
    dies mid-update").
  - The banners "Moving the company to Mac" and the old leader's note for a planned switch as for a takeover. Until
    plan 10, the page holds for the switch's seconds and the badge moves.
- Depends on: 1 to 9.
- Owner sees: with Debian's power pulled, the Mac leads within about a minute and becomes number 1, the page stays open
  with "Moving the company to Mac", then "Hornhoof runs on Mac now"; once Debian is back and up to date, its card says
  so and offers "Move the server here".
- Risk: highest with plan 11. Two leaders at once is the failure the whole design fences; the decision table and the
  lab's overlap checker are the proof.

### 11. Splits

- Scope: 3.6 (the internet check, going on alone when a side reaches neither the relay nor a machine holding a valid
  lease, split terms and leases, the 2-minute countdown, sides with several data machines following the last normal
  leader, else its sync copy, else the lowest number in the order of the last normal term, which each keeper keeps in
  `net_local`; workers' choice of leader, no double work, the git wrapper for non-fast-forward pushes, meeting and the
  15 s rule, split sides meeting with no arbiter choosing by that saved order, staying split until the old leader
  answers, then ranking again); section 2 "Cut off, with internet" and "Cut off, with no internet" ("Go on here", the
  saving list); 3.9 "Work on a machine with no internet" (the write-tool message, the 30-minute wait, superseded jobs);
  saved work folders through `GIT_INDEX_FILE`; section 4's split rows; after a merge the order recomputed and one place
  pinned to two machines a CEO conflict (with plan 8); section 4's "Leader disk full" warning on the cards at 85%,
  with the disk figure each data machine reports for it (moved from plan 10, 2026-11-03).
- Depends on: 10 and 8.
- Owner sees: the countdown and "Working apart from Mac since 14:02"; on a machine with no internet, read mode and
  "Go on here without Mac"; when the sides meet, the merge task.
- Risk: highest. Covered by the decision table, the git tests of section 12 and the lab's split scenarios.

### 11b. Splits, the work

- Scope: what agents and nodes do while a machine is cut off or apart (plan 11's ruling 1): 3.9 "Modes" (`read`'s read
  tools, nodes for status only) and "Work on a machine with no internet" (the write tools' text, the 30-minute wait,
  superseded jobs and the move message); 3.6 saved work folders through `GIT_INDEX_FILE` and their branches, the `git`
  wrapper's `<branch>@<machine>`, "No double work", "Workers"; section 2's saving list and "Go on here without Mac";
  section 4's row "Leader loses internet, copy elsewhere"; section 5 step 8, the merge task listing every branch.
- Depends on: 11.
- Owner sees: on a machine with no internet, the list of work being saved and "Go on here without Mac"; a task whose
  machine went away says "Work saved on Debian at 14:05, not sent yet", and its head may move it after 30 minutes; saved
  work comes back as branches.
- Risk: high. It touches agents' work folders and pushes, and hands out work on two sides at once. Covered by tests on real
  git that a save leaves a folder as it was and nothing is forced, and by the lab's cut-off scenario.

### 12. Voting: removed

Removed on 2026-11-02 with spec 3.5: the server order (plan 9) replaces it, and there is no etcd. The number stays free
so that plan 13 keeps its number.

### 13. Lab and real tests

- Scope: section 12's lab bullet in full (5 Docker-in-Docker machines, `tc netem`, iptables, `docker pause`, a stepped
  clock, joins 2 to 5 and back, the ranking reordering 3 data machines and a pin, number 1 cut off and coming back,
  the leader and its sync copy stopped together, splits 2 and 3, three homes with the relay down, a split side meeting
  a newer leader, the overlap checker) and the real bullet (Ivan's Debian and Mac through the full installer, a third
  company on both, power pulled, Docker quit, lid closed, router unplugged, relay restarted and stopped, an update
  during a switch, timings, screenshots of the Priority row); fixes, each with its failing test first; the guide
  pages.
- Depends on: 1 to 11.
- Owner sees: the timings and screenshots of his own machines, and phase 1 done with no confirmed write lost.
- Risk: it finds bugs late. The lab grows from plan 5 on, so most are found in their own plan.

## Where the spec and the code disagree

Checked against main at 04bec1d. Line drifts that change nothing are grouped at the end.

1. **Machine keys.** Spec 3.8 and 11 say Step 0 brought an X25519 key per machine, on the machine's row, and section 7
   seals plan credentials to machine keys. Step 0 shipped keys per node instead (its own ruling): `nodes.public_key`
   (`apps/server/src/db/schema.ts:195`, migration `0038_plan_credentials.sql:13`, set at hello in
   `apps/server/src/modules/nodes/messages.ts:57`, `:64`). `machines` (`schema.ts:107-125`) has no key. Proposed fix,
   in plan 5: each machine's keeper makes the X25519 pair in its volume and reports the public half on the machine's
   row, beside the Ed25519 key of its certificate; plan credentials are then sealed to machine keys, re-sealed once by
   a node that holds each one, and backups (plan 7) seal to them. If a plan before plan 5 needs machine keys, the team
   lead fixes this gap first.
2. **PUBLIC revokes.** Spec 3.4 and 3.7 say the app "applies the PUBLIC revokes at every start"
   (`agent-sql.ts:116-118`). The app grants the agent roles at every start (`agent-sql.ts:118`) but nothing in the repo
   revokes anything from PUBLIC; the only revokes are from the roles themselves (`agent-sql.ts:60-61`). Plan 3 adds
   them.
3. **27 tables.** There are 28 (`plan_credentials` came with 0038). All 28 have a primary key, so 3.7's point holds.
4. **References a merge must not empty.** Section 5 step 5 cites `schema.ts:543` and `:612`, which are now
   `media_type` and `test_parts.error`. The only foreign keys with an `ON DELETE` action are `test_runs.department_id`
   (`SET NULL`, `schema.ts:567`) and `notebook_notes.department_id` (`CASCADE`, `:636`); every other foreign key is
   `NO ACTION`. Plan 8 states the rule for every foreign key, not two lines.
5. **Jobs at hello.** Spec 3.9: jobs the node does not list fail as `machine_restarted`. Code fails only running jobs
   and queued test jobs (`messages.ts:72`, filter `ON_NODE` at `:25`); queued conversation jobs stay. The cancel of
   jobs the database does not hold open is at `:76-81`; ends of unknown or closed jobs are not applied but still acked
   (`:151-184`, `:182`).
6. **Node outbox.** Spec 3.9: "the outbox is in memory and finished jobs are capped at 50 (`main.ts:33-34`,
   `97-110`)". The outbox is in memory with no cap (`apps/node/src/main.ts:121-122`); only unconfirmed `job.done` and
   `tests.done` are capped at 50 (`:40-41`, `:153-160`), and they already go again after every hello (`:229-231`).
   Plan 4 builds on that.
7. **Turns left behind** are queued at start by `onReady` and `wakeLeftBehind`
   (`apps/server/src/modules/agents/timers.ts:121-122`, `apps/server/src/modules/tasks/wake.ts:209-219`), not at
   `timers.ts:95-102`, which sends waiting work each minute.
8. **The install the updater runs** starts `db app node tunnel` and returns without a health check of its own
   (`scripts/install.sh:836-841`; spec cites `:775`). The updater's own check is `updater.sh:374-383`. Plan 2 adds
   `front` and `keeper` there and drops `tunnel`.
9. **The Machines tab's Plans row** is gone already (commit 4f16b8f in Step 0). Sections 2 and 7 still speak of
   removing it.
10. **Relay health.** Spec R4: `GET /api/health` answers only while frps accepts logins. The relay answers
    `GET /api/v1/health` with `{ok: true}` whenever relay.py runs, whatever frps does. And `/api/health` on a
    company's host is the app's own route. Plan 1 keeps the path `/api/v1/health` at hornhoof.org and ties its answer
    to frps.
11. **Relay heartbeat settings.** `frps.toml` sets `transport.heartbeatTimeout = 90` and no
    `transport.tcpMuxKeepaliveInterval`. Hornhoof writes the frpc side itself (`client.ts:18-45`, heartbeat 30 and 90
    at `:32-33`) and never runs the relay's `tunnel.config`. R3 needs both sides changed, frps first, so plan 1 changes
    the relay and plan 2 the frpc config.
12. **What the relay lets in.** The plugin takes one `http` proxy named exactly the binding, no user, no custom
    domain (relay.py `plugin`), and frps calls it for `Login`, `NewProxy` and `Ping` only. R1's client ids
    `<link>-<machine8>-link` and `-peer`, R5's stcp services `<link>-<machine8>-data` and `-app`, and refusing
    load-balancer groups are new plugin rules.
13. **Blocking and releasing a link.** Today a released or blocked tunnel is cut on its next heartbeat, through the
    plugin's `Ping` check. R3 stops heartbeats, and frpc then sends no `Ping` at all (frp `client/control.go:243`), so
    that cut goes away for clients on the new settings; the spec does not say what replaces it, and frp 0.71.1 has no
    call that closes one proxy or one client (the dashboard's `DELETE /api/proxies?status=offline` clears the stats of
    offline proxies only). The relay's own texts also disagree on the cut today: the ops note says 30 s, `frps.toml`
    and the `hornhoof-relay` script say 90 s. Decision 3 settles it: Caddy's 410 already stops a blocked name's traffic
    before frps, so nothing restarts.
14. **No relay repository.** The spec runs the contract tests "in the relay's repository". relay.py exists only in
    `~/.hornhoof-edge/droplet/relay/` (not under git) and on the droplet, with no tests. Decision 1 gives it one.
15. **Backups in SECURITY.md.** `SECURITY.md:11` says backups are signed and encrypted; `apps/updater/updater.sh:171-186`
    writes plain `pg_dump | gzip` under umask 077, as the spec says. This is one of the texts written ahead of the
    code on purpose (`notes/ops/going-public.md`, "Docs written ahead of the code"); plan 7 makes it true, and the
    other lines of that list are each owned by the plan named there (plans 5, 7, 9, 10, 11, 12).
16. **The authority key.** Spec 3.8 says `HORNHOOF_SECRET` opens "the stored API keys and the authority key". No
    authority exists yet; today the secret encrypts API keys, repository tokens, the link key, the tunnel settings and
    install commands. Plan 5 adds the authority under it.
17. **Sizes.** The file limits are MiB (`50 * 1024 * 1024`, `apps/server/src/modules/tasks/attachments.ts:19-22`), the
    spec says MB. No effect.
18. **Line drifts, same meaning.** `schema.ts`: `attachments.bytes` :544 (spec :520), `jobs.tool_token_hash` :321
    (:297), `task_events.id` :468 (:444), `agent_events.id` :345 (:321), `turns.task_id` :394 and `tasks.turn_id` :415
    (:370, :391), unique numbers :402, :447, :588, :646 (:378, :423, :564, :622), one head and one orchestrator
    :259-260 (:235-236), the executor check :453 (:429). `messages.ts` machine_restarted :72 (:60). `queue.ts` two hours
    :27 (:26). `install.sh`: server mode :751-858 (:688-795), join :288-341, `host.docker.internal` :280-286
    (:278-284), `free_port` :666-677 (:603-614), project names :767-768 and :792-793 (:704-705), the secret :786
    (:723-726), `login_node` :479-497 (:454-462), no Docker socket :394-395 (:396-399). `updater.sh` install :257-263
    (:257-268). Node: tools URL `main.ts:111` (:87), `login` :569-605 (:417). `compose.yaml` is 146 lines. `0033_nodes.sql`
    drops five columns at :45-49 (:45-47).

What frp 0.71.1 does, read in its source at tag v0.71.1 (paths in `github.com/fatedier/frp`):

19. **"A new login never replaces a live one"** (R1) holds for frp's `clientID`: frps refuses a second login with a
    `clientID` that is online (`server/registry/registry.go:207-215`, `server/control.go:213`). It does not hold for
    the run id: a login that brings a live session's run id replaces that session (`server/service.go:819`,
    `server/control.go:167`), and run ids show on frps's dashboard. Plan 1's plugin allows that takeover only when
    the client id matches too.
20. **"A registration for a name with a live route is refused"** (R1): frps keys http routes by domain, location and
    `routeByHTTPUser` (`pkg/util/vhost/router.go:170-185`), lets a load-balancer group share one
    (`server/group/http.go:82-108`), and `customDomains = "*"` catches every host with no route of its own. One route
    per name holds only because proxy names are unique across clients (`server/control.go:871-873`) and the plugin
    lets in only the proxy named after the binding, with no custom domain. Plan 1 also refuses `locations`,
    `route_by_http_user` and groups.
21. **Heartbeats** (R3): with tcpMux on, frpc's heartbeat is already off unless set (`pkg/config/v1/client.go:154-159`);
    Hornhoof sets 30 and 90 explicitly. frps enforces its own `heartbeatTimeout` whenever it is above 0, tcpMux or not,
    and only a `Ping` resets it (`server/control.go:640`, `:791`), so the relay's 90 would drop every tunnel on the new
    settings after 90 s: frps must change before any frpc does. Eviction's worst case is the keepalive interval plus
    20 s (yamux v0.2.0 `session.go:351`, `:396`), 30 s with an interval of 10, as the spec's "about 20 to 30 s".
22. **Knowing a route went.** frps sends `CloseProxy` asynchronously, unordered against the next `NewProxy` of the same
    run id, and not at all when it is killed (`server/control.go:678-679`); a `NewProxy` the plugin approved can still
    fail inside frps. Plan 1 reads "live" from the dashboard API (`/api/proxy/http/<name>` gives `status` and
    `clientID`) on every answer. frps also calls the plugin with no timeout, inside each client's control loop
    (`pkg/plugin/server/http.go:50`, `pkg/msg/handler.go:185-186`), so a slow relay stalls tunnels: every call the
    relay makes inside a plugin op has a 1 s timeout.
23. **Our own TLS was a non-goal.** Spec section 1 listed "our own TLS on the public link" among the non-goals; Ivan
    moved it into phase 1 on 2026-11-02 (the TLS section below), and the spec's non-goals and 3.10 now say so. Three
    texts follow: `SECURITY.md:53` ("The browser's https connection ends at hornhoof.org") changes in plan 1b; the
    Caddyfile's "Company names never reach CT logs" holds only for names in http mode and changes in plan 1; the
    hornhoof-edge README says plainly that the relay sees only encrypted bytes and the name being reached.
24. **A custom domain under the relay's own domain.** frps refuses a custom domain under `subDomainHost`
    (`pkg/config/v1/validation/proxy.go:81-90`), so the edge client cannot claim `*.hornhoof.org` and claims `*`.
25. **Connections, not tunnels, are what frps lets the plugin refuse.** `NewUserConn` fires for every new connection
    to an `https`, `tcp` or `stcp` proxy (`server/proxy/proxy.go:268-285`), never for `http` ones (their traffic goes
    through frps's own reverse proxy), so blocking by name covers passthrough names and peers, and Caddy's 410 keeps
    covering names in http mode.

## Decisions (decided by Claude, 2026-11-02)

These were this overview's five open questions. Ivan leaves them to Claude as technical defaults; every plan is
written with them.

1. **The relay's code lives in its own repository, `hornhoof-edge`** (decided by Claude, 2026-11-02; amended the same
   day: it goes public later). Plan 1 builds it on the Mac at `/Users/0x/Projects/hornhoof-edge` from the files of
   `~/.hornhoof-edge/droplet`, with its tests; the team lead, not the plan's executor, pushes it to GitHub, private for
   now. It is set up from day one as a public open-source project, as Hornhoof's own repository is
   (`notes/ops/going-public.md`): MIT license, "Copyright (c) 2026 Ivan Korol"; every commit signed off (DCO); a README
   for the simplest person, saying what the relay does and what it never does or stores; CONTRIBUTING, SECURITY.md and
   CODE_OF_CONDUCT.md; tests and CI on every push. Nothing private goes in: no droplet IP, no hostname but hornhoof.org
   and names under it, no key, token, ssh config or certificate. The deploy reads those from files outside the
   repository, which carries only examples. English only, no em dashes. The repository takes the relay (`relay/`), the
   Caddyfile and the pages (`pages/`, `www/`); the droplet's base setup stays in the private folder (`setup.sh`,
   `cloud-init.yaml` with the Mac's ssh key, the sshd files, the tunnel and certpush public keys, the certificate
   installer, the old SSH tunnel's company example, `unattended.conf`). Hornhoof's repository, public too, carries none
   of the edge's internals: only the contract client (`relay.ts`) and the fake relay.
2. **Tests that need Docker run as `npm run test:real`** (decided by Claude, 2026-11-02). `npm test` stays as fast as
   today and needs no Docker. CI runs `test:real` on every push, and each network plan runs it before it merges. Plan 1b
   adds the command and its CI job with the first Docker tests (Pebble, Let's Encrypt's test server); plan 3 adds real
   Postgres 17.11 pairs. Plans 1 and 2 have none.
3. **Blocking or freeing a name** (decided by Claude, 2026-11-02), as proposed and refined by the frp source check the
   ruling asked for. frp 0.71.1 has no call that closes one proxy or one client, so there is no kick path to prefer.
   None is needed for a name in http mode (today's tunnels, and every company until plan 1b moves it to https):
   Caddy answers a blocked name with 410 before its traffic reaches frps (`blocked.caddy` comes ahead of the frps
   handler in the Caddyfile), so a block stops the name's public traffic at once. The plugin refuses the blocked name's
   next login and registration; a today's tunnel is still dropped at its next refused `Ping`; a tunnel on the network's
   settings lingers, carrying nothing, until its machine reconnects and is refused. So plan 1 drops the restart:
   blocking restarts nothing. A freed name's old tunnel lives until its machine lets go, which Hornhoof does at once
   when it renames (`apps/server/src/modules/link/link.ts:74-89`); until then the relay does not hand the name to a new
   binding (`link_taken`), so no new company gets a name another machine still serves. A name served by TLS
   passthrough never passes Caddy; the plugin refuses each new connection to it instead (`NewUserConn`, the TLS
   section), so blocking it restarts nothing either, and `hornhoof-relay ban --cut` restarts frps only when the
   connections already open must go too.
4. **Relay restarts** (decided by Claude, 2026-11-02): at most one per deploy, between 03:00 and 05:00 at UTC-3, Ivan's
   night (06:00 to 08:00 UTC), and only while no company's link is busy. frps cannot tell: it adds a connection's
   bytes to its counters only when the connection closes (`server/proxy/http.go:151-157`,
   `server/proxy/proxy.go:318-323`), and its count of open connections includes every idle page's event stream. The
   droplet's kernel can: `ss -ti` gives the bytes each open TCP connection on port 443 has moved, tunnels and visitors
   alike, and the relay is busy while one of them moved more than 64 KiB in the last 60 s. The deploy also keeps clear
   of the droplet's unattended reboot at 07:30 UTC (`unattended.conf`): it starts no later than 07:15 UTC, and not on
   a night when `/var/run/reboot-required` exists. With no quiet minute before 07:15 UTC it waits for the next night.
   relay.py and frps restart together, so links blink once. Each relay deploy step says so (plan 1, Task 10).
5. **The $4 droplet stays** (decided by Claude, 2026-11-02). Plan 9 adds a traffic counter on the relay and a runbook
   line: resize when a month's transfer passes 300 GB of the 500 GB included.

Not a question for Ivan: the machine keys of discrepancy 1. Plan 5 carries the proposed fix; if a plan needs machine
keys before plan 5, the team lead fixes that gap first.

## Our own TLS on the public link (decided by Ivan, 2026-11-02)

Ivan: hornhoof.org must not be able to read company traffic. So the browser's https ends at the company's own
machine, which holds the certificate for `<name>.hornhoof.org` and its key. hornhoof.org reads only the name the
browser asks for (the TLS server name, SNI) and the visitor's address, and passes the encrypted bytes through the
company's tunnel. This leaves the spec's non-goals and joins phase 1 (spec section 1 and 3.10 changed). It also takes
a power away from the relay: while it ended TLS it could have answered `/api/network/lease` (3.10) in the leader's
place; now that answer comes under the leader's own certificate.

**Routing by name: frps on port 443** (chosen). frps takes 443 as its https vhost port (`vhostHTTPSPort = 443` with
`proxyBindAddr = "0.0.0.0"`, the one address it binds its vhost listeners on, `server/service.go:310`, `:338-343`; its
http port 8080 then listens on every address too, and both firewalls, ufw and DigitalOcean's, keep opening only 22, 80
and 443). It reads the server name from the ClientHello without decrypting (`pkg/util/vhost/https.go:39-48`) and picks
a route: a company's `https` proxy by its exact name, else `*` (`pkg/util/vhost/router.go:126-155`). Caddy moves to
`127.0.0.1:8443`, behind an frpc on the droplet itself (client `edge`) whose one `https` proxy registers `hornhoof.org`
and `*`. So hornhoof.org, www, the API, the tunnels' wss, reserved, blocked and unknown names, and every name still in
http mode reach Caddy as today, with today's certificates. (frps refuses a custom domain under its `subDomainHost`,
`pkg/config/v1/validation/proxy.go:81-90`, so `*.hornhoof.org` cannot be registered; `*` is the catch-all.) Why not an
SNI router in front of frps (Caddy's layer4 module, or HAProxy):
- The visitor's address. frps does not read an incoming PROXY protocol header, so behind a router every visitor would
  reach the company from the droplet's own address, and the per-address sign-in limit
  (`apps/server/src/modules/auth/routes.ts:26-32`) would count them all as one. frps on 443 sees the address and hands
  it on as a PROXY v2 header (`transport.proxyProtocolVersion = "v2"` on the frpc proxy, `pkg/config/v1/proxy.go:43-46`,
  `client/proxy/proxy.go:210-211`): to the company, and through the edge client to Caddy, which takes it from loopback
  only.
- Blocking by name works inside frps (below), with no new moving part.
- Caddy stays the apt package (layer4 needs a custom build); the only new process on the droplet is one more frpc.

Costs: frps faces the internet on 443 (it parses only the ClientHello there). A frps restart takes hornhoof.org itself
away for the same seconds as the links (decision 4 covers it). hornhoof.org's own traffic and the tunnels' wss now pass
frps and the edge client before Caddy, so the edge client runs under systemd with `Restart=always`, and the plugin lets
client `edge` in only with a 32-byte token from a root-only file (every tunnel reaches frps from Caddy on loopback,
so the address proves nothing). Caddy keeps port 80 (redirects, HTTP-01 for
hornhoof.org); HTTP/3 stays off. Tunnels keep coming in as wss to `hornhoof.org/~!frp`, so today's frpc settings work
unchanged. One route per name holds across both kinds, since frps keeps proxy names unique whatever their type
(`server/control.go:871-873`): a name is served by an `http` proxy (old mode, Caddy ends TLS) or by an `https` one (the
company does).

**The machine's certificate, through the tunnel.** Each company's machine orders the certificate for its own
`<name>.hornhoof.org` from Let's Encrypt, with the company's own ACME account, and renews it the same way.
- HTTP-01 (chosen). Let's Encrypt asks `http://<name>.hornhoof.org/.well-known/acme-challenge/<token>` on port 80;
  Caddy redirects it to https, as it does every request on 80; Let's Encrypt follows the redirect to port 443 and does
  not check the certificate there; frps routes it by name into the company's tunnel, and the machine answers the
  token. It works in both modes: through Caddy and the http route before the switch, through the passthrough after
  it, where a self-signed stand-in answers until the real certificate exists. Only the machine that holds the route
  can answer, and the relay needs no new endpoint.
- TLS-ALPN-01, the other way through the passthrough, needs a special challenge certificate built on the machine and
  works only after the switch. It is the fallback if the redirect path ever stops working.
- The certificate and its key live in the company database, the key encrypted under `HORNHOOF_SECRET` as the link key
  is, so after a takeover (3.10) whichever machine holds the route serves it. Renewal starts when Let's Encrypt's
  renewal information (ARI) says, which also exempts it from the limits. Lifetimes shrink to 45 days by 2028, so
  renewal is automatic from the first day.

**Let's Encrypt's limits and the Public Suffix List.** Every `<name>.hornhoof.org` counts against the registered
domain `hornhoof.org`: 50 new certificates per 7 days, shared by every company, so at most 50 new links or renames a
week. Renewals do not count, and ARI renewals are exempt. There are also 5 certificates per exact name per 7 days, which
a company that reinstalls with a fresh database more than 5 times a week would meet (keeping the certificate in the
database avoids reordering), and 5 failed validations per name per hour, so a machine waits an hour after a failure.
Two ways past the 50:
- Let's Encrypt's rate-limit adjustment form, for hornhoof.org as a provider that gives names to customers: the tool
  made for the limit itself. Step the team lead runs when new links near 30 a week.
- The PSL private section, which makes each `<name>.hornhoof.org` a registered domain of its own, for Let's Encrypt and
  for browsers (no cookie set by one company's page reaches another's). Its guidelines refuse entries "whose sole
  purpose is to circumvent rate limits of third parties (such as Let's Encrypt rate limits)", say that projects "not
  serving more than thousands of users are quite likely to be declined", and promise no review time. So the request
  rests on its proper ground, companies that do not trust each other under one domain, and goes in once Hornhoof
  serves thousands of companies. It takes a pull request to `publicsuffix/list` adding `hornhoof.org` to the private
  section, sorted by name, with `// Hornhoof : https://hornhoof.org/` and Ivan as submitter; a TXT record
  `_psl.hornhoof.org` holding the pull request's URL, left in place for good; the domain registered for at least two
  more years, and kept above one. Ivan submits it as the domain's owner. Step the team lead runs. Until then, plan 1b
  gives Hornhoof the cookie separation itself (`__Host-` cookie on the link).

**A known consequence: names become public.** Every certificate goes into Certificate Transparency logs, so a
company's name is public (crt.sh lists it) from the day its first certificate is issued. Today the wildcard keeps names
out of the logs; the Caddyfile says so. From phase 1 on, nothing may rely on a link name being secret. The plans assume
Ivan accepts this (asked 2026-11-02). Mitigations, in plan 1b unless named:
- Sign-in limits. Today: 10 tries per email and address in 15 minutes, 50 per email from anywhere in an hour
  (`apps/server/src/modules/auth/routes.ts:26-32`), 10 per invite in 15 minutes
  (`apps/server/src/modules/people/routes.ts:92`, `:166`), all counted in memory. Missing: a limit per address across
  emails (one address may try every email), and counts that outlive a restart. Plan 1b adds 30 failed sign-ins per
  address an hour across all emails, and keeps the counts in the database. It adds no hard lockout per account: anyone
  who knows the owner's email could then lock the owner out, which the code avoids on purpose (`routes.ts:23-24`); the
  per-email limit is the soft form of it and stays.
- A sign-in page that tells nothing. Today it shows "Hornhoof" and the form only (`apps/web/index.html:7`,
  `apps/web/src/screens/Login.tsx`), and before sign-in the server answers `/api/health` (version and commit),
  `/api/version`, `/api/setup` (whether setup is needed, the link domain) and an invite only with its token. Plan 1b
  pins this with a test: no answer without a session carries the company's name, people, emails or departments; over
  the link `/api/health` gives `{ok}` only and `/api/version` needs a session (the updater reads both on localhost).
- `noindex`. None today. Plan 1b: `X-Robots-Tag: noindex, nofollow` on every answer of a company's server and a
  `robots.txt` that disallows all. Plan 1: Caddy sends the same header with the 404 and 410 pages of other names; the
  stub at hornhoof.org stays indexed.
- The relay's 404 for unknown names and 410 for blocked ones stay as today (plan 1), and a freed name is not handed out
  while its old tunnel lives (R1.5): a name found in a log leads nowhere once it is gone.
- Blocking by name (below) cuts an abused name at once.
- The link's session cookie becomes `__Host-` prefixed on https, so a page on another company's name cannot set or
  shadow it while every name shares the site `hornhoof.org`.
- Random names stay the default: they no longer hide that a company exists, but they do not name it.

The alternative given up, on record: a wildcard certificate on the relay, today's design, keeps every name out of CT
logs but lets hornhoof.org read every request and answer in a company's place. Ivan chose the privacy of what
companies say over the privacy of their names.

**Blocking by name, without restarts.** frps asks the plugin about every new connection to an `https` or `stcp` proxy
(`NewUserConn`, `server/proxy/proxy.go:268-285`), giving the proxy's name and the visitor's address, and drops the
connection when the plugin refuses it. The plugin refuses a connection to a blocked name, or to a name whose binding is
gone (freed), from one indexed SQLite read and no dashboard call. So a block or a release cuts every new connection at
once, and nothing restarts. Connections already open stay until they close, since frp 0.71.1 has no call that closes
one; `hornhoof-relay ban <name> --cut` also restarts frps, for abuse that cannot wait, and every link blinks. The cost:
relay.py now answers every new connection to a passthrough name, and while it is down those are refused (today's
tunnels already fail their `Ping` then). It never logs or keeps the visitor's address. A name in http mode keeps
Caddy's 410, as today.

**The stub, the 404 and 410 pages, and install.sh.**
- hornhoof.org and www: the same pages and certificate, served by Caddy behind frps. The API and
  `https://hornhoof.org/install.sh` come the same way, so the install command does not change. During a frps restart
  they are gone for the same seconds as the links.
- A reserved name (404), a name with no live tunnel (frps's 404 page through Caddy) and a name in http mode: through
  the catch-all to Caddy, with the wildcard certificate, as today. A passthrough company whose machines are all off has
  no route and shows that same 404.
- A blocked name: 410 from Caddy, as today, in http mode. In https mode new connections are refused at once (the
  browser says it cannot connect), and once the tunnel is gone the name falls to Caddy and shows 410.

**Where it lands, and what it changes in plan 1.** The relay half changes the contract (one route per name across
`http` and `https`, routing by name, refusing connections per name, health saying `passthrough`), so it goes into plan
1, under the same deploy and its one restart. In plan 1 that means: the `routes` rows carry the proxy's type, read
from `/api/proxy/<type>/<name>`; the harness runs a real Caddy beside frps; frps takes 443 and asks the plugin about
every new connection; the edge client, its unit and its token; Caddy on loopback with the PROXY protocol, the 404 and
410 pages sent with `noindex`; the plugin's rules for `https` proxies, the edge client and `NewUserConn`; `ban --cut`;
contract rows R7.1 to R7.5; the README saying plainly that the relay sees only encrypted bytes and the name being
reached. The company half is plan 1b, right after plan 1 and before plan 2; plan 2 then moves the TLS listener from
the app into the keeper. Companies that have not updated stay in http mode, served as today, until they do.
