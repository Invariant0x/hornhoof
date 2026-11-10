# Network Phase 1, Plan 11: Splits, Who Leads, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When hornhoof.org cannot decide, each side of the company that still has internet goes on by itself after two
minutes: the side's best machine takes a split term, the page counts down and then says "Working apart from Mac since
14:02", and agents keep working. When the sides meet again, through hornhoof.org or directly, exactly one leads, the
others step down and are merged into it, and only then does it take a normal term again and rank the machines. A machine
with no internet never goes on by itself; it stays read-only and says why. Workers stay with the leader they had. Cards
warn when a data machine's disk is 85% full.

**Architecture:** One migration, `0059_splits`: `net.handovers` takes the kind `split` and says whether the side was
behind and which machine it lost, and `machines` gains `disk_total`. Each keeper checks the internet every 10 s
(`internet-check.ts`) and keeps the last normal term it led or followed, with that term's sync copy, server order and
members (`last-normal.ts`), in its own volume. Heartbeats carry these. The decisions are pure
(`modules/keeper/split-step.ts`): the two-minute countdown, the side's leader, whether a side is behind, the split term,
and how a split leader meets another leader, through the relay or over the peer link; both keepers count the two minutes
with one `Alone` each (`alone.ts`). The follow keeper's `Watcher` and the leading keeper's entry gain one row each for
going on alone; a copy goes on through plan 9c's `Promoter` with a `Taking` of kind `split`. A split leader meets others
by `nextMeetStep` each second, steps down by plan 10's follow path, and turns normal by plan 10's rule, widened to
splits. `PeerLink.leader()` stays with the leader it had. The keeper's switch word and the web's banners say what
happens.

**Tech Stack:** TypeScript on Node 22 (`node:https`, `node:crypto`); Postgres 17.11; Fastify 5; drizzle-orm 0.45.4 on
node-postgres and PGlite; React for the web app; vitest; Docker for `npm run test:real` and `npm run test:lab`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.6 "Going on alone" (the internet check, the split term and
lease, a side that is behind), the several data machines of one side, "Workers", "Meeting" (through the relay and over
the peer link with no arbiter, the saved order) and the rule for turning normal; section 2's "Cut off, with internet"
and the text of "Cut off, with no internet" (its saving list and button are plan 11b's); section 4's rows "Relay down,
two homes", "Relay down, 3 data machines, 2 in one home", "Relay down, 3 homes, no direct path", "The home of the leader
and its sync copy loses the internet", "A split side reaches the relay again" and "Leader disk full"'s warning at 85%;
section 12's first bullet ("the 2-minute split with and without internet", "a split leader waiting for the old one",
"split sides meeting with no arbiter"), its server order bullet ("a split side following the last normal leader, else
its sync copy, else its lowest number in the order of the last normal term", "two split leaders ... meeting with no
arbiter and choosing by the saved order", "after a merge the order recomputed, and one place pinned to two machines on
two sides a CEO conflict") and its lab bullet ("a 2 and 3 split across homes, three homes with the relay down, a split
side meeting a newer leader"). Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 11's entry; plan 10's
ruling 1 and its deviation g, which give this plan's partner, plan 11b, `read` mode's read tools and nodes connecting
for status.

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see them
fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only the
task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a test of
an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in the series' worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network` on its branch `network`, after plan 10's last task is
committed there. Nothing of the series ships until it merges into main, once, at its end.

**Handed over** (done on the `network` branch before this plan starts; none of it is shipped):
- Today's code: the providers (`PROVIDERS` in `db/schema.ts`: `claude`, `codex`, `kimi`, `glm`, `anthropic_api`,
  `openai_api`, `antigravity`), `subscriptions.provider`, `nodes.machine_id`, `nodes.subscription_id`; the Machines
  card's `DiskGauge` and `Resources` (`apps/web/src/screens/Machines.tsx`); the layout `Shell`
  (`apps/web/src/screens/Shell.tsx`); `handleNodeMessage` (`apps/server/src/modules/nodes/messages.ts`); `minuteRound`
  (`apps/server/src/modules/agents/timers.ts`).
- Plan 1: the relay client's `route`, `health` (`Route` with its generation and the client that made it); `FakeRelay`
  with `register`, `drop`, `restartFrps`, `frpsDown`, `routeAnswer`, `evictionBound`.
- Plan 2: `Keeper`, `keeper.json` (`readKeeperState`, `writeKeeperState`, `KeeperState`), `AppMode`, `whenLead`.
- Plan 3: `Term`, `LeaseKind`, `net_local.state`, `LeaseStore`, `Clocks`, `Held`, `LEASE_MS`, `LATE_MS`, `leaseValid`,
  `Keeper.mode()`, the fence trigger that commits under a `split` lease with `sync` null.
- Plan 5: `Measures` (`snapshot()`: `uptimeS`, `fsyncP99Ms`, `diskFree`), the keeper's report `POST
  /api/network/report`.
- Plan 5b: `PeerLink` (`use`, `leader()`, `request`, `stream`), `Hello`, `WorkerKeeper`, `WorkerView`, `PEERS_FILE`; the
  lab (`Lab`, `LabMachine`, `steps.ts`).
- Plan 8: the merger, `net.merges`, its conflicts and their topics (`CEO_TOPICS`: people, access, plans, machines).
- Plan 9: `FollowKeeper`, `CopyMaker`, `CopyReport`, the remake after a leader change; `SyncController` (`flag()`,
  `copies()`); `machines.server_order`, `disk_free`; the follow keeper's view with each data machine's number; the lab's
  `writer.ts`, `checkRows` and `relay()`.
- Plan 9b: `Ranking` and `rank` (`modules/copies/order.ts`; a run each minute, scoring at the app's first lead: the
  leader 1, the rest by score), `Ranking.now`, `machines.server_pin` with its unique index `machines_server_pin`,
  `InternetMeasures`.
- Plan 9c: `Taking`, `writeTaking`, `Promoter`, `nextTakeStep`, `TakeSample`, `promote.ts` (`writeTerm`,
  `recordHandover`), `seedView`, `net.handovers`, `SyncController.hold` and `held`.
- Plan 10, all of it, above all: `Beats`, `Beat`, `Stance`, `Heard` (`beats.ts`); `takeover-step.ts` (`Poll`, `Window`,
  `NO_WINDOW`, `nextWindow`, `windowOpenMs`, `relayBackMs`, `EMPTY_MS`, `RELAY_BACK_MS`, `nextWatchStep`, `WatchSample`,
  `nextEntryStep`, `EntrySample`, `EntryAction`, `mayTurnNormal`); `nextLeaseStep` with `split`, `proof`, `ended` and
  `entry`; `LeaseProofs` and its `ended()` (`proofs.ts`); the `Watcher` (`watch.ts`), its `take`, `syncBeat`,
  `linkAnswered`, `heard` and `promise`, `FOLLOWED_FILE`, `readFollowed`, `writeFollowed`, `promiseAnswer`; the leading
  keeper's entry, its `registering`, its follow path (`PEERS_FILE` from `seedView`, `REPLICA_FILE`, exit) and its
  turning normal of the CEO's term (`turnedNormal`, `normal_at`); `Taking.kind`, `generation`, `heard`, `reach`;
  `recordHandover`'s `kind`, `heardAt`, `reach`, `members`, `reason`; `net.handovers` with `kind` (`planned`,
  `takeover`, `ceo`), `members`, `normal_at`; `LedSaver` (`led.ts`) and `machines.copy_old_led`; `mergePending`, `park`
  and `parkedJobs` (`modules/nodes/parked.ts`) and the hello's parked jobs (its ruling 9); the switch word
  (`switch-word.ts`: `SwitchWord`, `switchWord`), `GET /api/network/switched`, `SwitchBanner`; the lab's `cut`, `mend`,
  `edge()`, `leaderOf`, `lateConfirms`.
- Main's turn failures, once merged into the branch, as plan 10 names them.
- Where the branch's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`; in Russian a plan is «тариф», and a hostname as
  the subject takes «Машина» before it, so the feminine verbs agree.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`, `.superpowers/`,
  `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it and the providers' public
  API hosts, no key, token, ssh config or certificate file, no company's link name. Tests use `127.0.0.1`, the
  documentation ranges, hosts under `hornhoof.test`, and keys and passwords made at run time.
- No new npm dependency. One new migration, `0059_splits`: `npx drizzle-kit generate --name splits` from `apps/server`
  for what `schema.ts` describes, with the hand-written part of Task 1 appended after a `--> statement-breakpoint`;
  never an edit of an older one. Its number follows plan 10's `0058`, and its journal `when` stays above 1793700000000,
  main's `0046_turn_failures` (the series renumbers at its merge, every migration above main's newest).
- A split only where no arbiter decides (spec 3.6): a machine goes on by itself only after 2 minutes, counted awake on
  the monotonic clock, in which it had internet, the relay answered none of its polls, and it heard no machine holding a
  lease; a machine with no internet never goes on by itself. While the relay answers, plan 10's rules hold and nothing
  splits.
- One normal term at a time (spec 3.6): a split term is always split; only the rule for turning normal (plan 10's,
  widened here) makes its successor normal, and only once the relay answers, its own client holds the name and every
  data machine of the last normal term follows it with its led database merged, or has left. Two machines confirm writes
  in overlapping periods only while one of them writes under a split term.
- No confirmed write is lost (spec 3.6, section 5): a split side only ever has what it confirmed itself and what
  replicated to it; a side that steps down saves and merges its database by plan 10's `LedSaver`.
- Hornhoof never moves the server back by itself; the order of the last normal term, never one a split leader wrote,
  decides who leads a side and who wins a meeting.
- Messages between keepers and apps change only by additions (spec section 9): a beat or hello without the new fields
  reads as `internet` true, `normal`, `order` and `members` null, `led` false, `able` true, and under `lead` `apart`
  false, `relay` true, `holds` false and `split` null.
- Ivan's rules: only a machine's owner opens computer access to it; no step of this plan asks Ivan to type a command.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; `npm run test:real` and `npm run test:lab` need Docker. Types, from the worktree root: `npx tsc
  -p apps/server/tsconfig.json --noEmit`, and `apps/web` likewise when touched, each printing nothing. Never run
  prettier.
- Before a real or lab run on the team lead's Mac: `df -h /` and `docker system df`; clean only build cache and
  `hornhoof-lab/*` images, never a volume.

## Rulings made while planning

1. **What this plan takes, and plan 11b** (deviation in form: the overview has one plan 11). The overview's plan 11
   entry is two plans, as plan 9 became 9, 9b and 9c. This plan, "who leads": the internet check, going on alone after 2
   minutes, split terms and leases, a side with several data machines following its best one, a side that is behind,
   workers staying with their leader, meeting through the relay and over the peer link with the saved order, staying
   split until the old leader answers, the order recomputed after a split's merge and a place pinned on two sides a CEO
   conflict, the countdown and banners, the text of a machine with no internet, and the cards' disk warning at 85%
   (moved here from plan 10, 2026-11-03). Plan 11b, "the work", next: `read` mode's read tools on `/mcp` and nodes
   connecting for status (plan 10's ruling 1), the write tools' cut-off answer, saved work folders through
   `GIT_INDEX_FILE` and their branches, "Go on here without Mac" with its saving list (it waits for the saving), the
   `git` wrapper, no double work (free tasks, a behind side's old tasks, orchestrator turns), the agents' prompt on a
   behind side, jobs on a machine that cannot be reached (the 30-minute wait, superseded jobs and their move message),
   and section 4's rows about them. Plan 11b depends on this one; its entry goes into the overview with this plan's
   approval.
2. **The internet check** (spec 3.6, Call). Every data keeper runs `InternetCheck`: every 10 s one round of HTTPS `HEAD`
   requests, one after another, each with a 5 s timeout and certificates checked, to the API host of each provider whose
   plans have a node on this machine (read from its own database each minute, nothing when it cannot read), then
   `https://github.com/`; the round stops at the first answer. Any HTTP answer counts; a TLS or network error does not,
   so a captive portal does not count. `internet` is whether the last round had an answer, and before the first round
   ends it is false. The hosts: `claude` and `anthropic_api` `https://api.anthropic.com/`, `codex` and `openai_api`
   `https://api.openai.com/`, `kimi` `https://api.kimi.com/`, `glm` `https://api.z.ai/`, `antigravity`
   `https://generativelanguage.googleapis.com/`. `HORNHOOF_INTERNET_URLS` (comma separated) replaces the whole list,
   with `HORNHOOF_INTERNET_CA` the CA it trusts, for the lab only. Plan 9b's own ping stays as it is.
3. **The last normal term** (spec 3.6, "Each keeper keeps that order in `net_local` whenever it follows a normal term";
   deviation in form: the keeper's volume, `last-normal.json`, since a copy's remake and a takeover change its
   database). Each keeper keeps the last normal term it led or followed: the term, its leader, when it last heard that
   leader, the sync copy that leader's last heartbeat named "on" (null when it said off), the server order of that term
   (each numbered data machine's network id and number) and its members (every live data machine of that term, numbered
   or not, since plan 9b leaves some without a number). The leading keeper writes it while it holds a normal lease, from
   its own rows; the follow keeper on each beat from its leader that says `lead` with a normal lease, the order and
   members from its view. A split term never writes it, so "never the 1 a split leader wrote for itself" holds (spec,
   Codex round 7). A keeper that goes on from, or while leading apart hears, a higher normal term than its own carried
   by another machine of its side notes that term as its own (rulings 6 and 10).
4. **Heartbeats carry what a side needs** (plan 10's beats, by additions). A beat gains `internet`; `normal` (the term,
   leader and sync copy of its last normal term), `order` and `members` (that term's); `led`; and `able`. `led`: on a
   follow keeper that holds a database that led and is not dropped yet, from the moment it steps down until the swap
   drops that database once its merge is `merged` or `done`: `hornhoof`'s `net_local.state` has a row with no
   `handed_to` (plan 9c's mark of a database that led), or its copy report's `old.led` is set; recording the bundle
   never clears it. `able`: it could lead now: its database took its last lease write, no update promise or planned
   switch holds it, and no take of its own failed in the last 2 minutes. A `lead` stance gains `apart` (it leads under a
   split term of kind `split`), `relay` (its last poll had a usable answer: route and health both answered, health up),
   `holds` (its last known route is its own client's at the generation it registered plus one) and `split` (`since`,
   `lost` and `behind`, what its page says, ruling 12). A hello gains `apart` and `split`.
5. **Going on alone** (spec 3.6, section 4). Each data keeper that holds no lease counts the time, awake on the
   monotonic clock, in which `internet` was true, the relay answered none of its polls (route or health), the leader
   answered none of its probes at the link, and no beat within 5 s said `lead`. The count starts over when any of these
   fails, on a late tick (plan 3's `LATE_MS`) and at a keeper's start. A follow keeper counts only while its copy is
   `ready`; the leading keeper counts from the end of its lease. After 2 minutes, a keeper that is its side's leader
   (ruling 6) goes on: the leading keeper takes a split term from its entry, and a follow keeper's `Watcher` takes over
   with a `Taking` of kind `split` (a new row of `nextWatchStep`, before the row of `held`, since a route answer from
   before the relay went is stale). Plan 10's entry now follows only on evidence of a leader that is there now (change
   to plan 10's ruling 4, Codex): a beat within 5 s saying `lead` under a higher term of another machine, B's answer
   saying `lead`, or a route answered within the last 3 s whose maker is another client; a higher term seen only in a
   follow beat, or a route read before the relay went, raises the next term's number and makes it follow no one, so an
   old leader is never left following a machine that is gone. The new row of `nextEntryStep` comes right after those. A
   machine with no internet never counts, so it never goes on by itself (plan 11b gives it "Go on here").
6. **One leader per side** (spec 3.6, "Several data machines on one side"). A side is this machine and every data
   machine whose beat came within 5 s, either way, says `internet` and `able`, and is `ready` or the last normal leader.
   Its leader is, of those: the last normal term's leader; else its sync copy, when that leader's last heartbeat named
   it "on"; else the lowest number in the last normal term's order, those with no number last by network id. The last
   normal term is the highest any of them carries, with its own order and members; the side's leader goes on from that
   term, noting it as its own (ruling 3). The others keep counting and follow the side's leader once it leads, as after
   a takeover: plan 9's remake when it is not the machine they copied, nothing when it is. A machine that cannot lead
   says `able` false and drops out of the choice, so the next one goes on (a full disk, an update, a failed take). Two
   machines of one side that decide differently both lead, and meet by ruling 9 within seconds.
7. **The split term and lease** (spec 3.6). The split term is (n, self, split), n above every number the keeper knows:
   its own state's, `followed.json`'s `max`, the last normal term's and every beat's. Either way of going on records a
   handover of kind `split`: `from` the last normal leader (itself when it was), `to` itself, `members` the other
   members of that last normal term, `heard_at`, `reach` its copy's reach, `behind`, and `lost` (the machine it lost:
   the last normal leader, else that leader's sync copy, else the first other member by number). The leading keeper
   records it first, then resets `synchronous_standby_names` (`ALTER SYSTEM RESET`, then `pg_reload_conf()`), "the only
   time it may without the relay", calls `sync.hold(true)`, and takes a lease of exactly that term, of kind `split`
   since the kind comes from the term it takes, not from its old one (change to plan 10's `nextLeaseStep`); a restart
   between finds the handover and takes its term, after plan 10's follow rows, without counting again. A copy promotes
   through plan 9c's `Promoter` with no registration, no probe, no slots and no deadline, its term written split and
   `sync.hold(true)` before `leads()`; its steps stay plan 9c's, so a restart after any of them finishes the rest and
   only a finished promotion leads. A keeper leads apart while the newest handover naming it `to` is of kind `split`
   with `normal_at` null and its state's term is split: holding no lease, it takes a split lease at once (the next term,
   as plan 10's CEO term after its promotion, but with no registration), renews it with no proof, keeps its link frpc
   stopped until `nextMeetStep` registers, and runs `nextMeetStep` (ruling 8) in place of plan 10's entry. A side is
   behind unless it goes on from the last normal leader, or from that leader's sync copy when the leader's last beat
   that this run of the keeper heard named it "on" and its countdown began at the first tick after that beat was 5 s old
   (within 7 s of it, so no beat was missed between; spec: "within 5 s before the loss"; a beat read back from a file
   after a restart proves nothing). The split leader is number 1 in its own database, the others after it in their order
   (spec 3.3; section 12, "each 1 in its own copy"); nothing is scored again until its term turns normal (ruling 10),
   and the saved order of ruling 3 stays as it was.
8. **Meeting through the relay** (spec 3.6 "Meeting", section 4's row). A split leader of kind `split` polls the route
   and health each second. A route answered within the last 2 s and held by another client makes it step down within 2
   s, whatever health said. With a usable answer (route and health, health up) and the route empty, it registers at that
   generation once the window has been open 12 s if its own client made the route (it believes it held the last normal
   term) and 27 s if not, and the relay has answered every poll for 25 s since it last failed to (plan 10's check 3,
   kept for safety, counted from the relay coming back to this machine and not only from a relay restart; deviation in
   form: the spec names only the window). Its own route at exactly that generation plus one is the name held; at any
   other generation its frpc stops and the window starts again (plan 10's exact successor). It keeps its split lease
   throughout and stays split. Stepping down is plan 10's follow path: the lease fenced (`ended`), the link frpc
   stopped, `PEERS_FILE` from `seedView`, `REPLICA_FILE`, exit; its database led, so plan 10's `LedSaver` saves and
   merges it.
9. **Meeting over the peer link** (spec 3.6). A split leader of kind `split` with no usable relay answer steps down when
   it hears either two beats at least 2 s apart, the newer within 5 s, from one machine saying `lead` and either `apart`
   false with a term at or above its own last normal term (a newer leader, or the last normal leader still leading; two
   beats, since an old leader waking with a lagging clock says `lead` once before its late tick fences it), or `apart`
   and `holds` true while it does not hold the name itself; or a beat saying `lead` with `apart` true and `relay` and
   `holds` false from a leader that `meetWinner` prefers, while it does not hold the name itself. `meetWinner`: the
   leader of the higher last normal term (each side's own `normal`); else the one with the lower number in both sides'
   saved orders; else, when the two orders disagree, the lower network id. A leader that holds the name never steps down
   over the peer link for one that does not, and one that is not apart (normal, or the CEO's term of plan 10, which
   holds the name) never steps down for an apart one: plan 10's `ended` on "a beat saying `lead` under a higher term"
   now counts only beats with `apart` false, and none while the keeper itself leads apart (change to plan 10's ruling
   2); a higher takeover or CEO term still ends a normal leader's lease. So two leaders never both step down: through
   the relay only the one that does not hold the route gives way, and over the peer link the one that does not hold the
   name, or that loses by `meetWinner`, which both sides compute from the same saved terms.
10. **Staying split until everyone answers** (spec 3.6). Plan 10's turning normal widens from the CEO's term to every
    split term: the newest handover of kind `ceo` or `split` naming this machine `to`, with `normal_at` null; each
    member must follow its term with `led` false, or have no live row. A machine following it whose beat carries a
    normal term above its own notes that term (ruling 3), and that term's members join the handover's `members` (one
    update, one log line), so a member it never knew must answer too. Then the normal take of M + 1, `turnedNormal`, and
    the ranking: plan 9b's `Ranking` runs at the app's first lead under a normal term and again each time the keeper's
    term turns from split to normal (`KeeperState.split`); under a split term only ruling 7's number 1 (change to plan
    9b's trigger and to plan 10's CEO term, which ranked at its first lead). So after a merge the order is computed
    again (spec section 12); a place pinned to two machines on two sides is a conflict of the topic `machines`, the
    CEO's, by plan 8's unique-key rule. Plan 10's `mergePending` also holds while this machine's term is split, and
    while any other live data row is `saving` or has `copy_old_led`, its led merge not `merged` or `done`. And a job a
    node lists at hello that the leader has no row of is no longer cancelled at hello: it is parked as during a pending
    merge (plan 10's `listed`) and cancelled only once no merge has been pending for 5 minutes with still no row of it
    (change to plan 10's ruling 9, Codex: a stepped-down side's node, or its worker's, may say hello to a winner that
    stayed normal and recorded no handover, before any row says that side is saving).
11. **Workers, and copies, stay with their leader** (spec 3.6 "Workers"). `PeerLink.leader()` keeps the target it named
    last while that target's hello says `lead`, unless another hello says `lead` with `apart` false and a higher term
    (plan 10's takeover); else it takes the highest term (plan 10's rule) and keeps that one. So a worker never flips
    between two split leaders, and moves when its leader steps down. A follow keeper's `followed.json` names the exact
    term of the leader it follows now, written whenever that leader or its term changes, even below the one before,
    since a meeting's winner may hold a lower split term; it keeps the highest term it ever followed or granted as
    `max`, which numbers new terms and which B's promise must exceed (change to plan 10's ruling 6, which only ever
    raised the one term).
12. **The page** (section 2 "Cut off, with internet", section 4). The keeper's switch word (plan 10's ruling 11) gains
    `alone` (the countdown's end, who was lost, and how far its changes reach when it would go on behind), `apart`
    (since when, the machine lost, and how far a behind side's changes reach), `noInternet` and `merging`. A copy or
    worker that follows a split leader says that leader's `apart`, from its beat or hello. Plan 10's "Lost Debian"
    moving line for a leader that does not answer is not shown while the countdown runs or the machine has no internet,
    so the countdown shows from its start; a takeover or planned switch under way still shows first. The banners: "Lost
    Mac and hornhoof.org. Going on by itself in 1:40; changes from both sides are merged later." while it counts, with
    "This side has Debian's changes up to 23:40 only." when it would go on behind; "Working apart from Mac since 14:02."
    while its side's term is split, with that line again when behind; "This machine has no internet and cannot reach
    Mac, so it stopped taking changes. You can read everything." on a machine with no internet that does not lead; "Back
    in touch with Mac; merging." on a machine that stepped down until its led database is merged. The card of a data
    machine whose disk is 85% full or more says so (section 4), from the keeper's report, which gains `diskTotal`. The
    texts beyond the spec's are the team lead's to rule on.
13. **Timing** (section 4, 3.10). Relay down at 0 with the leader and its sync copy in two homes: the leader's lease
    ends by 10 s and it goes on at about 130 s; the copy heard its last beat at 0, so it goes on at about 125 s. Relay
    back at R: the old leader registers at R + 25 s; the other side, whose own window would open only at R + 27 s, sees
    the name held at its next poll and steps down by about R + 27 s; it is merged, and the old leader turns normal once
    its merge is done. Over the peer link with no relay, the loser steps down within a second of the first beat it hears
    from the winner, or of the second beat, 2 s after the first, from a newer normal leader.

## Review Focus

1. Two leaders on one side, or two normal terms: a split leader turning normal while a member still leads or its led
   database waits for its merge (also between its bundle and its remake), or before a member it never knew answers; a
   copy going on while a beat says `lead`; a split term whose number equals a normal term the side never saw. Tests in
   Task 3 (`says its database waits for a merge`), Task 4 (`never turns normal while a member's merge waits`, `meets by
   the saved order`) and Task 6 (`turns a split term normal only after the merge`, `waits for a member it learns of`).
2. No leader for good: two split leaders each stepping down to the other (one holding the name loses the relay while the
   other gains it, or an old leader's single `lead` beat after sleep), an old leader following a machine that is gone, a
   side whose chosen machine cannot lead, a promoted copy that never reaches its lease, a countdown that never ends
   because one provider fails. Tests in Task 4 (`steps down only on two beats`, `never yields both ways`, `follows only
   a leader that is there`), Task 5 (`goes on when the side's first choice has no internet`, `passes over a machine that
   cannot lead`, `leads after its promotion`) and Task 6 (`stays when it holds the name`).
3. A confirmed write lost or a job cancelled: a stepped-down side's node, or its worker's, saying hello to a winner that
   stayed normal before any row says that side is saving. Tests in Task 6 (`parks a job it does not know`).
4. Going on when it must not: a machine with no internet, a copy not `ready`, a keeper waking from sleep (a late tick),
   a relay that answers one poll in the two minutes, a leader still answering at the link, a sync copy whose last word
   from the leader is an hour old. Tests in Task 4 (the countdown's table, `knows when a side is behind`).
5. People's side: a worker flipping between two split leaders, the countdown hidden behind "Lost Debian", a copy on a
   split side with no banner, a behind side not saying so. Tests in Task 7 and Task 8.

---

### Task 1: The split's columns

**Repo:** the `network` worktree, branch `network`. **Starts from:** plan 10's last task committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/split-tables.test.ts test/migrations.test.ts`
passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/drizzle/0059_splits.sql` (with its `meta/` snapshot and journal entry, as drizzle-kit writes
  them; the journal `when` above 1793700000000)
- Modify: `apps/server/src/db/schema.ts` (`machines.disk_total`)
- Test: `apps/server/test/split-tables.test.ts` (new), `apps/server/test/migrations.test.ts`

**Interfaces:**
- Consumes: plan 9c's `net.handovers` and plan 10's `kind` check on it; `machines` of plan 9.
- Produces:
  - `net.handovers`' `kind` check takes `split` beside `planned`, `takeover` and `ceo` (dropped and made again by its
    name), and it gains `behind boolean NOT NULL DEFAULT false` and `lost text` (the network id of the machine a split
    lost, ruling 7); raw SQL in the hand-written part, as plans 9c and 10 keep `net` tables, no Drizzle model.
  - `machines` gains `disk_total bigint` (bytes, the keeper's last report), from `schema.ts` (`diskTotal`).

- [ ] **Step 1: Write failing tests.** `split-tables.test.ts`, on `createTestSql`: `records a split`: a handover of kind
  `split` with `behind` true and `lost` `'b…'` reads back; kind `other` fails the check; one inserted without `behind`
  reads false and `lost` null. `keeps a machine's disk size`: `disk_total` null on a new row, takes 500107862016.
  `migrations.test.ts`'s count of migrations grows by one.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no such column).
- [ ] **Step 3: Implement** `schema.ts`, then `npx drizzle-kit generate --name splits` and the hand-written part.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the split kind of handover, what it lost and each machine's disk size".

### Task 2: The internet check, the disk size and the last normal term

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/internet-check.test.ts test/last-normal.test.ts
test/measures.test.ts test/network-report.test.ts test/keeper.test.ts test/follow-keeper.test.ts` passes (the existing
files of those modules where a name differs), then the whole server suite; `npx tsc -p apps/server/tsconfig.json
--noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/internet-check.ts`, `apps/server/src/modules/keeper/last-normal.ts`
- Modify: `apps/server/src/modules/keeper/measures.ts` (`diskTotal`), the report route of plan 5 (`POST
  /api/network/report` writes `disk_total`), `apps/server/src/modules/keeper/keeper.ts` and `follow.ts` (run the check,
  keep the last normal term)
- Test: `apps/server/test/internet-check.test.ts` (new), `apps/server/test/last-normal.test.ts` (new), and the existing
  tests of the modified modules

**Interfaces:**
- Consumes: plan 5's `Measures`; plan 10's `Beats.last`, `Stance`; plan 9's follow keeper view (each data machine's
  `networkId` and `number`); `PROVIDERS` of today; plan 9b's `InternetMeasures` (only its way of trusting a test CA).
- Produces:
  ```ts
  // modules/keeper/internet-check.ts
  export const INTERNET_EVERY_MS = 10_000;
  export const INTERNET_TIMEOUT_MS = 5_000;
  export const GITHUB_URL = 'https://github.com/';
  export const PROVIDER_URLS: Readonly<Record<Provider, string>>;   // ruling 2's hosts, exactly
  export function internetUrls(providers: readonly Provider[], env?: string): string[];
  //   env (HORNHOOF_INTERNET_URLS) split on commas when set; else each provider's URL once, in PROVIDERS order, then
  //   GITHUB_URL
  export class InternetCheck {
    constructor(opts: { urls: () => string[]; ca?: string; everyMs?: number; timeoutMs?: number;
      now?: () => number; log?: (line: string) => void });
    start(): void; stop(): void;
    round(): Promise<void>;     // HEAD each URL in turn, node:https, rejectUnauthorized; stops at the first answer
    internet(): boolean;        // the last round had an answer; false before the first round ends
    since(): number | null;     // monotonic ms of the last change, null before the first round
  }
  export function machineProviders(sql: Sql, machineId: string): Promise<Provider[]>;
  //   the distinct subscriptions.provider of the nodes whose machine_id is this machine's row; [] on any error
  // modules/keeper/last-normal.ts
  export const LAST_NORMAL_FILE = 'last-normal.json';   // the keeper's volume, 0600, written whole and then moved
  export type LastNormal = { term: Term; leader: string; heard: number; sync: string | null;
    order: { networkId: string; number: number }[]; members: string[] };
  //   leader, sync, order and members: network ids; heard: wall ms of the newest beat from the leader (for itself,
  //   now); sync: the copy the leader's newest beat named "on", null when it said off; order: by number; members:
  //   every live data machine of that term, numbered or not, the leader included
  export function readLastNormal(dir: string): LastNormal | null;   // null when missing or of another shape
  export class NormalKeeper {
    constructor(opts: { dir: string; now?: () => number; heardEveryMs?: number });   // 5000
    note(n: LastNormal): void;   // writes when term, leader, sync, order or members changed, or heard moved by
                                 // heardEveryMs
    last(): LastNormal | null;   // what it holds, read from the file at construction
  }
  // modules/keeper/measures.ts: snapshot() gains diskTotal: number (statfs(dir).blocks * bsize)
  ```
- `round`: a request that answers any HTTP status is an answer (its body is not read; the socket is destroyed); a
  timeout, a reset or a certificate error is not. One round at a time; a round that takes longer than `everyMs` delays
  the next. Each change of `internet()` is one log line: "The internet answers again." and "The internet does not answer
  (tried <n> hosts)."
- Each data keeper (leading, taking, follow) runs one `InternetCheck` from its start to its stop, `urls` from
  `internetUrls(<the providers machineProviders read last, each minute>, process.env.HORNHOOF_INTERNET_URLS)`, and, only
  when `HORNHOOF_INTERNET_URLS` is set, `ca` read from the file `HORNHOOF_INTERNET_CA` names (the lab's stub).
- `NormalKeeper.note` is called by the leading keeper each `linkEveryMs` while it holds a lease of kind `normal`: its
  term, itself, now, the `sync` of its own beat, its data rows with a network id and a `server_order` as the order, and
  every live data row as the members; and by the follow keeper on each beat, either way, from its view's leader whose
  stance is `lead` with lease `normal`: that term, that leader, the beat's time, its `sync`, its view's data machines
  with a number as the order, and every data machine of its view as the members. A split lease or a beat with lease
  `split` notes nothing.
- The report route writes `disk_total` from the report's `diskTotal` beside `disk_free`; a report without it leaves the
  column as it is.

- [ ] **Step 1: Write failing tests.**
  - `internet-check.test.ts`, with three local HTTPS servers made by the test with a test CA (one answering 404, one
    whose certificate is for another name, one that never answers) and a closed port:
    - `counts any answer`: the 404 server alone: `internet()` true after one round.
    - `does not count a bad certificate or silence`: the wrong-name server, the silent one (timeout 200 ms in the test)
      and the closed port: false, and the round took about 200 ms for the silent one.
    - `stops at the first answer`: the 404 server first and a counting server second: the second got no request.
    - `starts false`: before the first round ends, `internet()` false and `since()` null.
    - `lists the hosts`: `internetUrls(['codex', 'claude', 'anthropic_api'])` is `['https://api.anthropic.com/',
      'https://api.openai.com/', 'https://github.com/']`; with env `'https://a.hornhoof.test/,https://b.hornhoof.test/'`
      those two only.
    - `reads the machine's providers`: on `createTestSql`, two nodes of this machine on a `claude` and a `glm` plan and
      one node of another machine on `kimi`: `['claude', 'glm']`; a broken `sql`: `[]`.
  - `last-normal.test.ts`: `keeps the last normal term`: `note` then a new `NormalKeeper` on the same folder: `last()`
    the same; `writes only on a change`: two notes with the same fields 1 s apart: one write; 6 s apart: two; a file of
    another shape: `readLastNormal` null.
  - `measures.test.ts`: `reports the disk size`: `diskTotal` is a positive whole number at least `diskFree`.
  - `network-report.test.ts`: `keeps the disk size`: a report with `diskTotal` sets `disk_total`; one without leaves it.
  - `keeper.test.ts`, `notes its normal term`: a leading keeper holding a normal lease, with data rows B numbered 2 and
    D with no number: `last-normal.json` names it with the order (itself 1, B 2) and the members (itself, B and D);
    holding a split lease: the file unchanged.
  - `follow-keeper.test.ts`, `notes the leader's normal term`: beats from the leader saying `lead` normal with `sync`
    this copy: the file names that term, the leader and `sync`; then a beat with `sync` null: `sync` null; a beat saying
    `lead` split: unchanged.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Check the internet, report each machine's disk size and keep the last normal term".

### Task 3: Heartbeats say what a side needs

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/beats.test.ts test/peer-link.test.ts
test/keeper.test.ts test/follow-keeper.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/src/modules/keeper/beats.ts` (`Beat`, `Stance`, `parseBeat`), `apps/server/src/net/peer-link.ts`
  (`Hello.apart`, `Hello.split`), `apps/server/src/modules/keeper/keeper.ts` and `follow.ts` (what each beat says; the
  leading keeper's polls)
- Test: the existing tests of the modified modules

**Interfaces:**
- Consumes: Task 1's `lost`; Task 2's `InternetCheck.internet()`, `NormalKeeper.last()`; plan 10's `Beats`, `Stance`,
  `Beat`, the leading keeper's polls of `route` and `health` and its `registering`, `LedSaver`, the copy report's
  `old.led`; plan 9c's `net_local.state` and its `handed_to`, `promise.json`, `Taking`; plan 3's `problems()`.
- Produces:
  ```ts
  // modules/keeper/beats.ts
  export type NormalView = { term: Term; leader: string; sync: string | null };   // network ids
  export type SplitView = { since: string; lost: string; behind: string | null };
  //   since: ISO, the split handover's at; lost: its network id; behind: ISO, its reach when behind, else null
  //   Stance's lead gains apart, relay, holds and split:
  //   | { kind: 'lead'; term: Term; lease: LeaseKind; sync: string | null; until: number; apart: boolean;
  //       relay: boolean; holds: boolean; split: SplitView | null }
  //   Beat gains internet: boolean; normal: NormalView | null; order: string[] | null; members: string[] | null;
  //   led: boolean; able: boolean
  //   parseBeat: a beat without them reads internet true, normal, order and members null, led false and able true; a
  //   lead stance without them reads apart false, relay true, holds false and split null; a field of the wrong type
  //   refuses the whole beat (null)
  // net/peer-link.ts: Hello gains apart: boolean (false when missing) and split: SplitView | null (null when missing)
  ```
- Every beat: `internet` from the keeper's `InternetCheck`; `normal`, `order` (its network ids by number) and `members`
  from its `NormalKeeper.last()`, null without one; `led` as ruling 4 says, true on a follow keeper while `hornhoof`'s
  `net_local.state` has a row with no `handed_to` or its copy report's `old.led` is set, so it never drops between the
  bundle's record and the remake's report; `able` false while its last write to its own database failed (plan 3's
  `problems()` not empty on a leading keeper, its copy maker's last check failing on a follow keeper), `promise.json` or
  a planned switch's offer holds it, or a `Taking` or a split take of its own failed or aborted in the last 2 minutes.
- A `lead` stance: `apart` true while the newest `net.handovers` row naming this machine `to` is of kind `split` and the
  held term is split (read with the lease each tick); `relay` true when its last poll was usable (the route and health
  both answered and health said up); `holds` true while its last known route is its own client's at `registering + 1`;
  `split`, while `apart`, from that handover (`since` its `at`, `lost` its `lost`, `behind` its `reach` when `behind`).
  The leading keeper polls `route` and `health` each second at all times, not only while it holds no lease (plan 10's
  polls, the same `Poll`). The hello's `apart` and `split` are the stance's.

- [ ] **Step 1: Write failing tests.**
  - `beats.test.ts`, `reads the new fields and the old beat`: a beat with all fields parses to them; one of plan 10's
    shape parses with `internet` true, `normal`, `order` and `members` null, `led` false, `able` true and, under `lead`,
    `apart` false, `relay` true, `holds` false and `split` null; `internet: 'yes'` refuses the beat.
  - `peer-link.test.ts`, `reads apart in a hello`: a hello with `apart` true and a `split`, and one without either
    (false, null).
  - `keeper.test.ts`, `says it leads apart`: a split lease under a `split` handover to itself: the beat's stance has
    `apart` true and `split` with that handover's `at`, `lost` and, when `behind`, `reach`; under a `ceo` handover:
    `apart` false and `split` null. `relay`: true when the fake relay answers route and health, false when it answers
    health only. `holds`: true once its route is its own at `registering + 1`. `internet` follows a fake check;
    `normal`, `order` and `members` come from `last-normal.json`.
  - `follow-keeper.test.ts`:
    - `says its database waits for a merge`: a database that led (its `net_local.state` row with no `handed_to`) while
      its `LedSaver` runs: `led` true; after `done()` and before the remake reports `old`: still true; with the report's
      `old.led` set: true; once the swap dropped it (`old` null, no such row): false.
    - `says when it cannot lead`: `promise.json` held: `able` false; a `Taking` aborted 60 s ago: false; 130 s ago:
      true.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Say in each heartbeat whether a machine has internet and can lead, its last normal term and
  whether it leads apart".

### Task 4: The split's decisions, as pure functions

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 3 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/split-step.test.ts test/takeover-step.test.ts
test/switch-step.test.ts test/taking.test.ts test/lease.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/split-step.ts`
- Modify: `apps/server/src/modules/keeper/takeover-step.ts` (`WatchSample.alone`, `EntrySample.alone` and `leadBeat`,
  the new and changed rows, `mayTurnNormal`), plan 9c's `switch-step.ts` (`TakeSample.kind` gains `split`, its rows),
  plan 9c's `taking.ts` (`Taking.kind` gains `split`, in the type and its parse only), plan 10's
  `apps/server/src/modules/keeper/lease.ts` (`nextLeaseStep`, the kind of a take)
- Test: `apps/server/test/split-step.test.ts` (new), `apps/server/test/takeover-step.test.ts`,
  `apps/server/test/switch-step.test.ts`, `apps/server/test/taking.test.ts`, `apps/server/test/lease.test.ts`

**Interfaces:**
- Consumes: plan 10's `Poll`, `Window`, `windowOpenMs`, `relayBackMs`, `EMPTY_MS`, `RELAY_BACK_MS`, `GAP_MS`,
  `WatchSample`, `WatchAction`, `EntrySample`, `EntryAction`, `mayTurnNormal`; plan 3's `Term`, `Clocks`; Task 2's
  `LastNormal`; Task 3's `NormalView`.
- Produces:
  ```ts
  // modules/keeper/split-step.ts
  export const ALONE_MS = 120_000;          // spec 3.6: 2 minutes, awake
  export const NEAR_MS = 5_000;             // a side: beats within this, either way
  export const MEET_EXTRA_MS = 15_000;      // the window of a side that did not make the route
  export const STEP_DOWN_GAP_MS = 2_000;    // two lead beats this far apart before a split leader steps down
  export const ROUTE_FRESH_MS = 2_000;      // a route answer this new names the holder, whatever health says
  export function leadNear(beats: readonly { at: number; lead: boolean }[], now: number): boolean;
  //   some beat says lead and now - at < NEAR_MS (monotonic ms, either way)
  export type AloneSample = { now: number; late: boolean; counting: boolean; internet: boolean;
    relayAnswered: boolean; linkAnswered: boolean; leadHeard: boolean };
  //   now: monotonic ms; late: this tick came LATE_MS or more after the last; counting: a follow keeper whose copy is
  //   ready, or a leading keeper holding no lease; relayAnswered: a route or health poll answered since the last
  //   sample; linkAnswered: a probe at the link answered by the leader's machine since the last sample; leadHeard:
  //   leadNear of its beats
  export function nextAlone(since: number | null, s: AloneSample): number | null;
  //   null when !counting, late, !internet, relayAnswered, linkAnswered or leadHeard; else since ?? now
  export function aloneLeftMs(since: number | null, now: number): number | null;   // ALONE_MS - (now - since), >= 0
  export type SideNormal = { term: Term; leader: string; sync: string | null; order: string[];
    members: string[] };
  export type SideMember = { networkId: string; able: boolean; normal: NormalView | null; order: string[] | null;
    members: string[] | null };
  export function sideLeader(o: { self: SideMember; others: SideMember[]; own: LastNormal | null }):
    { leader: string | null; normal: SideNormal | null };
  //   others: data machines whose beat came within NEAR_MS, either way, saying internet, that are ready or the leader
  //   of their normal term; ruling 6. normal: the term the leader goes on from, with its order and members
  export function isBehind(self: string, normal: { leader: string; sync: string | null } | null,
    syncFresh: boolean): boolean;
  //   syncFresh: the answer of syncFresh below for its sync beat and its countdown's start
  export const SYNC_FRESH_MS = 7_000;       // the countdown starts at the first tick after the last beat is NEAR_MS old
  export function syncFresh(syncBeat: number | null, since: number | null): boolean;
  //   syncBeat: monotonic ms at which this run of the keeper heard the leader's newest beat, when that beat named self
  //   "on", else null; true when both are set and since - syncBeat < SYNC_FRESH_MS
  export function splitTerm(self: string, seen: readonly (Term | null)[]): Term;   // (highest number + 1, self, split)
  export type MeetLeader = { networkId: string; normal: Term | null; order: string[] | null };
  export function meetWinner(a: MeetLeader, b: MeetLeader): string;   // a network id; the same for (b, a)
  export type HeardLead = { networkId: string; term: Term; apart: boolean; relay: boolean; holds: boolean;
    normal: Term | null; order: string[] | null; first: number; last: number };
  //   a machine whose beats, either way, say lead: first and last monotonic ms of the run of such beats with no gap
  //   of NEAR_MS or more; apart, relay, holds and normal from the newest
  export type MeetSample = { now: Clocks; self: MeetLeader; client: string; poll: Poll; window: Window;
    route: { state: 'held' | 'empty'; client: string | null; generation: number; sent: number } | null;
    reached: number | null; registering: number | null; tunnel: boolean; leads: HeardLead[] };
  //   for a keeper leading under a split term of kind split; poll: this tick's (null: none answered); route: the last
  //   known answer, sent its poll's monotonic send time; reached: monotonic ms since which every poll was usable,
  //   null when the last was not; registering, tunnel, client: as plan 10's EntrySample
  export type MeetAction = { do: 'none'; why: string } | { do: 'register'; generation: number } | { do: 'stop' }
    | { do: 'yield'; why: string };
  export function nextMeetStep(s: MeetSample): MeetAction;
  // takeover-step.ts
  //   WatchSample gains alone?: boolean (false when left out: its countdown reached ALONE_MS and sideLeader names
  //   itself); WatchAction's take gains kind 'split'
  //   EntrySample gains alone?: Term | null (the split term to take, as Task 5 sets it; null when left out) and leadBeat?: Term | null (the highest term of a beat within NEAR_MS saying
  //   lead; left out, latest, as plan 10 had it, until Task 5 passes it)
  //   mayTurnNormal(o: { split: boolean; kind: 'planned' | 'takeover' | 'ceo' | 'split' | null; relayUp: boolean;
  //     holdsRoute: boolean; members: string[]; following: (networkId: string) => boolean;
  //     led?: (networkId: string) => boolean; live: (networkId: string) => boolean }): boolean   // led: none, left out
  // switch-step.ts: TakeSample.kind gains 'split'; taking.ts: Taking.kind gains 'split', parsed as the others
  ```
- `sideLeader`: N is the highest term among `own`'s and each member's `normal` (`self` included), with that view's
  leader and sync; its order and members are `own`'s when `own` is N's, else those of a member whose `normal` is N. The
  candidates are `self` and `others` with `able` true. Then: N's leader when a candidate; else N's sync when set and a
  candidate; else the candidate first in the order, those not in it last by network id; with no N, the lowest network
  id; with no candidate, null.
- `isBehind`: false when `normal` names `self` its leader, or its sync with `syncFresh`; else true.
- `meetWinner`: when the two `normal` terms differ, the one whose `networkId` is the leader of the higher term (by
  number, then machine) wins if it is `a` or `b`; else each `order` that holds both says which is first: the one both
  say, else (they disagree, or neither holds both) the lower network id.
- `nextMeetStep`, the first row that matches; "usable" is `poll` set with `health.up` and its route known; "it holds the
  name" is `route` held by `client` at `registering + 1`; "the window" is `EMPTY_MS` when `route.client` is `client`,
  else `EMPTY_MS + MEET_EXTRA_MS`; a lead "near" has `last` within `NEAR_MS` of now, "twice" with `last - first` at
  least `STEP_DOWN_GAP_MS`:

  | When | Action |
  |---|---|
  | `route` held by a client not `client`, `now - route.sent` under `ROUTE_FRESH_MS` | yield `another machine holds the name` |
  | usable, it holds the name | none `holds the name` |
  | usable, `route` held by `client` at another generation (or `registering` null), `tunnel` | stop |
  | usable, `tunnel` | none `registering` |
  | usable, `route` empty, window open the window, `relayBackMs` and `now - reached` both `RELAY_BACK_MS` | register at its generation |
  | usable | none `the relay's window` |
  | a lead not `apart`, near and twice, term at or above `self.normal` | yield `<networkId> leads under term <number>` |
  | it does not hold the name, a lead `apart` and `holds`, near and twice | yield `<networkId> holds the name` |
  | it does not hold the name, a lead `apart`, not `relay`, not `holds`, near, `meetWinner(self, it)` names it | yield `<networkId> wins the meeting` |
  | otherwise | none `apart` |

- `nextWatchStep` gains, right after its first row (not `ready`, `holds`, or no leader): `alone`: take `split`, why
  `alone for 2 minutes`.
- `nextEntryStep`, the rows after "not `needed`": plan 10's "`latest` above `ownTerm` and of another machine: follow"
  becomes "`leadBeat` above `ownTerm` and of another machine: follow"; plan 10's "`route` known, its `client` set and
  not `client`: follow" holds only for a route answered within `GAP_MS` (`now` minus `route.sent`); after those and "B's
  answer says `lead`", a new row: `alone` set: take, `sent` now, that term. `latest` still numbers the next term (ruling
  5).
- `nextTakeStep` (plan 9c, with plan 10's kinds) gains a row right after "`go`, `termWritten`: promote": "`go`, kind
  `split`: promote". So a `Taking` of kind `split` never registers, never probes and never aborts at its deadline; a
  restart at any step promotes again (plan 9c's steps are idempotent), and only `promoted` leads.
- `nextLeaseStep` (plan 10's): a take's kind is `split` when `entry.term` is set and split, else as plan 10 says, so a
  normal leader's split take (Task 5) takes a split lease.
- `mayTurnNormal`: `split`, `kind` `ceo` or `split`, `relayUp`, `holdsRoute`, and each of `members` either `following`
  and not `led`, or not `live`.

- [ ] **Step 1: Write failing tests.** `split-step.test.ts`:
  - `counts two minutes alone`, a table of `nextAlone` from null, a sample each second: counting with internet, no
    relay, no link and no lead from 0 to 120 s: `since` 0 and `aloneLeftMs` 0 at 120; a relay answer at 60: since 61; a
    probe answered at the link at 60: since 61; `internet` false at 60: since 61; a late tick at 60: since 61; a lead
    beat at 60, `leadHeard` from `leadNear`: since 65; not `counting`: null throughout.
  - `hears a lead for five seconds`: `leadNear` of a lead beat at 60 s: true at 64.999, false at 65; of a follow beat:
    false.
  - `chooses the side's leader`: own (7, A) with sync B, order A, B, C, D and members A, B, C, D, E:
    - A among the candidates: A, with N (7, A) and those members;
    - B and C, not A: B;
    - C and D, sync B: C;
    - D alone: D;
    - sync null and C, D: C;
    - C with a member carrying (8, B) with order B, D, C and members B, C, D, F: D, and N is (8, B) with those members;
    - A among them with `able` false, B able: B;
    - no candidate able: null;
    - no normal term anywhere, candidates `b…` and `a…`: `a…`.
  - `knows when a side is behind`: self the leader: false; the sync with `syncFresh`: false; the sync without: true;
    another: true; no normal: true. `syncFresh` of a sync beat at 0: since 5: true; 6.9: true; 7: false; a null beat or
    since: false.
  - `takes a split term above all it saw`: seen (7, A), (9, C, split), null: (10, self, split).
  - `meets by the saved order`, each case both ways round:
    - A with normal (7, A) and B with normal (7, A): A;
    - normals (7, A) and (8, B), B the leader of (8, B): B;
    - normals equal, neither the leader, both orders C, D: C;
    - orders C, D and D, C: the lower network id.
  - `meets through the relay`, `nextMeetStep` from a split leader A (client `a`), the polls usable unless said:
    - the route held by `b`: yield; the same answer 1 s old with health down: yield; 3 s old: none;
    - empty made by `a`, window 12 s, relay back and reached 25 s: register; window 11 s: none; reached 10 s (the relay
      came back to A 10 s ago, the same relay process): none;
    - empty made by `b`, window 12 s: none; 27 s with relay back and reached 25 s: register;
    - held by `a` at `registering + 1`: none; held by `a` at `registering + 2` with `tunnel`: stop.
  - `steps down only on two beats`: no usable poll, a lead from D not apart with (9, D) above A's normal (7, A): `first`
    = `last`: none; `last - first` 2 s: yield; with D's term (6, D): none.
  - `meets an apart leader with no relay`: B apart, `relay` and `holds` false, A's normal (7, A) and B's (7, A): none
    for A, yield for B (B's sample with A as the lead); B's poll usable (the route empty, the window not yet open) and
    its beat saying `relay` true: none for both.
  - `stays when it holds the name`: A holds the name and has no usable poll; B apart, `relay` and `holds` false, and
    `meetWinner` naming B: none for A. B's usable poll then shows the route held by `a`: yield for B.
  - `a relay that answers health only is no relay`: A's `poll` null (the route failed, health up): A's peer rows apply.
  - `never yields both ways`: for every pair of the cases above, and for each pair taken one second apart (A's sample at
    t, B's at t + 1 s, each with what it knew then), `nextMeetStep` of both sides is not yield for both.
  - `sections 4's split rows, second by second` (A leads (7, A), B its sync copy, C a third copy, the relay down at 0):
    - "Relay down, two homes": A's lease ends at 10 s, so its countdown starts at 10 and the entry takes (8, A, split)
      at 130; B heard A's last beat at 0, so its count starts at 5 and its watcher takes `split` at 125, B not behind;
    - "Relay down, 3 data machines, 2 in one home": A keeps its lease by B's proof, so neither counts; C takes `split`
      at 125, behind;
    - "Relay down, 3 homes": A at 130, B at 125 not behind, C at 125 behind;
    - "The home of the leader and its sync copy loses the internet": A and B `internet` false, C's relay answers: no
      countdown anywhere, C asks the CEO (plan 10's row);
    - "A split side reaches the relay again" at R: A registers at R + 25; B, whose window is 27 s since A's client made
      the route, yields at R + 26, when its poll sees the route held by `a`.
  - `never turns normal while a member's merge waits`: `mayTurnNormal` with kind `split`, B following and `led` true:
    false; `led` false: true; B not live: true; kind `takeover`: false.
- `takeover-step.test.ts`:
  - `goes on alone`: `nextWatchStep` with `alone` true and `held` true: take `split`; not `ready`: quiet.
    `nextEntryStep` with `alone` (8, A, split) and B silent: take with it; with B's answer saying `lead`: follow.
  - `follows only a leader that is there`: `latest` (9, C, split) from B's follow beat, no `leadBeat`, the route last
    answered 10 s ago made by `c`: wait, and with `alone` (10, A, split): take; `leadBeat` (9, C): follow; the route
    answered 1 s ago made by `c`: follow.
  - plan 10's entry tests whose route answer is older than `GAP_MS` get a fresh one, and pass as before.
- `switch-step.test.ts`: `promotes a split without the relay`: a `Taking` of kind `split` at `go`: promote; past its
  deadline: promote; with `termWritten`: promote; `promoted`: lead; never register, probe or abort.
- `lease.test.ts`: `takes a split term from a normal one`: `held` null, `split` false, `entry` with the term (8, A,
  split): take of kind `split`; `entry` with a null term: kind `normal`, as plan 10's table.
- `taking.test.ts`: `reads a split taking`: a `taking.json` of kind `split` parses; of kind `other`: refused.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Decide splits as pure functions: the two minutes alone, the side's leader and meetings".

### Task 5: A side goes on alone

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 4 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/alone.test.ts test/keeper.test.ts test/watch.test.ts
test/follow-keeper.test.ts test/promote.test.ts test/taking.test.ts` passes (the existing files of those modules where a
name differs), then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/alone.ts`
- Modify: `apps/server/src/modules/keeper/keeper.ts` (the leading keeper's countdown, its split take, leading apart),
  `apps/server/src/modules/keeper/watch.ts` (the `Watcher`'s countdown and its `take` of kind `split`), plan 9c's
  `taking.ts` (the split fields), plan 9c's `promote.ts` (`recordHandover`, the `Promoter` for kind `split`),
  `apps/server/src/modules/keeper/follow.ts` (the countdown's inputs)
- Test: `apps/server/test/alone.test.ts` (new), and the existing tests of the modified modules

**Interfaces:**
- Consumes: Task 1's `lost`; Task 2's `InternetCheck`, `NormalKeeper`, `LastNormal`; Task 3's beat fields; Task 4's
  `nextAlone`, `aloneLeftMs`, `leadNear`, `sideLeader`, `SideMember`, `SideNormal`, `isBehind`, `syncFresh`,
  `splitTerm`, `NEAR_MS`, `WatchSample.alone`, `EntrySample.alone` and `leadBeat`, the split row of `nextTakeStep`, the
  kind of `nextLeaseStep`'s take; plan 10's `Beats`, `Heard`, the leading keeper's entry and polls, the `Watcher`, its
  `syncBeat` and `linkAnswered`, `take`, `followed()`, `LATE_MS`; plan 9c's `Promoter`, `writeTerm`, `recordHandover`,
  `SyncController.hold`.
- Produces:
  ```ts
  // modules/keeper/alone.ts
  export type AloneView = { since: number | null; left: number | null; leader: string | null;
    normal: SideNormal | null; behind: boolean; lost: string | null };
  //   since, left: nextAlone's and aloneLeftMs' (ms); leader, normal: sideLeader's, set once left is 0; behind:
  //   isBehind for itself on normal (else on its own last normal term); lost: ruling 7's machine, a network id
  export class Alone {
    constructor(opts: { self: string; beats: Beats; normals: NormalKeeper; able: () => boolean;
      log: (line: string) => void });
    tick(s: { now: number; late: boolean; counting: boolean; internet: boolean; relayAnswered: boolean;
      linkAnswered: boolean; syncBeat: number | null }): AloneView;
    view(): AloneView;   // the last tick's; read by Task 8
  }
  // taking.ts: Taking gains, for kind 'split': behind?: boolean, lost?: string | null, members?: string[]
  // promote.ts: recordHandover's h kind gains 'split'; h gains behind?: boolean (false when left out) and
  //   lost?: string | null (null when left out)
  ```
- `Alone.tick`: `leadHeard` is `leadNear` of every `Heard` of `beats.all()` (`at`, and `lead` when its stance is
  `lead`); `since` by `nextAlone`. Once `left` is 0: `sideLeader` with `self` (its own network id, `able()`, and the
  normal, order and members of `normals.last()`), `others` every `beats.all()` entry within `NEAR_MS` whose beat says
  `internet` and is `ready` or names itself the leader of its `normal` (each with its `able`, `normal`, `order`,
  `members`), and `own` `normals.last()`. When the normal term it gives is above `normals.last()`'s, `normals.note` with
  it (its order numbered from 1 in turn, `heard` the time of the beat that carried it), so it goes on from that term.
  `lost`: that term's leader when not itself, else its sync when set, else the first other machine of its order, then of
  its members. `behind`: `isBehind(self, <that term>, syncFresh(s.syncBeat, since))`. Each change of the countdown's
  state and of the side's leader is one log line: "hornhoof.org and <host> do not answer; going on alone in 2 minutes
  unless one does.", "Going on alone: hornhoof.org and <host> did not answer for 2 minutes." and "Waiting for <host>,
  which leads this side." (`<host>` the lost machine's hostname, from its beat, else its network id).
- The leading keeper runs one `Alone`: each tick `counting` while it holds no lease and does not lead apart, `late` from
  plan 3's `LATE_MS`, `internet` its check's, `relayAnswered` when this tick's `route` or `health` answered (Task 3's
  polls), `linkAnswered` false, `syncBeat` null (it leads; a leader is never behind).
- Its entry: `leadBeat` the highest term of a `beats.all()` entry within `NEAR_MS` saying `lead`, from another machine;
  `alone`: the term of the newest handover naming it `to` of kind `split` with `normal_at` null when that term is above
  its state's (it stopped between that record and the take); else, when `left` is 0 and `leader` is itself,
  `splitTerm(<itself>, [<its state's term>, <latest>, <normal's term>, <every beat's term>])`; else null.
- On the entry's take of `alone`, in this order: unless a handover of that term exists, `recordHandover({ id:
  randomUUID(), from: <normal's leader>, term: <alone>, applied: <pg_current_wal_lsn()>, to: <itself>, at: now, slots:
  {}, kind: 'split', heardAt: <normal's heard>, reach: now, members: <normal's members but itself>, behind, lost })`;
  `ALTER SYSTEM RESET synchronous_standby_names` and `SELECT pg_reload_conf()`; `sync.hold(true)`; then plan 10's take
  of exactly that term, a split lease by Task 4's `nextLeaseStep`. Unlike plan 10's entry take, the link frpc stays
  stopped after it.
- Leading apart (ruling 7: the newest handover naming it `to` is of kind `split` with `normal_at` null, and its state's
  term is split): the entry does not run. Holding no lease, `nextLeaseStep`'s `entry` is `{ sent: now, term: <the next
  term, split> }` at once (plan 10's "the next term": M + 1 of its state's and `latest`), with no registration and no
  `needed`; renewals take no proof (plan 10's split lease). The link frpc stays stopped (Task 6's `nextMeetStep` starts
  it). A promoted copy whose `Promoter` has said `lead` is such a keeper, so it takes its first lease this way.
- The `Watcher` runs one `Alone`: `counting` while `ready()` and not `attempting()`, `late` as plan 10's tick,
  `internet` its keeper's check's, `relayAnswered` when this tick's `route` or `health` answered, `linkAnswered` when
  its probe was answered this tick (plan 10's), `syncBeat` the monotonic `at` of plan 10's `syncBeat` (held in memory,
  so a restart starts with none). `WatchSample.alone` is `left` 0 and `leader` itself. Its take of kind `split`: plan
  10's `take` with `kind` `split`, `from` the normal term's leader, `term` the highest term it knows (`followed()`,
  which Task 7 makes `followed.json`'s `max`; every beat's; the normal term's), so the `Promoter`'s `writeTerm` above it
  is `splitTerm`'s, `generation` null, and `behind`, `lost` and `members` (the normal term's members but itself) from
  the view, so a restart after `go` has them.
- The `Promoter`, for kind `split`: no registration, no probe, no `makeSlots`, no deadline (Task 4's row);
  `sync.hold(true)` before `leads()`; `writeTerm({ above: taking.term.number, machine: <itself>, split: true })`;
  `recordHandover` as plan 10's takeover with `kind` `split`, `members` the `Taking`'s, `behind` and `lost` the
  `Taking`'s, `reason` null. Its log line at `go`: "Going on alone from <reach>: hornhoof.org and <host> did not answer
  for 2 minutes."
- A follow keeper whose countdown ended and whose side's leader is another machine takes nothing and keeps counting;
  once that machine leads, it follows it as after plan 10's takeover (plan 9's remake when it is not the machine its
  copy came from, nothing when it is).

- [ ] **Step 1: Write failing tests.**
  - `alone.test.ts`, an `Alone` with fake `Beats`, a `NormalKeeper` on a temporary folder holding (7, A) with sync B,
    order A, B, C and members A, B, C, D, and injected samples each second:
    - `goes on from the side's best machine`: self C, B's beat within 5 s saying `internet`, `ready`, `able`: at 120 s
      `left` 0, `leader` B, the log line "Waiting for B…"; B's beats then say `able` false: `leader` C, `lost` A,
      `behind` true.
    - `takes a higher normal term from its side`: self C, D's beat carrying (8, D) with order D, C and members D, C, E:
      at 120 s `leader` D and `last-normal.json` names (8, D) with that order and members.
    - `knows it is current`: self B, `syncBeat` at 0 and the count starting at 5: `behind` false; started at 70 (a relay
      answer at 69): true.
    - `waits while a lead beat comes`: a beat from C saying `lead` every 4 s: `since` null throughout.
  - `keeper.test.ts`, the leading keeper A of (7, A) with B and C finished, a fake relay that stops answering at 0, no
    beats from 0, a fake check saying internet:
    - `goes on alone after two minutes`: lease fenced at 10 s; at 130 s, in this order, one handover of kind `split`
      from A to A with members B and C, `behind` false and `lost` B, `synchronous_standby_names` reset and reloaded,
      `hold(true)`, a take of kind `split` with (8, A, split); the link frpc still stopped and the app's mode `lead`.
    - `takes its split term after a restart`: the handover of (8, A, split) recorded and the keeper started again before
      the take: the take of (8, A, split) on its first ticks, no countdown, no second handover.
    - `never goes on without internet`: the check false: no take by 600 s.
    - `starts over when the relay answers once`: one health answer at 60 s: no take at 130, the take at 181.
    - `starts over after sleep`: a late tick at 60 s: the take at 181.
    - `does not follow a machine that is gone`: a beat from B at 0 saying `follow` (9, C, split), and no beat from C:
      the take at 130 is of (10, A, split).
    - `leads apart`: under (8, A, split) and its handover, the lease fenced by a late tick: a split lease of (9, A,
      split) taken on the next tick with no probe answered and the frpc still stopped.
  - `watch.test.ts`, the `Watcher` of copy B with A silent and the relay down from 0:
    - `goes on alone`: A's last beat at 0 said `sync` B: `take` of kind `split` at 125, `heard` that beat's time, the
      `Taking`'s term (7, A), `behind` false, `lost` A, `members` A, C.
    - `goes on behind after a restart`: the same with the `Watcher` started at 3 s: the take at 123 with `behind` true.
    - `starts over when the leader answers at the link`: a probe answered by A at 60 s: the take at 181, `behind` true.
  - `follow-keeper.test.ts`:
    - `waits for the side's leader`: copy C with B near (beats within 5 s, `ready`, internet, able, the last normal
      naming B sync): no take at 125 and the log line naming B; B's hello then says `lead`: C's leader is B and the
      remake starts.
    - `goes on when the side's first choice has no internet`: B's beats say `internet` false: C takes `split` at 125.
    - `passes over a machine that cannot lead`: B's beats say `able` false: C takes `split` at 125.
  - `promote.test.ts`:
    - `promotes a split`: a `Taking` of kind `split` at `go` with term (7, A): no registration, no probe, no slots,
      `hold(true)` before `leads()`, the state's term (8, B, split), a handover of kind `split` with the `Taking`'s
      `behind`, `lost` and `members`.
    - `leads after its promotion`: the `Promoter` and then the keeper on fakes, stopped and started again after the
      term's write, after the handover's record and after `promoted`: each run ends with `leads()`, then a split lease
      of (9, B, split) taken with no registration and the app's mode `lead`; one handover in all.
  - `taking.test.ts`, `keeps what a split needs`: a `Taking` of kind `split` with `behind`, `lost` and `members` reads
    back the same.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Go on alone after two minutes without hornhoof.org or a leader, one machine per side".

### Task 6: Sides meet, one leads, and its term turns normal

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/keeper.test.ts test/proofs.test.ts
test/parked.test.ts test/ranking.test.ts test/merger.test.ts test/app-mode.test.ts` passes (the existing files of those
modules where a name differs), then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing.

**Files:**
- Modify: `apps/server/src/modules/keeper/keeper.ts` (`nextMeetStep` while leading apart, stepping down, the members it
  learns of, turning a split term normal), `apps/server/src/modules/keeper/proofs.ts` (`LeaseProofs`' `apart`),
  `apps/server/src/modules/keeper/state.ts` (`KeeperState.split`), plan 9b's `apps/server/src/modules/copies/order.ts`
  (`Ranking` under a split term, `splitOrder`), `apps/server/src/modules/nodes/parked.ts` (`mergePending`,
  `cancelUnknown`), `apps/server/src/modules/nodes/messages.ts` (the hello's unknown jobs), the minute round
  (`apps/server/src/modules/agents/timers.ts`, `minuteRound`: `cancelUnknown`)
- Test: the existing tests of the modified modules

**Interfaces:**
- Consumes: Task 4's `nextMeetStep`, `MeetSample`, `HeardLead`, `meetWinner`, `mayTurnNormal`, `NEAR_MS`; Task 3's beat
  fields; Task 5's leading apart and the handover of kind `split`; Task 2's `NormalKeeper`; plan 10's polls,
  `nextWindow`, `registering`, the link frpc's start and stop, the follow path, `LeaseProofs`, the turning normal of its
  Task 6 (`turnedNormal`, `normal_at`, `sync.hold(false)`), `mergePending`, `park`, `parkedJobs`; plan 9b's `Ranking`,
  `rank`; plan 8's merger and its unique-key conflicts.
- Produces:
  ```ts
  // modules/keeper/state.ts: KeeperState gains split?: boolean (the held lease's term is split; false when left out)
  // modules/keeper/proofs.ts: LeaseProofs' opts gain apart?: () => boolean (false when left out)
  // modules/copies/order.ts
  export function splitOrder(tx: Tx, self: string): Promise<void>;
  //   this machine's row server_order 1, the other numbered live rows 2, 3, … in their order; nothing else changes
  // modules/nodes/parked.ts
  export const UNKNOWN_KEEP_MS = 300_000;
  export function cancelUnknown(ctx: Ctx, now?: number): Promise<number>;
  //   once mergePending has answered false for UNKNOWN_KEEP_MS in a row (the app's start counts as pending): each job
  //   parked as listed with no jobs row and no applied_at, whose node is connected, gets job.cancel and applied_at now;
  //   answers how many
  ```
- The leading keeper, leading apart (Task 5), each tick after its polls: `nextMeetStep` with `self` (its network id and
  the term and order of `NormalKeeper.last()`), its `client`, this tick's `Poll`, its `Window` (plan 10's `nextWindow`,
  `heardLeader` false), the last known route with its poll's send time as `sent`, `reached` (the monotonic time since
  which every poll was usable, kept in memory, null after one that was not), `registering`, `tunnel`, and `leads`: per
  machine, kept in memory from each new `Heard` of `beats.all()`: a beat saying `lead` within `NEAR_MS` of the last one
  from it extends its run (`last`), else starts one (`first` = `last`); a beat not saying `lead` ends it. `register`:
  `registering` that generation and the link frpc started; `stop`: the frpc stopped, `registering` null; `yield`: one
  log line "Stepping down: <why>; what this side did is merged into it.", then plan 10's follow path (the lease fenced
  with that `why`, the link frpc stopped, `PEERS_FILE` from `seedView`, `REPLICA_FILE`, exit).
- `LeaseProofs.ended()` (plan 10): "a beat says `lead` with a term above `term()`" counts only beats whose stance has
  `apart` false; while `apart()` is true, `ended()` is null (plan 3's own fences still hold), since `nextMeetStep`
  decides. The keeper passes `apart` as Task 3's stance does. So a normal leader, or the CEO's term holding the name,
  never steps down for an apart side, and a higher takeover or CEO term still ends a normal lease.
- Members it learns of: while leading apart or turning normal, a beat from a machine of the handover's `members` that
  follows its term and carries a `normal` term above its own last normal term: `NormalKeeper.note` with that term
  (ruling 3), and that beat's `members` but itself added to the handover's `members` (one update; one log line "<host>
  knew a newer normal term; waiting for its machines too.").
- Turning normal (plan 10's Task 6 rule, widened): the newest handover of kind `ceo` or `split` naming this machine `to`
  with `normal_at` null; `mayTurnNormal` with that `kind`, `following` and `live` as plan 10's, and `led` from each
  member's newest beat within `NEAR_MS`. The rest is plan 10's: `sync.hold(false)`, the flag, `take('normal', ...)` with
  M + 1, `turnedNormal`, one log line ("Every machine follows this term and its changes are merged; it is a normal term
  now." for `split`, plan 10's for `ceo`). A leading keeper whose state's term is not split while such a `split`
  handover has `normal_at` null calls `turnedNormal` at its start, as plan 10's does for `ceo`.
- `KeeperState.split` is written with the mode: true while the held lease's term is split (the CEO's term too). Plan
  9b's `Ranking`: while `keeper.json` says `split`, a run does nothing but, once per split term, `splitOrder` with its
  own machine; when `split` turns from true to false while it leads, `now({ rescore: true })`. So the CEO's term (plan
  10) is ranked when it turns normal, not at its first lead.
- `mergePending` (plan 10's) is also true while this machine's `keeper.json` says `split`, and while any live data row
  other than this machine's has `copy_state` `saving`, or `copy_old_led` set with no `machine:<its id>:led-<that>` merge
  `merged` or `done`; its handover rule takes kind `split` beside `takeover` and `ceo` and skips a handover whose `from`
  is this machine.
- The hello (change to plan 10's ruling 9): a job a node lists that has no `jobs` row is parked as `listed` and not
  cancelled, whether a merge is pending or not; `cancelUnknown`, in the minute round, cancels it once no merge has been
  pending for 5 minutes. The rest of plan 10's hello is as it was.

- [ ] **Step 1: Write failing tests.**
  - `keeper.test.ts`, the split leader A of (8, A, split), leading apart under its handover of kind `split` with members
    B and C, a fake relay:
    - `steps down when another holds the name`: the relay answers with the route held by B's client: within 2 s the
      lease fenced with `another machine holds the name`, the frpc stopped, `PEERS_FILE` and `REPLICA_FILE` written,
      exit called.
    - `takes the name back after the window`: the relay back at R with the route empty, made by A's client: the frpc
      starts at R + 25 for that generation; the route then held by A at the next: still split, no take.
    - `meets over the peer link`: no relay, beats from B each second saying `lead` apart with `relay` and `holds` false
      and B's normal (7, A): A stays; A's normal (7, Z) and B's (8, B): A steps down on the beat 2 s after the first.
    - `stays when it holds the name`: A's route held by A at `registering + 1`, then the relay gone; B's beats as above
      and `meetWinner` naming B: A stays.
    - `waits for a member it learns of`: B and C follow (8, A, split) with `led` false, and B's beat carries normal (9,
      D) with members D, B, C, E: the handover's members B, C, D, E and `last-normal.json` (9, D); D follows and E's row
      is live: no normal take; E's row not live: the normal take.
    - `turns a split term normal only after the merge`: B and C follow (8, A, split) and B's beat says `led` true: no
      take; `led` false: `hold(false)`, then the normal take of (9, A) once the flag is set, then `normal_at`.
  - `proofs.test.ts`:
    - `ignores an apart leader`: a normal lease of (7, A) and a beat saying `lead` (9, C, split) apart: `ended()` null;
      the same not apart: ended.
    - `leaves meetings to the keeper`: `apart()` true and a beat (9, C) not apart: null; a probe answered by another
      machine: null.
    - `still ends for a newer leader`: a normal lease of (7, A) and a beat saying `lead` (8, B) with lease `normal`,
      then one of a CEO's split term not apart: ended both times.
  - `parked.test.ts`:
    - `parks a stepped-down side's jobs`: `keeper.json` `split` true: pending; false with B's row `saving`: pending; B's
      row with `copy_old_led` 8 and its merge `merged`: not pending.
    - `skips its own split`: a `split` handover from this machine to itself with `split` false: not pending.
    - `parks a job it does not know`: no merge pending, a hello listing a job with no row: a `listed` row and no
      `job.cancel`; `cancelUnknown` 4 minutes later: 0; 6 minutes later: `job.cancel` to that node and 1; again: 0. A
      merge pending at 3 minutes: nothing cancelled until 5 minutes after it ends.
  - `ranking.test.ts`, `ranks only under a normal term`: the app's first lead with `split` true: no score, its own row 1
    and B and C 2 and 3 in their order; another run: nothing; `split` then false: one score, the leader 1.
  - `merger.test.ts` (plan 8's merges on PGlite), `gives a place pinned on two sides to the CEO`: the leader with B
    pinned at 2 and a source with C pinned at 2: the merge commits, one conflict naming `machines_server_pin` with topic
    `machines`.
  - `app-mode.test.ts`, `says when the term is split`: `keeper.json` with `split` true under a split lease reads so.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let split sides meet, one lead, the others step down and merge, and its term turn normal".

### Task 7: Workers and copies stay with their leader

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 6 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/peer-link.test.ts test/worker-keeper.test.ts
test/watch.test.ts test/takeover-step.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/src/net/peer-link.ts` (`pickLeader`, `leader()` keeps its choice),
  `apps/server/src/modules/keeper/watch.ts` (`followed.json`'s `max`, `heard`, `promise`, the split take's term),
  `apps/server/src/modules/keeper/takeover-step.ts` (`promiseAnswer`'s `max`), `apps/server/src/modules/keeper/alone.ts`
  or `keeper.ts` where Task 5 numbers a split term
- Test: `apps/server/test/peer-link.test.ts`, `apps/server/test/worker-keeper.test.ts`,
  `apps/server/test/watch.test.ts`, `apps/server/test/takeover-step.test.ts`

**Interfaces:**
- Consumes: plan 10's `Hello.term`, `leader()`'s highest term, `FOLLOWED_FILE`, `readFollowed`, `writeFollowed`, the
  `Watcher`'s `heard` and `promise`, `promiseAnswer`; Task 3's `Hello.apart`; Task 5's split take.
- Produces:
  ```ts
  // net/peer-link.ts
  export type LeadHello = { machine: string; term: Term | null; apart: boolean };
  export function pickLeader(kept: string | null, leads: readonly LeadHello[]): string | null;
  //   kept, while it is among leads, unless another has apart false and a term above kept's (a null term below all);
  //   else the highest term of leads (a null term below all, ties by machine); null with no leads
  // modules/keeper/watch.ts
  //   followed.json becomes { term, max }; readFollowed(dir) still answers the term; writeFollowed(dir, term) keeps
  //   max the higher of term and the max kept
  export function readFollowedMax(dir: string): Term | null;   // max; a file of plan 10's shape reads its term
  //   Watcher gains maxFollowed(): Term | null
  // takeover-step.ts: promiseAnswer's o gains max?: Term | null (followed when left out)
  ```
- `leader()` keeps the machine it answered last and answers `pickLeader(<that>, <the targets whose hello says lead>)`,
  keeping the answer. Nothing else of plan 5b's or plan 10's `PeerLink` changes; the follow keeper and the worker keeper
  both get this.
- `heard` (plan 10's): a beat from the network id `leader()` names whose stance is `lead` writes `followed.json` with
  its term when none is kept, when the kept term is of another machine (even a lower term: a meeting's winner may hold
  one), or when it is above the kept term; else nothing. So the stance says "follow" the exact term of the leader it
  follows now, which plan 10's turning normal needs from every member.
- `promiseAnswer`: as plan 10's, and the asked term must also be above `max`. The `Watcher` passes `maxFollowed()`. A
  grant writes the asked term, which raises `max`.
- The split term's numbers (Task 5's `splitTerm` and the `Watcher`'s split take) take `maxFollowed()` in place of
  `followed()`, as ruling 7 says.

- [ ] **Step 1: Write failing tests.**
  - `peer-link.test.ts`, `stays with its leader`, a table of `pickLeader`:
    - kept S1 (8, a, apart) with S2 (9, b, apart): S1;
    - S1 gone: S2, and S2 kept when S1 comes back;
    - kept S1 and a lead (10, c) not apart: c;
    - kept S1 and (7, c) not apart: S1;
    - kept null: the highest, as plan 10's `takes the leader with the highest term`.
  - `worker-keeper.test.ts`, `never flips between split leaders`: two data servers whose hellos say `lead` apart with
    terms (8, a) and (9, b), the worker's first session to the first: its requests go to `a` for 30 s; `a`'s hello then
    says not leading: to `b`.
  - `watch.test.ts`:
    - `follows the winner of a meeting`: `followed.json` (12, C, split), `leader()` W, `heard(W, lead (8, W, split))`:
      `followed()` and the stance (8, W, split), `maxFollowed()` (12, C, split); `heard(W, lead (7, W, split))`:
      unchanged; `heard(C, lead (13, C, split))`: unchanged.
    - `promises only above the highest it followed`: then `promise(W, { term: (10, W, split) })`: no grant; `(13, W,
      split)`: a grant, `followed()` and `maxFollowed()` (13, W, split).
    - `reads plan 10's file`: a `followed.json` of `{ term }` only: `maxFollowed()` that term.
    - `numbers its split term above the highest it followed`: `followed()` (8, W, split), `maxFollowed()` (12, C,
      split), A silent and the relay down: its split take's `Taking.term` (12, C, split).
  - `takeover-step.test.ts`, `promises above the max`: `promiseAnswer` with `followed` (8, W, split), `max` (12, C,
    split) and the asked (10, W, split): no grant; (13, W, split): the grant; `max` left out: plan 10's answers.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep each machine with the leader it had while the company is split, following its exact
  term".

### Task 8: The page while apart, and the disk warning

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 7 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/switch-word.test.ts test/keeper.test.ts
test/follow-keeper.test.ts test/worker-keeper.test.ts test/machines-routes.test.ts` passes, then the whole server suite;
from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/SwitchBanner.test.tsx test/MachineCard.test.tsx
test/i18n.test.tsx` passes; the `tsc` commands print nothing.

**Files:**
- Modify: `apps/server/src/modules/keeper/switch-word.ts` (`SwitchWord`, `switchWord`), `keeper.ts`, `follow.ts` and the
  worker keeper (what they pass to it), `apps/server/src/modules/network/machines.ts` (or where `GET /api/machines` is:
  `diskTotal`), `apps/web/src/ui/SwitchBanner.tsx`, the machine card (`apps/web/src/screens/Machines.tsx`),
  `apps/web/src/types.ts`, `apps/web/src/i18n/en.ts`, `ru.ts`
- Test: the existing tests of the modified modules

**Interfaces:**
- Consumes: Task 5's `Alone.view()`; Task 3's `SplitView`, the stance's `split` and `Hello.split`, `led`; Task 2's
  `InternetCheck`; plan 10's `SwitchWord`, `switchWord`, `SwitchBanner`, `GET /api/network/switched`,
  `PeerLink.leader()`, the keeper's view (network id to machine id).
- Produces:
  ```ts
  // switch-word.ts: SwitchWord gains (machine ids, never hostnames, as plan 10's; times ISO)
  //   alone: { left: number; lost: string; behind: string | null } | null;   // seconds left; behind: its reach when
  //                                                                          //   it would go on behind
  //   apart: { since: string; lost: string; behind: string | null } | null;  // behind: the reach when behind
  //   noInternet: { lost: string } | null;
  //   merging: { with: string } | null;
  // switchWord's input gains alone, apart, noInternet and merging, already shaped so; while alone or noInternet is
  //   set, plan 10's moving of a follow keeper or worker whose leader is lost is false (handing and taking still move)
  // GET /api/machines: each machine gains diskTotal: number | null
  ```
- The keepers fill them, each network id turned into its machine id by the keeper's view:
  - `alone`: while its `Alone` view has `since` set and it neither leads nor took over: `left` in whole seconds, `lost`
    the view's, `behind` its copy's reach (plan 9's `report().at`) when the view's `behind`, else null.
  - `apart`: on a keeper leading apart, its stance's `split`; on a follow keeper, its leader's newest beat's `split`
    while that beat says `lead` with `apart`; on a worker keeper, the `split` of the hello of the leader
    `PeerLink.leader()` names.
  - `noInternet`: while its check says no internet, its app is not in `lead` and `PeerLink.leader()` is null; `lost` as
    `alone`'s, else its last normal term's leader.
  - `merging`: on a follow keeper whose beat says `led`: `with` its leader's machine.
- `SwitchBanner` shows, the first that applies: plan 10's moving line of a planned switch or a takeover under way;
  `split.noInternet`; `split.alone`, with `split.behind` after it when `alone.behind` is set; `split.merging`;
  `split.apart`, with `split.behind` when `apart.behind` is set; plan 10's lost-leader line; then plan 10's `switched`
  lines, none for a handover of kind `split` (the `apart` line says it). `{left}` as `m:ss`, times as plan 10's banners.
- The card of a machine of the role `data` with `diskFree` and `diskTotal` both known and `1 - diskFree / diskTotal` at
  least 0.85: `machines.diskWarn` with that share as a whole percent.
- The strings, EN / RU:
  - `split.alone`: "Lost {lost} and hornhoof.org. Going on by itself in {left}; changes from both sides are merged
    later." / «Нет связи с машиной {lost} и hornhoof.org. Hornhoof продолжит сам через {left}; изменения обеих сторон
    потом сольются.»
  - `split.apart`: "Working apart from {lost} since {since}." / «Работаем отдельно от машины {lost} с {since}.»
  - `split.behind`: "This side has {lost}'s changes up to {reach} only." / «На этой стороне есть изменения машины {lost}
    только до {reach}.»
  - `split.noInternet`: "This machine has no internet and cannot reach {lost}, so it stopped taking changes. You can
    read everything." / «У этой машины нет интернета и связи с машиной {lost}, поэтому она перестала принимать
    изменения. Читать можно все.»
  - `split.merging`: "Back in touch with {with}; merging." / «Снова есть связь с машиной {with}; изменения сливаются.»
  - `machines.diskWarn`: "Disk {pct}% full." / «Диск заполнен на {pct}%.»

- [ ] **Step 1: Write failing tests.**
  - `switch-word.test.ts`:
    - `passes the split's words through`: each of `alone`, `apart`, `noInternet` and `merging` comes out as it went in,
      and null when not given.
    - `does not say a lost leader while it counts`: a follow keeper with `leader` null and `lostSince` 30 s ago, and
      `alone` set: `moving` false; with `noInternet` set: false; `taking` and not `leads` with `alone` set: `moving`
      true.
  - `keeper.test.ts`, `says it counts and then leads apart`: the leading keeper of Task 5's script: `GET
    /api/network/switch` at 70 s has `alone` with `left` 60, `lost` B's machine id and `behind` null; at 140 s `apart`
    with `since` the handover's `at`, `lost` B's machine id and `behind` null.
  - `follow-keeper.test.ts`:
    - `says it counts behind`: copy C of Task 5's `waits for the side's leader`, B's beats with `able` false, at 60 s:
      `alone` with `lost` A's machine id and `behind` C's reach.
    - `says its leader works apart`: its leader's beats say `lead` with `apart` and a `split`: `apart` from it.
    - `says it has no internet`: the check false and no leader: `noInternet`.
    - `says it merges`: its beat's `led` true: `merging` with the leader's machine id.
  - `worker-keeper.test.ts`, `says its leader works apart`: the leader's hello with `apart` and a `split`: `apart` from
    it.
  - `machines-routes.test.ts`: `reports the disk size`: a row with `disk_total`: `diskTotal` set; without: null.
  - `SwitchBanner.test.tsx`:
    - `counts down`: `alone` with `left` 100 and `lost` Mac's id: "Lost Mac and hornhoof.org. Going on by itself in
      1:40; changes from both sides are merged later."; with `behind` 23:40: "This side has Mac's changes up to 23:40
      only." after it.
    - `says it works apart, and how far it reaches`: `apart` with `behind` 23:40: both lines; without: the first only.
    - `says why it only reads`: `noInternet`; `says it merges`: `merging`.
    - `puts a move first`: a planned switch's `moving` with `alone` set: the moving line only.
    - `says nothing more after a split`: `switched` of kind `split`: no switched line.
  - `MachineCard.test.tsx`: `warns at 85%`: a data machine with 15% free: "Disk 85% full."; 16% free: nothing; a worker
    with 5% free: nothing.
  - `i18n.test.tsx`: every `split.*` key and `machines.diskWarn` in both languages.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Count down, say when the company works apart and merges, and warn when a disk fills".

### Task 9: The lab: splits across homes, three homes, and a newer leader

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 8 committed. **Done when:** from the worktree
root `npm run test:lab` passes with Docker running, after the disk check; `npx tsc -p apps/server/tsconfig.json
--noEmit` prints nothing.

**Files:**
- Create: `apps/server/test/lab/splits.test.ts`
- Modify: `apps/server/test/lab/lab.ts` (`homes`, `heal`, `relayCut`, `internet`, `internetStub`, `playRelay`, the
  `edge`), plan 9's `relay()` (`down`, `up`), `apps/server/test/lab/steps.ts` (the internet stub in `.env`)
- Test: the scenario itself

**Interfaces:**
- Consumes: plan 5b's `Lab`, `LabMachine`, `steps.ts`; plan 9's `relay()`, `startWriter`, `checkRows`; plan 9c's
  `edge()` and its planned switch step; plan 10's `cut`, `mend`, `leaderOf`, `confirmedOf`, `lateConfirms`; Task 2's
  `HORNHOOF_INTERNET_URLS` and `HORNHOOF_INTERNET_CA`.
- Produces:
  ```ts
  // test/lab/lab.ts
  //   homes(groups: LabMachine[][]): Promise<void>   // iptables DROP, in each machine's outer container, of traffic to
  //                                                  // every machine of another group; both ways
  //   heal(): Promise<void>                          // every rule homes() added removed
  //   relayCut(m: LabMachine, on: boolean): Promise<void>
  //     // DROP of m's traffic to the relay's and the edge's ports on the host's address, or not; the stub's port open
  //   internet(m: LabMachine, on: boolean): Promise<void>   // DROP of m's traffic to the stub's port only, or not
  //   internetStub(): Promise<{ url: string; ca: string; close(): Promise<void> }>
  //     // an HTTPS server of the test process on its own port, answering 204 to anything, its certificate from a CA
  //     // made at run time
  //   playRelay(fake: FakeRelay, name: string, machines: LabMachine[]): { stop(): void }
  //     // the test playing frps for the link name, once a second (below)
  // plan 9's relay(): gains down() and up(): while down, every request and registration is refused; its state is kept
  // edge(...) as plan 10's, and it also answers 502 while the relay is down or the machine holding the route is
  //   relayCut
  ```
- `playRelay`, each second, while the relay is up: the client holding the name is dropped, after the fake's
  `evictionBound`, when its machine is stopped, `relayCut`, or its keeper container runs no link frpc (`pgrep frpc` by
  `docker exec`); when the route is empty, a machine whose keeper container runs the link frpc, that is not `relayCut`,
  is registered with the client id of its link frpc config (the lowest machine first when two do, as frps takes the
  first); a held route is never given to another. While the relay is down, nothing changes. It replaces plan 10's player
  in this scenario only.
- `steps.ts` writes `HORNHOOF_INTERNET_URLS=<the stub's url>` and `HORNHOOF_INTERNET_CA=<the stub's CA, as a file in the
  machine's keeper volume>` into each machine's `.env`; `InternetCheck` (Task 2) trusts that CA when both are set.
- `splits.test.ts`, one scenario, 100 minutes at most, the disk check first:
  1. m1 a server with the lab's relay, edge and `playRelay`; m2 number 2 named sync, m3 number 3, both `ready`; m4
     joined as a worker. A writer per side as each step says, with `leaderOf` over that side's machines.
  2. "A 2 and 3 split across homes": `homes([[m1], [m2, m3, m4]])` and `relay().down()` at t0. Within 140 s m1 leads
     under a split term with a handover of kind `split` and `behind` false, and m2 the same; m3 follows m2 (its copy
     made again from m2); m4's `GET /api/keeper` names m2 its leader. m2's `GET /api/network/switch` said `alone` before
     and says `apart` after, with no `behind`; m3's says `apart` too. A writer on each side.
  3. "Split sides meeting with no arbiter": `heal()`, the relay still down. Within 10 s m2 steps down (m1 held the last
     normal term) and follows m1; m2's `led` merge is `merged` or `done` within 15 minutes; m3 follows m1; m4's leader
     becomes m1. m1 stays split.
  4. The relay back (`relay().up()`) at R: m1 holds the name by R + 40 s and takes a normal term once m2 and m3 follow
     it with `led` false; m1's `GET /api/machines` then ranks m1 number 1.
  5. "Three homes with the relay down": `homes([[m1], [m2], [m3]])`, m4 in none of them, so it reaches all three, and
     `relay().down()`. m1, m2 and m3 each lead under a split term within 140 s, m3's handover `behind` true; from the
     first split leader m4's `GET /api/keeper` names, it names that one until the relay is back. `heal()` and
     `relay().up()` at R: m1 holds the name by R + 40 s, m2 and m3 step down by R + 40 s and are merged one at a time;
     m1 normal once both are.
  6. "A split side meeting a newer leader": `homes([[m1, m2], [m3]])` and `relayCut(m3, true)`, the relay up. m3 leads
     under a split term within 140 s, `behind` true. Then `docker stop` of m1's containers: m2 takes over by the relay
     under a normal term (plan 10). Then `heal()`: within 10 s m3 steps down (two beats of m2's newer normal term) and
     is merged into m2. `relayCut(m3, false)`, m1 started again: m1 follows m2 (plan 10).
  7. "Leader loses internet, copy elsewhere", from m1 leading again: plan 9c's planned switch to m1, then wait until m1
     leads under a normal term and m2 is its `ready` sync copy. Then `homes([[m1, m4], [m2, m3]])`, `relay().down()` and
     `internet(m1, false)`: m1's lease ends and m1 never leads again in 5 minutes; its `GET /api/network/switch` says
     `noInternet`; m2 leads under a split term within 140 s, `behind` false. Then `internet(m1, true)`, `heal()`,
     `relay().up()`: m1 follows m2, its database, which led, is merged, and m2 holds the name and turns normal once m1's
     merge is done.
  8. The writers stopped. Once every copy is `ready` (2 minutes at most), `checkRows` of every data machine for every id
     the writers kept is empty, and `lateConfirms(await confirmedOf(<the final leader>, <every kept write>))` is empty
     (plan 10's checker leaves split terms out).

- [ ] **Step 1: Write the failing test** and `homes`, `heal`, `relayCut`, `internet`, `internetStub`, `playRelay`,
  `relay()`'s `down` and `up`, the `edge`'s change, the `.env` lines; `npm run test:lab` fails at step 2.
- [ ] **Step 2: Fix** what it finds in Tasks 1 to 8, each fix with its failing test first in that task's test file.
- [ ] **Step 3: Check the disk, then run Done when,** as plan 7's Task 10 Step 3. Expected: PASS.
- [ ] **Step 4: Commit** "Test splits in the lab: two homes, three homes, a newer leader and a machine with no
  internet".

### Task 10: Run everything and review

**Repo:** the `network` worktree, branch `network`. **Starts from:** Tasks 1 to 9 committed and reviewed. **Done when:**
Steps 1 and 2 pass for the agent; Step 3 is the team lead's, never an agent's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` and `npm run
  test:lab` (after the disk check) → pass; the `tsc` commands → no output.
- [ ] **Step 2: Check the public-repo rule.** As plan 7's Task 11 Step 2.
- [ ] **Step 3: Review.** The team lead reads the branch against the spec sections this plan names, the overview's plan
  11 entry and this plan's rulings, with Review Focus first; the CLI agent that did not write a task reviews it too; one
  fix pass, each fix with its failing test first.

The rehearsal, the merge into main, Ivan's Updates and the worktree's close are done once, for the whole series, at its
end. This plan's part of that rehearsal is Task 9's scenario and, on the rehearsal's company, a router unplugged once
with the page open.

## Addendum: the relay comes back just before the two minutes

Spec 3.5 promises that a leader dying in a relay outage of "about 75 s to 2 minutes" leaves "nobody has split", and a
question to the CEO. Plan 10 pins the lower edge. The upper edge is here: B's count starts 5 s after A's last beat
(`leadNear`, Task 4) and takes a split at 125 s, and any relay answer starts it over (`nextAlone`). So an outage under
125 s ends in the question and one of 125 s or more in a split, as ruling 13 reads. Each half has its own test (Task
4's `counts two minutes alone`, plan 10's rows); nothing tests that they meet.

### Task A1: The question and the split meet

**Repo:** the `network` worktree, branch `network`. **Starts from:** this plan's Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/watch.test.ts` passes.

**Files:**
- Test: `apps/server/test/watch.test.ts`

**Interfaces:**
- Consumes: Task 5's `Watcher` and `WatchSample.alone`; plan 10's `ask` step; Task 4's `nextAlone`.

- [ ] **Step 1: Write the tests** in `watch.test.ts`, the `Watcher` of copy B as `goes on alone` has it: A's last beat
  at 0 said `sync` B, the record names B "on" at generation 7, the relay down from 0:
  - `asks when the relay comes back before the two minutes`: the relay back at 120 with the route empty at 7 and the
    record as it was: no `take` of kind `split` at any second, and `ask` at 145. The same back at 124: no `split`, and
    `ask` at 149.
  - `goes on alone when it does not`: the relay back at 125: `take` of kind `split` at 125, `behind` false.
- [ ] **Step 2: Run** Done when. It pins Tasks 4 and 5, so expect PASS. Watch it fail once: take the restart on a
  relay answer out of `nextAlone` by hand: `asks when ...` fails with a `split` at 125. Put it back.
- [ ] **Step 3: Commit** "Test where the CEO's question after a relay outage ends and a split begins".
