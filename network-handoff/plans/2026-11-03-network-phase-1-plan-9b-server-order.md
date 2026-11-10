# Network Phase 1, Plan 9b: The Server Order, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every machine that may hold the company's data gets its place in the server order from a score of what the
machines measure: how often it is online, its connection to number 1 and to the internet, its disk, memory and cores.
Number 1 stays where the server runs; the others are ranked once a day, when a machine joins or leaves, and after a
change of leader, and two close machines do not swap. The CEO pins a place, unpins it, or keeps a machine from ever
taking the server. When the ranking moves a machine into the first three, it gets its copy first, and the machine ranked
out keeps its own until the new one is up to date, at most once a day. Each card shows its number and one line on why,
and the Machines table sorts by it.

**Architecture:** One migration, `0056_server_order`: four measures on `machines` (the round trip and throughput to
number 1, the round trip and throughput to the internet) and `net.ranking`, one row that says when the order was last
scored and when a copy was last handed over. The keepers measure: a worker's or copy's `PeerLink` times its hellos to
the leader (`round-trips.ts`), every keeper times github.com (`internet.ts`), and the leading keeper counts what its
peer server sends each machine (`throughput.ts`) into `keeper.json`. On the leader's app, `modules/copies/score.ts`
scores and orders, all pure; plan 9's `order.ts` ranks with it, decides who holds data (`planRoles`) and hands a copy
over through plan 9's upload and wipe; `PUT /api/machines/:id/priority` takes the CEO's choice. The web app gets the
Priority column and the card's Priority part as the approved mockup shows them.

**Tech Stack:** TypeScript on Node 22 (`fetch`, `node:http2`, `performance.now()`); Postgres 17.11; Fastify 5;
drizzle-orm 0.45.4 on node-postgres and PGlite; React for the web app; vitest; Docker for `npm run test:lab`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.3 ("The server order": number 1, the ranking's times, the
score, ties and the 5-point margin, `server_why`, pins and their refusals, "What a new ranking changes"), section 2's
"Priority" row and the reasons a machine cannot take the server, section 4's row "The CEO pins a place, or the daily
ranking changes", and section 12's server order bullet for all that is not 9c's, plan 10's or plan 11's (ruling 1).
Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 9's entry; plan 9's ruling 1, which split it. The
team lead's points of 2026-11-03, as settled with Ivan on 2026-11-02: "1 is where the server runs now. Ranking alone
never moves it, only a takeover or the CEO's 'Move the server here'." "2, 3 and on are ranked daily by score: 7-day
online share first, then network to the internet and to 1, disk fsync, memory and cores. Ties go to the CEO, then
whole-company people, then join date." "'Manually' pins and 'Automatically' unpins." "The card shows one line on why."
"No voter or copy roles on screen, only the Priority column and a select on the card." The approved mockup:
https://claude.ai/artifact/Twnj15fdFN4Z1gT4Z2AgxT (its `serverLine`, `prioCell`, `prioBody` and the `change` handler).

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see them
fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only the
task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a test of
an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in the series' worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network` on its branch `network`, after plan 9's last task is
committed there. No new worktree: nothing of the series ships until the series merges into main, once, at its end.

**Handed over** (done on the `network` branch before this plan starts; none of it is shipped):
- Today's code: `Machines.tsx` (`machineColumns`, `initialSort={{ key: 'status', direction: 1 }}`, the card's `Part
  title={t.cards.priority}` with `t.cards.serverHere` on `row.server`), `.server-priority` in `theme.css`, `SortTable`
  and `sortRows` (`apps/web/src/ui/sort.ts`: a null value sorts last), `cards.priority` and `cards.serverHere` in
  `apps/web/src/i18n/en.ts` and `ru.ts`.
- Plan 2: `readKeeperState`, `writeKeeperState`, `KeeperState` (`keeper.json`).
- Plan 5: `findThisMachine`; `PeerServer` and its `Peer` (`machine`); `Measures` (`modules/keeper/measures.ts`) and
  `POST /api/network/report`; the leading keeper's report every `reportEveryMs` to its own app.
- Plan 5b: `PeerLink` (`apps/server/src/net/peer-link.ts`: a `GET /peer/hello` on each session every `helloMs`, 10 s;
  `leader()`), `WorkerKeeper`'s report through the link every `reportEveryMs`; `onlineShare(db, machineId, now?)`;
  `shownMachine`, and `builtinMachine(db, hostId, companyId, networkId)`, which marks `server` the machine the server's
  keeper runs on in `GET /api/machines`.
- Plan 7: the CEO's check on the people's routes: the person with `is_owner` on his own session (`me.via` unset), else
  403 `forbidden` 'Only the CEO does this, from his own session.' (`not_owner_session`).
- Plan 8: `BOOKKEEPING` (`modules/merge/rules.ts`).
- Plan 9: `machines.server_order`, `server_pin` (`machines_server_pin` unique where not `'none'`,
  `machines_server_pin_value`), `server_why`, `memory`, `cores`, `copy_state`, `copy_name`, `upload_state`;
  `modules/copies/qualify.ts` (`Unfit`, `Candidate`, `unfit`, `MEMORY_MIN`, `DISK_SPARE`, `FSYNC_MAX_MS`,
  `REPORT_FRESH_MS`); `modules/copies/order.ts` (`COPIES`, `RANK_EVERY_MS`, `Ranked`, `rankOf`, `candidates`, `rank`,
  `Ranking`, `Ctx.ranking`); `modules/copies/scope.ts` (`cutReplication`, `leaveData`, `afterLeave`); the upload and the
  wipe (its ruling 11: `upload_state` `waiting`, `received`, `kept`, then null); the merge of an upload by one id-set
  read (its ruling 15); `SyncController` and `CopySample.number` (`modules/keeper/sync.ts`); `keeper.json`'s `copies`
  (`sync`, `pace`, `behind`, `silent`); `modules/copies/view.ts` (`DataView`, `CopyLine`, `CopiesView`, `dataViews`,
  `copiesView`) and `GET /api/machines`' `data` and `copies`; `machines.copy` in both language files; the lab's
  `copies.test.ts`, `writer.ts` and `relay()`.
- Where the branch's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`; in Russian a plan is «тариф».
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`, `.superpowers/`,
  `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh config
  or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys made at run time; no unit test reaches github.com (a fake `fetch`); the lab's keepers may.
- No new npm dependency. One new migration, `0056_server_order`: `npx drizzle-kit generate --name server_order` from
  `apps/server` for what `schema.ts` describes, with the hand-written part of Task 1 appended after a `-->
  statement-breakpoint`; never an edit of an older one. Its number follows plan 9's `0055`; the series' migrations are
  numbered again at the merge into main.
- Hornhoof never moves the server because the ranking changed (spec 3.3): number 1 is only ever the leader's row, and
  nothing in this plan starts a switch. The only up-to-date copy is never dropped but on a lost scope, and a database
  goes only after its merge (spec 3.7, plan 9's Global Constraints).
- No test transfer between machines: the throughput to number 1 comes only from what flows anyway (spec 3.3). The
  internet download is one a day per keeper, at most 4 MiB, from github.com.
- Messages between keepers and apps change only by additions (spec section 9): a report without the new fields keeps
  what the row had.
- Ivan's rules: only a machine's owner opens computer access to it; no step of this plan asks Ivan to type a command.
  The ranking, a handover and a retired copy's wipe happen by themselves; the CEO only chooses on the card.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; `npm run test:lab` needs Docker. Types, from the worktree root: `npx tsc -p
  apps/server/tsconfig.json --noEmit`, and `apps/web` likewise when touched, each printing nothing. Never run prettier.
- Before a lab run on the team lead's Mac: `df -h /` and `docker system df`; clean only build cache and `hornhoof-lab/*`
  images, never a volume.

## Rulings made while planning

1. **What this plan takes.** Plan 9's ruling 1 gave it the score and its measurements, the daily ranking, pins, "Does
   not take the server" and its refusals, `server_why` from number 2 on, the copy handed over when the ranking changes,
   and section 2's whole Priority row and sortable column. Left elsewhere: "Move the server here" with its confirm, the
   planned switch and promotion making the new leader 1 (9c); the heartbeats, and the old leader ranked again on its
   return with its card's note (plan 10); the internet check of 3.6, a split side's saved order and the order recomputed
   after a split's merge (plan 11).
2. **The measurements** (spec 3.3; deviation in form, since two of the spec's sources come with later plans):
   - Online share: plan 5b's `onlineShare`.
   - Round trip to number 1: the spec's "day's median from the heartbeats (3.4)"; heartbeats are plan 10's. Until then a
     worker's or copy's `PeerLink` times the `GET /peer/hello` it sends every `helloMs` on the leader's session, by
     `performance.now()` from the request to its answer's headers; at most one sample per 20 s is kept, for 24 h, and
     the median is reported as `linkRttMs`. The leading keeper answers a hello itself, with no database in the way, as
     it will answer a heartbeat; plan 10 may feed the same median from its heartbeats.
   - Throughput from number 1: the leading keeper's peer server counts the bytes it writes to each machine's streams
     (the replication stream through `CONNECT db`, a backup bundle, an app's answer through `CONNECT app`), all its
     sessions to that machine together. Every 100 ms the keeper reads the counts into a sliding minute of slots, each
     slot with its bytes and the time since the read before; a machine's first read, or a count lower than the last (a
     new peer server), only sets its base. While that minute holds 4 MiB or more, its rate is the bytes × 8 over the
     time of the slots that carried any, in Mbit/s: the rate while bytes flowed, not the minute's average (deviation in
     form from "the best minute"). So a 4 MiB file at 100 Mbit/s, 0.34 s on the wire, reads as about 84 Mbit/s over its
     four slots, not under 1 over the minute. The best rate of each hour is kept for 24 h in `<keeper
     dir>/throughput.json`, so a restart keeps the day; the best of those goes into `keeper.json`'s `throughput`, and
     the ranking writes it to `link_mbps`. With none in 24 h, or after a leader change, the column keeps its last value;
     with none ever it is null, which scores 5 (spec). No test transfer (spec).
   - Round trip to the internet: the spec's "round trip of the internet check of 3.6"; that check is plan 11's. Until
     then every keeper sends two `HEAD https://github.com/` in a row every 10 minutes by `node:https` on an agent of one
     kept-alive socket (5 s timeout each, certificates checked) and times the second to its answer's headers: it reuses
     the first's connection unless github.com closed it, and then the sample holds a new connection and stands. Any HTTP
     answer counts, a TLS or network error gives no sample (as 3.6 counts answers). The median of the last 24 h is
     `internetRttMs`; plan 11's check may feed the same median.
   - Throughput from the internet: once a day, `GET` of `DOWNLOAD_URL`, the frp 0.71.1 linux amd64 archive on github.com
     that the image already pins, by `node:https` with `Range: bytes=0-4194303`, following at most 3 redirects, 60 s in
     all. A 200 or a 206 is read up to 4 MiB, and the request is then destroyed, which ends a good sample; the rate is
     the bytes read × 8 over the time from the answer's headers to the last byte read. Another status, an error, the 60
     s, or under 1 MiB read gives no sample. The last good rate and the time of the last try are kept in `<keeper
     dir>/internet.json`: the next try is 24 h after the last, and at the earliest 10 minutes after the keeper starts,
     so a restart neither forgets the rate nor downloads again.
   - Disk, memory and cores: plan 5's `fsync_p99_ms`, plan 9's `memory` and `cores`. The four new values are whole
     numbers on `machines`, each reported by its machine's keeper or written by the leader's ranking, so plan 8's
     `BOOKKEEPING` takes them and a merge never compares them. A measure with no value yet is left out of the report, so
     the row keeps its last.
3. **The score** (spec 3.3), the sum rounded to whole points, 0 to 100:
   - online: 40 × the share;
   - round trip to number 1: 10; throughput from number 1: 10;
   - internet: 5 for its round trip, 5 for its throughput;
   - disk: 20, full at an fsync p99 of 2 ms or less, nothing at 50 ms or more;
   - memory: 5, nothing at 4 GiB or less, full at 16 GiB or more; cores: 5, full at 8 or more, `cores / 8` below. A
     round trip scores full at 20 ms or less and nothing at 300 ms or more; a throughput full at 100 Mbit/s or more and
     nothing at 5 Mbit/s or less; every part straight between. A missing measure scores nothing, but the throughput from
     number 1, which scores 5 (half) while it has none (spec). Memory is in GiB as Docker's VM reports it (plan 9's
     ruling 3), so a VM given 4 GB scores nothing for memory and still qualifies.
4. **Who may hold data, on the last measures** (deviation, approved by the team lead on 2026-11-03). Plan 9 qualifies a
   machine only on a report of the last 2 minutes. With the order scored once a day, a laptop asleep at that minute
   would lose its number and its copy every night. So `unfit` reads the last reported `memory`, `disk_free` and
   `fsync_p99_ms` whatever their age, and `measuring` is a machine that has never reported all three. Being away counts
   through the online share, which the score weighs most. `REPORT_FRESH_MS` goes.
5. **The order** (spec 3.3):
   - Number 1 is the leader's row (`findThisMachine`), whatever its measures; no other row ever gets 1.
   - The others that may take the server are the fit rows (`unfit` null) not pinned `none`. Established ones (made 3
     days ago or more, by `created_at`) come before newcomers.
   - Established machines: the 95% class (a share of 0.95 or more) first; then by points; starting from the order they
     had. A machine passes the one above it only when it is in the 95% class and that one is not, or both are in one
     class and it leads by more than 5 points (`passes`); the pure `settle` swaps neighbours until no machine passes the
     one above it. Each swap puts a pair into the order of (class, points), so it ends, and the 95% class ends on top.
     An established machine with no number yet joins at the bottom of the established ones, by (class, points), then the
     ties, before `settle`.
   - Newcomers rank among themselves as established ones do: the 95% class, then points, from the order they had, with
     the same 5-point margin and `settle`, then the ties; they still come after every established machine. In a new
     company every machine is a newcomer, and a CEO's machine online 10% of the time must not get a copy for 3 days only
     to hand it on at day 4; the margin keeps a few hours' noise from swapping them. (The team lead's ruling of
     2026-11-03; the spec does not say how newcomers rank among themselves.)
   - Ties: the CEO's machines (`is_owner`), then whole-company people's, then the older `created_at`, then the id.
   - Then the pins (ruling 7).
6. **When it scores** (spec: "once a day, when a machine joins or leaves, and after every change of leader"). The
   `Ranking` runs every minute as in plan 9. A run scores when it is the first since the app took the lead,
   `net.ranking.rescored_at` is missing or 24 h old, a machine joined (a fit row not pinned `none` has no number) or
   left (a numbered row is not live, not fit, or pinned `none`), the leader's row is not number 1, the CEO changed a
   pin, or the caller asks: plan 9's `afterLeave` does, after a lost scope or a Disconnect, since its `leaveData` has
   already cleared the number the ranking would see go. A run that throws hands its reasons to score on to the next. Any
   other run keeps the numbered rows in their order and places the pins again; it still writes `server_why`, the roles
   and `link_mbps`. A row that is not live loses `server_order`, `server_why` and `server_pin`: plan 9's ranking read
   live rows only, so a Disconnected machine kept its number and its pin and held that place (deviation in form, fixed
   here).
7. **Pins** (spec 3.3; the mockup's `serverLine` and `change` handler). `server_pin` is null (Automatically), `none`
   (Does not take the server) or a place from 2 (By hand). Placing, `placePins`: N is 1 plus the machines ranked; each
   pin of N or less takes its place; the pins above N, in their order, take the last free places; the machines on
   Automatically fill the free places in the order of ruling 5. A pin of a machine that is not fit stays stored and does
   nothing until it is. The leader's pin is cleared ("A pin ends when its machine becomes number 1"). `PUT
   /api/machines/:id/priority`, the CEO's alone (plan 7's check), with `{ pin: null | 'none' | <integer> }`:
   - any pin on the leader's machine (`findThisMachine`'s row, or the machine `GET /api/machines` marks `server`): 409
     `leader_pin` "Move the server to another machine first.";
   - `none` on the only up-to-date copy (its copy is `sync` or `pace` in `keeper.json` and no other data row's is): 409
     `only_copy` "<host> holds the only up-to-date copy; give another machine a place first.";
   - a place on a machine that is not fit: 400 `unfit` "This machine cannot take the server."; a place outside 2 to N, N
     counted as if the change were made: 400 `invalid`. A place another machine had pinned is taken from it in the same
     transaction, as the mockup's handler does. Then the route runs the ranking with a score and the CEO's mark (ruling
     8) and answers once it ended; when that run fails, 503 `try_again` "Try again in a minute.", the pin stored and the
     next run scoring.
8. **Who holds data** (spec 3.3, "What a new ranking changes"). The pure `planRoles` decides, on T (the machines
   numbered 2 and 3), D (the other live rows of the role `data` that are not `leave`), the copies that are up to date
   (`sync` or `pace` in `keeper.json`, as plan 9's view reads them), the one named sync, `handover_at` and the CEO's
   mark:
   - Free seats (`COPIES` less the rows of D) go at once to T's machines without data, the lower number first: a copy
     lost to a scope or a Disconnect, or the first copies.
   - With no free seat and a machine of T without data, a handover starts when every machine of T that holds data is up
     to date (no copy is being made) and the last handover began 24 h ago or more, or this run is the CEO's: that
     machine gets the data role and `handover_at` is now. So at most one a day, and one copy made at a time; the CEO's
     pin does not wait the day, but waits for the copy being made.
   - A row of D outside T (ranked out, not fit, or pinned `none`) keeps its copy, and may stay sync, until every machine
     of T holds an up-to-date copy, T holds `COPIES` machines or the row is pinned `none`, and it is not the one named
     sync; then it is retired, one a run. So a copy that only stopped qualifying (a disk filling up) stays until a
     machine takes its place, and only the CEO's "Does not take the server" lowers the number of copies, never below one
     up to date (Task 6 refuses the last).
   - Before it cuts, the ranking reads `synchronous_standby_names` and a fresh `keeper.json` again, and goes on only
     while the setting does not name the row and T's copies are still up to date: plan 9's controller names a copy
     outside T only when no numbered copy keeps pace, which that check sees.
   - Retiring is `cutReplication`, then `leaveData` with `lost: false`: the role `worker`, its certificates revoked,
     `upload_state` `waiting`; no key changes and no `data_left_at`, since its owner still sees the whole company. It
     then uploads its database and wipes as plan 9's ruling 11, so the database goes only after its merge (3.7), by plan
     9's one id-set read, since it never wrote. (Deviation, approved by the team lead on 2026-11-03, with no shortcut
     for a copy that never wrote: the spec says only "its database dropped only as 3.7 allows". Plan 9's upload is the
     one way out of a data machine that ends in a wipe of its secrets and database; it moves the whole database once
     over the peer link, at most once a day. The other way, a merge through a door before the role changes, would be a
     third path to keep.)
   - Until its wipe a retired machine still holds the company's secrets and a database. So plan 9's lost scope and
     Disconnect treat a row whose `upload_state` is set as they treat a data row: its owner losing whole-company scope,
     or its Disconnect, sets its `data_left_at` and changes the link key. Its keeper reaches the leader through the
     `-app` service once its view carries no data secret, so its upload also goes through the relay, after a restart
     too. When its wipe is reported, its row forgets the copy (`copy_state`, `copy_progress`, `copy_error`, `copy_at`,
     `copy_old`) but keeps `copy_name`, and the next copy on that machine starts at the attempt above it, so no slot
     name or `machine:` merge source is used twice and no old state reads as up to date. This closes the same gaps in
     plan 9's lost scope, whose machine may hold data again once its owner sees the whole company again. (Deviation in
     form: plan 9 left them.)
   - A row whose `upload_state` is set never gets the data role, so a retired copy is wiped before it holds data again.
   - The sync copy follows by plan 9's controller: a data row without a number samples as number `Infinity`, so a
     numbered copy that keeps pace replaces it through "sync off" (spec: "at most the sync copy changes, through 'sync
     off'").
   - A data row whose person fails the scope check is plan 9's `leave`, as before.
9. **The why line** (spec: `server_why` "names the strongest part of the score and the weakest, if one is poor").
   `server_why` holds a key; the card turns it into words (Task 7). In this order: `server` (number 1); `pinned` (a
   place by hand); `handing` (a numbered row of D outside T); `next` (from number 4 on); `new` (a newcomer at 2 or 3);
   else `<online>.<part>`. `<online>`: `always` (a share of 0.95 or more), `mostly` (0.75 or more), `often_off`.
   `<part>` reads the parts as shares of their points: link (both of number 1's, out of 20), internet (10), disk (20),
   memory (5), cores (5). The weakest, when under 0.4 (ties in that order): `slow_link`, `slow_internet`, `slow_disk`,
   `small` (its memory the least of the numbered machines from 2, ties included) or `little`, `few_cores`. Else the
   strongest (ties in the order link, disk, internet, memory, cores): `best_link` (its link share the highest of the
   numbered machines from 2, ties included) or `good_link`, `fast_disk`, `fast_internet`, `big`, `many_cores`. A row
   pinned `none` has `out`; a row with no number and no pin, null. (Deviation in form: the mockup words only the link
   and memory; the other parts get words of the same shape.)
10. **On screen** (spec section 2; the mockup; the team lead: "No voter or copy roles on screen, only the Priority
    column and a select on the card"). The Priority column is sortable and the table's first sort when the answer says
    the viewer sees the order (`priority`); its cell is the number in a box, number 1 filled, or a dash whose title says
    why. The card's Priority part: the number and its line; on every numbered machine but 1, for the CEO alone, the
    radios Automatically, By hand and Does not take the server, a select of 2 to N under By hand, and the line "If
    machine 1 goes away, machine 2 takes the server, then 3."; on a machine that is not fit, a dash and "Cannot take the
    server: <reason>", in the spec's words for a phone, a machine without Docker, memory and scope, and in plan 9's
    words under the same lead for the others; on a machine pinned `none`, a dash, "Never takes the server: set by hand",
    and the radios with that choice still selected. The machine the server runs on (`server` in `GET /api/machines`)
    shows 1 and "The company server runs here", as today. Plan 9's `why` and "Holds no copy: <reason>" lines under the
    owner move into this part; the copy's line stays where plan 9 put it. "Move the server here" is 9c's. The tab's line
    names every copy, so three while one is handed over.

## Review Focus

1. The only up-to-date copy dropped, or fewer copies than before: a copy retired while a machine of T is not up to date,
   while it is named sync, with T empty or short of a machine, or two at once; "Does not take the server" on the only
   up-to-date copy; two copies made at once by handovers, or two handovers in a day without the CEO. Tests in Task 4
   (each `planRoles` case, `hands a copy over`, `checks again before it cuts`) and Task 6 (`refuses the only up-to-date
   copy`), and Task 8's lab steps.
2. The server moved, or number 1 given to another row, by a ranking or a pin: a pin on the leader's machine, a pin
   stored on a machine that later leads, a leader whose measures fail `unfit` or are missing. Tests in Task 3 (`numbers
   the leader 1 whatever it measures`), Task 4 (`clears the pin of the machine that leads`) and Task 6 (`refuses a pin
   on the server's machine`).
3. A retired copy that still holds the company: its owner losing whole-company scope, or its Disconnect, before its
   wipe, with the link key left as it knows it; an upload that cannot reach the leader through the relay; a machine
   given data again that reads its old copy as up to date, or reuses a slot name. Tests in Task 5 (`takes the data from
   a copy being retired`, `changes the link key when a retiring machine is disconnected`, `uploads through the app
   service once it is a worker`, `forgets the copy when a machine is wiped`, `starts above its last attempt after a
   wipe`).
4. An order that churns, or pins that clash: two close machines swapping every day, a laptop asleep at the scoring
   losing its number or its copy, a pin that keeps two others from passing, a leave the ranking does not see, two pins
   on one place, a pin above N, a Disconnected machine keeping its number or pin. Tests in Task 3 (`does not swap within
   5 points`, `puts the 95% class first`, `keeps the order without a scoring`, `settles around a pin`, `places the
   pins`), Task 4 (`keeps its number while asleep`, `scores once a day`, `scores after a lost scope`, `frees the place
   of a machine that left`) and Task 6 (`takes the place from another pin`, `unpins`).
5. Measures that mislead: no internet, github.com answering 403 or a captive page, a download cut short or stalled, a
   keeper restarted, a peer server that had sent bytes before the keeper counted, a late tick, a new leader whose keeper
   has no throughput yet. The score keeps the last values, counts no failed download and takes every missing value.
   Tests in Task 2 (`keeps the last throughput`, `counts no failed download`, `counts any answer as a round trip`,
   `starts from the counts it finds`, `keeps the day across a restart`) and Task 3 (`scores missing measures`).

---

### Task 1: The measures' columns and the ranking's row

**Repo:** the `network` worktree, branch `network`. **Starts from:** plan 9's last task committed there. **Done when:**
from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/migrations.test.ts test/lease-store.test.ts
test/orchestrator-control.test.ts test/merge-rules.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`machines`), `apps/server/src/modules/merge/rules.ts` (`BOOKKEEPING`)
- Create: `apps/server/drizzle/0056_server_order.sql` (and its `meta` entries, as drizzle-kit writes them)
- Test: `apps/server/test/migrations.test.ts`, `apps/server/test/lease-store.test.ts`,
  `apps/server/test/orchestrator-control.test.ts`, `apps/server/test/merge-rules.test.ts`

**Interfaces:**
- Produces, on `machines` in `schema.ts`, each with a one-line comment in the file's voice:
  ```ts
  linkRttMs: integer('link_rtt_ms'),          // the median round trip of its hellos to the leader over 24 h
  linkMbps: integer('link_mbps'),             // the best minute of the leader's sending to it over 24 h; kept
  internetRttMs: integer('internet_rtt_ms'),  // the median round trip to github.com over 24 h
  internetMbps: integer('internet_mbps'),     // its last daily download from github.com
  ```
  with `check('machines_measures_range', sql\`link_rtt_ms >= 0 AND link_mbps >= 0 AND internet_rtt_ms >= 0 AND
  internet_mbps >= 0\`)` (a null passes a check).
- The hand-written part of `0056_server_order.sql`, after the generated statements:
  ```sql
  CREATE TABLE net.ranking (id boolean PRIMARY KEY DEFAULT true CHECK (id), rescored_at timestamptz,
    handover_at timestamptz);
  CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.ranking
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
  ```
- `BOOKKEEPING.machines` gains `link_rtt_ms`, `link_mbps`, `internet_rtt_ms` and `internet_mbps`.

- [ ] **Step 1: Write failing tests.**
  - `migrations.test.ts`, `migration 0056`, `adds the measures and the ranking's row`: after migrating fully, the four
    columns exist and take null; -1 in each fails with `23514`; `net.ranking` takes one row, and a second fails.
  - `lease-store.test.ts`, `names what keeps it from leading`: on the fixture `problems()` does not name `net.ranking`;
    after `DROP TRIGGER net_fence ON net.ranking` it has `net.ranking has no fence trigger`.
  - `orchestrator-control.test.ts`, `stays out of the ranking`: the orchestrator's `SELECT * FROM net.ranking` fails
    with `42501`.
  - `merge-rules.test.ts`, `never compares what the leader recomputes`: `BOOKKEEPING.machines` also holds the four.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `schema.ts`, `npx drizzle-kit generate --name server_order`, the hand-written part after a
  `--> statement-breakpoint`, and `rules.ts`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the machines' network measures and the ranking's row".

### Task 2: Measuring the network

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/round-trips.test.ts test/internet.test.ts
test/throughput.test.ts test/peer-server.test.ts test/peer-link.test.ts test/keeper.test.ts test/worker-keeper.test.ts
test/network-routes.test.ts test/copies-order.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/round-trips.ts`, `apps/server/src/modules/keeper/internet.ts`,
  `apps/server/src/modules/keeper/throughput.ts`, `apps/server/src/modules/copies/measured.ts`
- Modify: `apps/server/src/net/peer-server.ts` (`sentBytes`), `apps/server/src/net/peer-link.ts` (the hellos' round
  trips), `apps/server/src/modules/keeper/keeper.ts` (the leading keeper: `Throughput`, `InternetMeasures`, the report),
  `apps/server/src/modules/keeper/worker.ts` (the report), `apps/server/src/modules/keeper/state.ts` (`KeeperState` and
  its zod shape), `apps/server/src/modules/network/routes.ts` (the report), `apps/server/src/modules/copies/order.ts`
  (`Ranking`'s run calls `storeThroughput` first)
- Test: `apps/server/test/round-trips.test.ts`, `apps/server/test/internet.test.ts`,
  `apps/server/test/throughput.test.ts` (new), `apps/server/test/peer-server.test.ts`,
  `apps/server/test/peer-link.test.ts`, `apps/server/test/keeper.test.ts`, `apps/server/test/worker-keeper.test.ts`,
  `apps/server/test/network-routes.test.ts`, `apps/server/test/copies-order.test.ts`

**Interfaces:**
- Consumes: Task 1's columns; `PeerServer`, `Peer` (plan 5); `PeerLink` (plan 5b); `readKeeperState`, `writeKeeperState`
  (plan 2); `Ranking` (plan 9).
- Produces:
  ```ts
  // modules/keeper/round-trips.ts
  export const DAY_MS = 86_400_000;
  export class RoundTrips {
    constructor(opts?: { keepMs?: number; everyMs?: number });   // DAY_MS; at most one sample per everyMs (20_000)
    add(ms: number, at: number): void;                          // at: Date.now()-style ms
    median(now: number): number | null;                         // of the samples within keepMs, rounded; null: none
  }
  // modules/keeper/internet.ts
  export const INTERNET_EVERY_MS = 600_000;
  export const PING_TIMEOUT_MS = 5_000;
  export const DOWNLOAD_FIRST_MS = 600_000;
  export const DOWNLOAD_TIMEOUT_MS = 60_000;
  export const DOWNLOAD_REDIRECTS = 3;
  export const INTERNET_FILE = 'internet.json';        // keeper dir: { mbps, mbpsAt, triedAt }
  export const DOWNLOAD_EVERY_MS = 86_400_000;
  export const DOWNLOAD_BYTES = 4 * 2 ** 20;
  export const DOWNLOAD_MIN_BYTES = 2 ** 20;
  export const PING_URL = 'https://github.com/';
  export const DOWNLOAD_URL =
    'https://github.com/fatedier/frp/releases/download/v0.71.1/frp_0.71.1_linux_amd64.tar.gz';
  export class InternetMeasures {
    constructor(opts: { dir: string; pingUrl?: string; downloadUrl?: string; ca?: string; now?: () => number;
      clock?: () => number; log?: (line: string) => void });
    //   dir: the keeper's volume; ca: a PEM the tests trust; now: wall ms; clock: performance.now() for the timings
    start(): void;               // reads INTERNET_FILE (a file of another shape is ignored)
    stop(): void;                // destroys a request under way
    ping(): Promise<void>;       // ruling 2: two HEADs on one kept-alive socket, the second timed
    download(): Promise<void>;   // ruling 2: one ranged GET; the last good rate and the try's time to INTERNET_FILE
    snapshot(): { internetRttMs: number | null; internetMbps: number | null };
  }
  // modules/keeper/throughput.ts
  export const THROUGHPUT_TICK_MS = 100;
  export const THROUGHPUT_SLOTS = 600;                 // a sliding minute
  export const THROUGHPUT_MIN_BYTES = 4 * 2 ** 20;
  export const THROUGHPUT_FILE = 'throughput.json';    // keeper dir: each machine's best of each hour, 24 h
  export class Throughput {
    constructor(opts: { dir: string; sent: () => ReadonlyMap<string, number>; now?: () => number; tickMs?: number });
    //   sent: PeerServer.sentBytes; now: wall ms
    start(): void;   // reads THROUGHPUT_FILE, dropping hours older than 24 h; the first tick only sets the bases
    stop(): void;
    tick(): void;                                      // reads sent() once; the tests call it
    best(now: number): Record<string, { mbps: number; at: string }>;   // by machine id, over the last 24 h
  }
  // net/peer-server.ts: PeerServer gains
  sentBytes(): ReadonlyMap<string, number>;   // by Peer.machine: every byte written to that peer's streams, ever
  // net/peer-link.ts: PeerLink gains
  linkRttMs(now?: number): number | null;     // the leader's RoundTrips median; null with no leader or no sample
  // KeeperState (plan 2) gains: throughput?: Record<string, { mbps: number; at: string }>
  // modules/copies/measured.ts
  export function storeThroughput(ctx: Ctx): Promise<number>;
  //   keeper.json's throughput (readKeeperState): each live row whose link_mbps differs gets the value; rows it does
  //   not name keep theirs; answers the rows written
  ```
- `PeerLink`: each hello's round trip, from its request to its answer's headers by `performance.now()`, goes into a
  `RoundTrips` of that target's machine; `linkRttMs` reads the one of `leader()`'s machine.
- `Throughput.tick`: for each machine, the bytes since its last read and the ms since the last tick (by `now`) go into a
  new slot, and slots older than a minute fall out; a machine's first read, or a count lower than its last, only sets
  its base. While the slots' bytes sum to `THROUGHPUT_MIN_BYTES` or more, the rate is `round(sum × 8 / (the ms of the
  slots with bytes / 1000) / 1e6)` Mbit/s, and the best of each hour is kept for 24 hours and written to
  `THROUGHPUT_FILE` when it changes.
- The leading keeper runs a `Throughput` on its `PeerServer.sentBytes` while it leads and writes `best()` as
  `keeper.json`'s `throughput` each time it writes the file, at least once a minute. Every keeper runs an
  `InternetMeasures`. The leading keeper's report and the `WorkerKeeper`'s (so the follow keeper's) gain `internetRttMs`
  and `internetMbps` from its snapshot; the `WorkerKeeper`'s also `linkRttMs: link.linkRttMs()`. A value that is null is
  left out of the report.
- `POST /api/network/report` takes also `linkRttMs`, `internetRttMs` and `internetMbps`, each an integer of 0 to 600000,
  written as sent; a field left out keeps the column.
- `Ranking`'s run (plan 9) calls `storeThroughput(ctx)` before `rank`; a throw is one log line and the rank goes on.

- [ ] **Step 1: Write failing tests.**
  - `round-trips.test.ts`, `takes the day's median`: samples 10, 30, 20 at 0, 20 s, 40 s give 20; a sample 5 s after
    another is not kept; after 24 h and a minute the first falls out; none gives null.
  - `internet.test.ts`, on a local `https.createServer` with a certificate made at run time (as `peer-server.test.ts`
    makes its own), passed as `ca`, and a fake wall clock:
    - `times the second request`: two HEADs on one socket (the server sees one connection), the second answered after 40
      ms: `internetRttMs` at least 40 and under 200.
    - `counts any answer as a round trip`: a 403 counts; a server whose certificate the `ca` does not sign gives no
      sample.
    - `measures a download`: a redirect, then a 206 whose body gives 4 MiB over 400 ms after its headers: `internetMbps`
      about 84; the request had `Range: bytes=0-4194303`; a 200 with an 8 MiB body is read to 4 MiB, its request
      destroyed, and counts.
    - `counts no failed download`: a 404, 512 KiB then a reset, four redirects, and headers then a body that stalls past
      `DOWNLOAD_TIMEOUT_MS` each leave the last value; `stop()` during a download ends it with no sample.
    - `downloads once a day`: with `start()`, the first download 10 minutes in, the next 24 h later; a new
      `InternetMeasures` on the same `dir` 2 h after a download has its rate in `snapshot()` and downloads 22 h later.
  - `throughput.test.ts`, with a fake `sent`, a fake clock and a temporary `dir`:
    - `measures a burst`: 4 MiB in 4 ticks of 100 ms: about 84 Mbit/s for that machine.
    - `needs 4 MiB in a minute`: 3 MiB in one minute gives nothing; 2 MiB, then 2 MiB 50 s later, gives a rate.
    - `keeps the best of the day`: a rate of 50, then 20 an hour later: 50; after 24 h and an hour: 20.
    - `starts from the counts it finds`: a peer server that has sent 100 MiB before the first tick gives no rate; a
      count that drops is a new base, with no negative bytes.
    - `times a late tick`: 4 MiB over one tick that came 400 ms after the one before reads about 84, not 336.
    - `keeps the day across a restart`: a rate of 80, then a new `Throughput` on the same `dir` an hour later and a rate
      of 20: `best` is 80.
  - `peer-server.test.ts`, `counts what it sends each machine`: a `CONNECT db` stream that answers 5 MiB and a hello to
    another peer: `sentBytes()` has at least 5 MiB for the first machine and the hello's bytes for the second.
  - `peer-link.test.ts`, `times its hellos to the leader`: with hellos answered after a delay of 30 ms by the fake peer
    server, `linkRttMs()` is at least 30 and under 200; with no leader, null.
  - `keeper.test.ts`, `writes what it sent each machine`: a leading keeper with a fake `Throughput` writes its `best`
    into `keeper.json`'s `throughput`; `reports the internet`: the report carries the snapshot's two values, and leaves
    out one that is null.
  - `worker-keeper.test.ts`, `reports its round trip and the internet`: the report carries `linkRttMs`, `internetRttMs`
    and `internetMbps`.
  - `network-routes.test.ts`, `stores the network measures`: a report with the three sets the columns; one without them
    keeps them; 600001 and null answer 400.
  - `copies-order.test.ts`, `keeps the last throughput`: `keeper.json` with `throughput` for A of 80 writes `link_mbps`
    80; a `keeper.json` that no longer names A keeps 80; one with A at 20 writes 20.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the three keeper files, `sentBytes`, the hellos' timing, the keepers' reports, the report's
  fields and `storeThroughput`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Measure each machine's connection to the server and to the internet".

### Task 3: The score and the order

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/copies-score.test.ts test/copies-order.test.ts`
passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/copies/score.ts`
- Modify: `apps/server/src/modules/copies/qualify.ts` (`Candidate`, `measuring`),
  `apps/server/src/modules/copies/order.ts` (`Ranked`, `rankOf`, `candidates`)
- Test: `apps/server/test/copies-score.test.ts` (new), `apps/server/test/copies-order.test.ts`

**Interfaces:**
- Consumes: Task 1's columns; `onlineShare` (plan 5b); `unfit`, `Candidate`, `rankOf`, `candidates` (plan 9).
- Produces:
  ```ts
  // modules/copies/score.ts
  export const ALWAYS_SHARE = 0.95;
  export const MOSTLY_SHARE = 0.75;
  export const NEWCOMER_MS = 3 * 86_400_000;
  export const PASS_POINTS = 5;
  export const POOR_PART = 0.4;
  export type Measured = { share: number | null; linkRttMs: number | null; linkMbps: number | null;
    internetRttMs: number | null; internetMbps: number | null; fsyncP99Ms: number | null; memory: number | null;
    cores: number | null };
  export type Parts = { online: number; link: number; internet: number; disk: number; memory: number;
    cores: number };   // each part's points, not rounded
  export function scoreOf(m: Measured): { points: number; parts: Parts };   // ruling 3; points rounded
  export type Scored = { id: string; points: number; always: boolean };
  export function passes(b: Scored, a: Scored): boolean;   // b may pass a, the one above it (ruling 5)
  export function settle<T extends Scored>(order: T[]): T[];
  export function placePins<T extends { id: string }>(free: T[], pinned: { item: T; pin: number }[]): T[];
  //   ruling 7: answers places 2 to N in order (index 0 is number 2), N - 1 = free.length + pinned.length
  export type WhyContext = { leastMemory: number | null; bestLink: number | null };   // over the numbered from 2
  export function whyOf(m: Measured, c: WhyContext): string;   // '<online>.<part>' (ruling 9)
  // modules/copies/qualify.ts: Candidate gains share, linkRttMs, linkMbps, internetRttMs, internetMbps, cores
  //   (number | null each), pin: string | null (server_pin), number: number | null (server_order),
  //   uploadState: string | null, and owner.departments: number (the places person_access gives a listed
  //   person; 0 for a disabled one); Unfit's scope gains departments: number
  // modules/copies/order.ts
  export type Ranked = { id: string; number: number | null; why: string | null; data: boolean; clearPin?: true;
    leave?: true };   // data: as plan 9 means it, until Task 4's planRoles takes its place
  export function rankOf(all: Candidate[], o: { leader: string; dbSize: number; link: boolean; now: Date;
    rescore: boolean }): Ranked[];
  ```
- `unfit` (plan 9) checks the measures on the last report whatever its age: `measuring` when `memory`, `diskFree` or
  `fsyncP99Ms` is null (ruling 4); `REPORT_FRESH_MS` and the report's age go.
- `rankOf`: the leader is `{ number: 1, why: 'server' }`, with `clearPin` when its `pin` is set. A row whose person
  fails the scope check and has the role `data` is `leave` with no number, as in plan 9. The others that may take the
  server are those `unfit` passes and not pinned `none`; the ones pinned to a place are set aside first. Of the rest,
  with `rescore`: established ones (`now - createdAt >= NEWCOMER_MS`) by their `number` first (those without one after,
  by class, points, then the ties), then `settle`; newcomers after them, ordered the same way among themselves. Without
  `rescore`: all of them by their `number` (a row without one, which the caller avoids, last by the ties). That list and
  the pinned ones go into `placePins`. `why` as ruling 9, with `WhyContext` over the rows numbered from 2; `handing` for
  a row of the role `data` numbered from 4; `out` for a pin `none`; null for a row not fit. `data` keeps plan 9's sense
  without group one: true for numbers 2 and 3 and for a row of the role `data` that is not `leave`, so no ranking takes
  a copy away before Task 4. Plan 9's `rank` passes `rescore: true` on every run until Task 4 brings ruling 6's times.
- `candidates` reads the new columns, `onlineShare` of each row, and the count of each listed person's places.

- [ ] **Step 1: Write failing tests.**
  - `copies-score.test.ts`:
    - `scores each part on its line`: a share 1, round trips of 20 ms, throughputs of 100 Mbit/s, fsync 2 ms, 16 GiB and
      8 cores give 100; round trips of 160 ms give half of each round trip's points (5 and 2.5); 300 ms, 5 Mbit/s, fsync
      50 ms, 4 GiB and 0 cores give 0 for those parts; 10 GiB gives 2.5 for memory, 4 cores 2.5.
    - `scores missing measures`: every measure null gives 5 (the throughput from number 1); a share of 0.5 alone adds
      20.
    - `does not swap within 5 points`: two machines of one class at 70 above 75: they stay; at 70 above 76 they swap.
    - `puts the 95% class first`: a share of 0.95 at 60 below a share of 0.94 at 90: they swap; the reverse never.
    - `settles a whole order`: a list of five built so that one pass is not enough ends with no machine passing the one
      above it, the 95% class first.
    - `places the pins`: free A, B, C and D pinned 2: D, A, B, C; free A and B, D pinned 3 and E pinned 9: A, D, B, E
      (E, above N, takes the last free place).
    - `words why`: a share of 1, a link share of 0.95 above every other part of its own (each 0.9) and the highest of
      the numbered gives `always.best_link`; the same with another numbered machine's link share at 1 gives
      `always.good_link`; a share of 0.8 with fsync 40 ms (0.2 of the disk) gives `mostly.slow_disk`; a share of 0.5
      with memory of 5 GiB the least gives `often_off.small`, with another's less, `often_off.little`; a share of 1 with
      the link at 0.5 and every other part full gives `always.fast_disk`.
  - `copies-order.test.ts`, `rankOf` on candidates the test builds, as plan 9's cases with `dbSize` 1 GiB, `link` true
    and full measures unless a case says; plan 9's cases stay with every candidate made less than 3 days before `now`
    with equal measures and shares, so the ties decide as before, their `data` assertions move to Task 4's `planRoles`
    tests, `keeps the machines that hold a copy ahead` goes (the score decides), and the `measuring` case becomes a
    machine that never reported its memory. New cases:
    - `numbers the leader 1 whatever it measures`: the leader with no report and memory 1 GiB is 1, `server`; a pin `3`
      on it gives `clearPin`.
    - `ranks by the score once established`: A, B, C made 10 days ago with shares 1, 0.96, 0.5 and points such that C
      has the most: with `rescore` and no numbers before, A and B above C (the 95% class), A above B by points.
    - `ranks newcomers by class and points`: established E; newcomers N1 (a whole-company person's, a share of 1) and N2
      (the CEO's, a share of 0.1, better measures): E 2, N1 3, N2 4. Newcomers N3 3 at 70 points and N4 4 at 74, one
      class: N3 3, N4 4. Two newcomers with no number and equal points: the CEO's first.
    - `keeps the order without a scoring`: A and B made 10 days ago, one class, numbers A 3 and B 2 before, A now 20
      points ahead: without `rescore` B 2, A 3; with it A 2, B 3.
    - `keeps a place for a pinned machine`: A and B established, B pinned 2 with A ahead by points: B 2, A 3, `pinned`
      on B.
    - `settles around a pin`: established A 2 at 70 points, P pinned 3 at 75, B 4 at 80, one class: with `rescore`, B 2,
      P 3, A 4 (P set aside, B leads A by 10).
    - `leaves out a machine that does not take the server`: B pinned `none`: no number, `out`.
    - `says why a copy waits for its place`: from number 4 `next`; a row of the role `data` at 4 `handing`; a newcomer
      at 2 `new`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `score.ts`, `unfit`'s change, `rankOf` and `candidates`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Score the machines that may take the server and order them, the 95% class first".

### Task 4: Ranking with the score, and handing a copy over

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 3 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/copies-order.test.ts test/copies-scope.test.ts
test/sync.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/src/modules/copies/order.ts` (`rank`, `Ranking`, `planRoles`),
  `apps/server/src/modules/copies/scope.ts` (`leaveData`, `afterLeave`), `apps/server/src/modules/keeper/sync.ts` (the
  sample's `number`)
- Test: `apps/server/test/copies-order.test.ts`, `apps/server/test/copies-scope.test.ts`,
  `apps/server/test/sync.test.ts`

**Interfaces:**
- Consumes: Task 1's `net.ranking`; `rankOf`, `Ranked` (Task 3); `storeThroughput` (Task 2); `cutReplication(db,
  machines)`, `leaveData`, `afterLeave` (plan 9); `freshState` (plan 2) and `keeper.json`'s `copies` (plan 9).
- Produces:
  ```ts
  // modules/copies/order.ts
  // Ranked (Task 3) loses data: the roles are planRoles'
  export const RESCORE_EVERY_MS = 86_400_000;
  export const HANDOVER_EVERY_MS = 86_400_000;
  export type Roles = { grant: string[]; retire: string | null; handover: boolean };
  export function planRoles(o: {
    numbered: { id: string; number: number }[];             // Ranked rows with a number from 2
    data: { id: string; number: number | null; out: boolean }[];   // D (ruling 8); out: pinned none
    eligible: Set<string>;                                  // may get data: fit, live, upload_state null
    ready: Set<string>; sync: string | null;                // machine ids, from keeper.json's copies
    handoverAt: Date | null; now: Date; ceo: boolean;
  }): Roles;
  export function rank(ctx: Ctx, now?: Date, opts?: { rescore?: boolean; ceo?: boolean }):
    Promise<{ changed: number; scored: boolean }>;
  // Ranking: start() runs at once with rescore; now() becomes
  now(opts?: { rescore?: boolean; ceo?: boolean }): Promise<void>;
  //   the run after the one running, its options or-ed with those of every call before it starts; resolves when it
  //   ended and rejects with its error; a run that throws, by now() or by the minute, hands rescore on to the next
  // modules/copies/scope.ts
  export function leaveData(tx: Tx, machineIds: string[], now: Date, opts?: { lost?: boolean }): Promise<void>;
  //   lost true (the default): plan 9's ruling 10; false: the role worker, upload_state waiting and their
  //   certificates revoked, nothing else (ruling 8)
  // afterLeave (plan 9) calls ranking.now({ rescore: true }), not awaited
  ```
- `planRoles`, ruling 8, in this order. T is `numbered` with 2 or 3. Seats: `COPIES` less the rows of `data`; while any
  are left, each machine of T not in `data` and `eligible`, the lower number first, is in `grant`. When no seat is free
  and a machine of T is not in `data` and is `eligible`: if every machine of T that is in `data` is in `ready`, and
  `handoverAt` is null, 24 h before `now` or more, or `ceo`, the lower such machine is in `grant` and `handover` is
  true. `retire`: when T is not empty and every machine of T is in `data` and in `ready`, the first row of `data`
  outside T that is not `sync` and, unless T holds `COPIES` machines, is `out`, rows without a number first, then the
  higher number, then the id; else null.
- `rank`, in one transaction: rows not live whose `server_order` or `server_pin` is set get both and `server_why` null;
  the live rows `FOR UPDATE`; `net.ranking`'s row (made when missing) `FOR UPDATE`. It scores (ruling 6) when
  `opts.rescore`, when `rescored_at` is null or `RESCORE_EVERY_MS` old, when a row was cleared above, or when the
  candidates show a join, a leave or a leader not at 1. Then `rankOf` with that `rescore`, the numbers written as plan 9
  writes them (null first on every row that changes, then the values), `server_why`, `server_pin` null on `clearPin`;
  `planRoles` on `keeper.json` read by `freshState` (a copy is in `ready` when its `copies` state is `sync` or `pace`,
  matched to its row by `copy_name`; a stale or missing file gives none), each `grant` row the role `data` as plan 9
  sets it; `rescored_at` now when it scored, `handover_at` now on `handover`. After it commits: each `leave` row as plan
  9; then the `retire` row R, only if a fresh `keeper.json` read again still has every machine of T `sync` or `pace` and
  `SHOW synchronous_standby_names` does not name R's `copy_name`: `cutReplication(ctx.db, [{ id: R, copyName }])`, then
  in a transaction `leaveData(tx, [R], now, { lost: false })`. `changed` counts the rows written; `ceo` comes from
  `opts`.
- `SyncController`'s sample (plan 9): a data row whose `server_order` is null is `number: Infinity`.

- [ ] **Step 1: Write failing tests.**
  - `copies-order.test.ts`, `planRoles`:
    - `gives free seats at once`: T A 2, B 3, `data` empty: `grant` A, B; `handover` false.
    - `fills the seat of a lost copy`: `data` A, T A, B: `grant` B.
    - `hands a copy over`: `data` A 2, C 4, both `ready`, T A, B 3, `handoverAt` 25 h ago: `grant` B, `handover` true;
      23 h ago: nothing; 23 h ago with `ceo`: `grant` B.
    - `makes one copy at a time`: `data` A 2 (not `ready`), C 4; T A, B 3: no `grant`, also with `ceo`; A `ready` and
      `ceo`: `grant` B.
    - `waits for the copy being made`: `data` B 2 (not `ready`, a handover's), C 4 (`ready`); T B, D 3; `handoverAt`
      null: no `grant`; B `ready`: `grant` D.
    - `retires only after the new copy is up to date`: `data` A 2, B 3, C 4; `ready` A, C: no `retire`; `ready` A, B, C
      and `sync` C: none; `sync` A: `retire` C.
    - `keeps a copy that only stopped qualifying`: `data` A 2 (`ready`, `sync`) and C with no number (`ready`), T A: no
      `retire`; C `out`: `retire` C.
    - `keeps the only copy`: `data` C with no number, T empty, `ready` C: no `retire`.
    - `retires one a run`: `data` A 2, B 3, C 4, E with no number, all `ready`, `sync` A: `retire` E.
    - `gives no data to a machine being wiped`: T A 2, B 3, `eligible` A, `data` empty: `grant` A.
  - `copies-order.test.ts`, on `testApp` leading with machines, their reports, `machine_online` rows for their shares,
    the fake relay, and the replication catalogs and `synchronous_standby_names` read through the fake plan 9's scope
    tests set (plan 9's cases; `swaps two numbers without a clash` calls `rank` with `{ rescore: true }` the second
    time, since a run that does not score keeps the order):
    - `keeps its number while asleep`: a fit machine whose last report is 30 hours old keeps its number and its role
      through a scoring.
    - `scores once a day`: after `rank` at t0, A's measures made far better than B's above it: at t0 + 1 h nothing
      changes and `scored` is false; at t0 + 24 h A passes B and `rescored_at` is t0 + 24 h.
    - `scores when a machine joins`: a new fit row gets a number on the next run, which scored.
    - `scores after a lost scope`: plan 9's `PATCH` that makes a data machine's person listed: the run `afterLeave` asks
      for has `scored` true.
    - `frees the place of a machine that left`: a revoked row with `server_order` 2 and `server_pin` `'2'`: `rank`
      clears both without an error and another row gets 2.
    - `clears the pin of the machine that leads`: the leader's row with `server_pin` `'3'` ends with null.
    - `hands a copy over`: L, A 2 and B 3 holding copies, C made 10 days ago with a share of 1 and B's 0.5, all
      established: a scoring gives C 3 and the role `data`, B 4 with `server_why` `handing`, and `handover_at` now; with
      `keeper.json` naming A `sync`, B `pace` and C `behind`, the next run retires nothing; with C `pace`, it retires B:
      its slot cut first, the role `worker`, `upload_state` `waiting`, its certificate revoked, no `data_left_at`, the
      fake relay saw no `changeKey`, and `peer_secrets` are as they were.
    - `checks again before it cuts`: as above with C `pace`, but the fake setting names B's copy at the second read:
      nothing is cut and B keeps the role `data`; the next run, the setting naming A's, retires B.
    - `tells the caller of a failed run`: with the database made to throw once, `ranking.now({ rescore: true })`
      rejects, and the next run scores.
  - `copies-scope.test.ts`, `retires without changing keys`: `leaveData(tx, [D], now, { lost: false })`: D has the role
    `worker`, `upload_state` `waiting`, no `data_left_at`, its number as before, its certificate's serial in
    `revokedSerials`; `public_links.next_key_enc` null and `peer_secrets` unchanged.
  - `sync.test.ts`, `prefers a numbered copy to one being handed over`: finished copies C (number 3) and R (no number)
    both keeping pace for 30 s, the setting naming R: the controller posts off, clears, and then names C.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `planRoles`, `rank`'s changes, `Ranking.now`'s options, `leaveData`'s option, `afterLeave`'s
  scoring and the sample's number.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Rank by the score once a day, and hand a copy over only once the new one is up to date".

### Task 5: A retired copy's way out, and back

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 4 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/copies-scope.test.ts test/nodes.test.ts
test/network-routes.test.ts test/network-join.test.ts test/copy-maker.test.ts test/worker-keeper.test.ts
test/follow-keeper.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing.

**Files:**
- Modify: `apps/server/src/modules/copies/scope.ts` (`leavingData`, `leaveData`),
  `apps/server/src/modules/nodes/disconnect.ts`, `apps/server/src/modules/network/routes.ts` (the report's `wiped`),
  `apps/server/src/modules/network/join.ts` (`CopyOrder`), `apps/server/src/modules/keeper/copy.ts` (the first attempt),
  `apps/server/src/modules/keeper/worker.ts` (`visitKind`), `apps/server/src/modules/keeper/follow.ts`
- Test: `apps/server/test/copies-scope.test.ts`, `apps/server/test/nodes.test.ts`,
  `apps/server/test/network-routes.test.ts`, `apps/server/test/network-join.test.ts`,
  `apps/server/test/copy-maker.test.ts`, `apps/server/test/worker-keeper.test.ts`,
  `apps/server/test/follow-keeper.test.ts`

**Interfaces:**
- Consumes: Task 4's retire; plan 9's `leavingData`, `leaveData`, `disconnectMachines`' data path, the report's `wiped`,
  `CopyOrder` (the view's `copy`), the copy maker and `copy-state.json`, `WorkerKeeper`'s `visitKind` and
  `FollowKeeper`; plan 5b's `PEERS_FILE`.
- Produces (ruling 8's last points):
  - `leavingData` (plan 9) also answers the person's live machines with `upload_state` set, whatever their role; their
    `leaveData` (lost) sets `data_left_at`, and `upload_state` `waiting` only where it is null, so an upload received or
    kept is not made again. `disconnectMachines` treats a row with `upload_state` set as a data machine's (plan 9):
    `data_left_at` and the link key changed.
  - A report with `wiped` (plan 9), with `upload_state`, sets `copy_state`, `copy_progress`, `copy_error`, `copy_at` and
    `copy_old` null; `copy_name` stays.
  - ```ts
    // modules/network/join.ts: CopyOrder gains
    lastAttempt: number | null;   // the attempt in the row's copy_name, null without one
    // modules/keeper/worker.ts: WorkerKeeper's visitKind gains 'view': 'data' while the last view (at start, the one
    //   in PEERS_FILE) carries a dataSecret, else 'app', taken again on each view
    ```
  - The copy maker, with no `copy-state.json`, starts at the attempt `lastAttempt + 1` (1 when null).
  - `FollowKeeper` passes `visitKind: 'view'`, so a retired copy reaches the leader through the `-app` service with its
    worker certificate, after a restart too.

- [ ] **Step 1: Write failing tests.**
  - `copies-scope.test.ts`, `takes the data from a copy being retired`: R retired (the role `worker`, `upload_state`
    `waiting`, no `data_left_at`), its owner's access patched to one department: R has `data_left_at`, the fake relay
    saw one `changeKey`, the `peer_secrets` were renewed, and R's `upload_state` is `waiting`; with R `kept` before the
    patch, it stays `kept`.
  - `nodes.test.ts`, `changes the link key when a retiring machine is disconnected`: Disconnect of R sets its
    `data_left_at` and changes the key once.
  - `network-routes.test.ts`, `forgets the copy when a machine is wiped`: a row with `copy_state` `ready`, `copy_name`
    `copy_<16 hex>_7`, a `copy_at`, `copy_old` 6 and `upload_state` `kept`; a report with `wiped`: those and
    `upload_state` null, `copy_name` as it was.
  - `network-join.test.ts`, `names the last attempt`: a data row with `copy_name` `copy_<16 hex>_7` gets `lastAttempt`
    7; with none, null.
  - `copy-maker.test.ts`, `starts above its last attempt after a wipe`: no `copy-state.json` and `lastAttempt` 7: the
    subscription it makes is `copy_<16 hex>_8`; with null, `_1`.
  - `worker-keeper.test.ts`, `dials by the view's secret`: with `visitKind` `'view'`, a view with a `dataSecret` gives
    the visitor config `-data` targets, a view without one `-app` targets with the app secret; started with a
    `PEERS_FILE` view without one, `-app` from the start.
  - `follow-keeper.test.ts`, `uploads through the app service once it is a worker`: a view that turns to the role
    `worker` with `upload` `waiting`: the visitor config names the leader's `-app` service, and the upload's `PUT`
    reaches the fake leader's `app` listener.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the scope and Disconnect paths, the `wiped` report, `lastAttempt`, the maker's first attempt
  and `visitKind: 'view'`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep a retired copy under the lost-scope rules until its wipe, and let it hold a copy again
  later".

### Task 6: The CEO's choice of a machine's place

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/copies-priority.test.ts test/nodes.test.ts` passes,
then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/copies/priority.ts`
- Modify: `apps/server/src/modules/nodes/routes.ts` (the route), `apps/server/src/errors.ts` (reasons `leader_pin`,
  `only_copy`, `unfit`)
- Test: `apps/server/test/copies-priority.test.ts` (new), `apps/server/test/nodes.test.ts`

**Interfaces:**
- Consumes: `rank`, `Ranking.now` (Task 4); `candidates`, `unfit` (Tasks 2 and 3 of plan 9, Task 3 here);
  `findThisMachine` (plan 5); `builtinMachine`, `shownMachine` (plan 5b); plan 7's check of the CEO.
- Produces:
  ```ts
  // modules/copies/priority.ts
  export type Pin = null | 'none' | number;
  export function setPriority(ctx: Ctx, machineId: string, pin: Pin): Promise<void>;
  //   ruling 7's refusals, then in one transaction: the live rows FOR UPDATE, server_pin of another row with this
  //   place set null, this row's server_pin set ('none', the place as text, or null); after it commits,
  //   ctx.ranking.now({ rescore: true, ceo: true }) awaited; when it rejects, ApiError(503, 'unavailable', 'Try
  //   again in a minute.', 'try_again'), the pin stored
  // routes: PUT /api/machines/:id/priority, body { pin: null | 'none' | integer }; 204
  ```
- The route: `requirePerson`, then plan 7's check of the CEO; the machine looked up as the other `/api/machines/:id`
  routes do (404 for an unknown machine or a `server:` row); a body of another shape 400 `invalid`; outside lead, 503 as
  the other writing routes answer.
- The leader's machine is `findThisMachine`'s row or the machine `builtinMachine` marks `server`. "The only up-to-date
  copy": the row has the role `data`, its copy is `sync` or `pace` in a fresh `keeper.json`, and no other data row's is.
  N: the rows `rankOf` would number with this change made, the leader's included, so a machine coming back from `none`
  may take N.

- [ ] **Step 1: Write failing tests.**
  - `copies-priority.test.ts`, on `testApp` leading with the CEO, a whole-company person P, the leader L and fit
    machines A 2, B 3, C 4, each with reports:
    - `pins a place`: the CEO's `PUT` `{ pin: 2 }` on B answers 204; B is 2 with `server_why` `pinned`, A 3, and
      `net.ranking.rescored_at` moved.
    - `takes the place from another pin`: A pinned `'2'`, then `{ pin: 2 }` on B: A's `server_pin` null, B 2.
    - `unpins`: `{ pin: null }` on B: its `server_pin` null and the run scored.
    - `keeps a machine out`: `{ pin: 'none' }` on C: C has no number and `server_why` `out`; `{ pin: 4 }` on C then
      gives C 4.
    - `refuses a pin on the server's machine`: on L's row and on the machine `GET /api/machines` marks `server`: 409
      `leader_pin` "Move the server to another machine first.", and nothing changed.
    - `refuses the only up-to-date copy`: A and B of the role `data`, `keeper.json` naming A `sync` and B `behind`:
      `none` on A answers 409 `only_copy` "<A's hostname> holds the only up-to-date copy; give another machine a place
      first."; with B `pace`, 204.
    - `refuses a place it cannot take`: `{ pin: 1 }`, `{ pin: 5 }`, `{ pin: 2.5 }`, `{ pin: 'x' }` and `{}` answer 400
      `invalid`; `{ pin: 2 }` on a phone answers 400 `unfit` "This machine cannot take the server.".
    - `answers the CEO alone`: P's `PUT` answers 403 `not_owner_session`, and so does the CEO's through a `via`.
    - `answers try again when the ranking fails`: with the ranking made to throw once, `{ pin: 2 }` on B answers 503
      `try_again`, B's `server_pin` is `'2'`, and the next run gives B 2.
  - `nodes.test.ts`, `knows the priority route`: an unknown machine id answers 404; a `server:` row's id 404.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `priority.ts`, the route and the reasons.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let the CEO set a machine's place in the server order, or keep it from the server".

### Task 7: The Priority column and the card's Priority part

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 6 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/copies-view.test.ts test/nodes.test.ts` passes; from
`apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/Machines.test.tsx test/i18n.test.tsx
test/SortTable.test.tsx` passes; then the whole suite; both `tsc` commands print nothing.

**Files:**
- Modify: `apps/server/src/modules/copies/view.ts` (`DataView`, `CopiesView`), `apps/server/src/modules/nodes/routes.ts`
  (`GET /api/machines`' `priority`), `apps/web/src/types.ts`, `apps/web/src/screens/Machines.tsx`,
  `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/ru.ts`, `apps/web/src/theme.css`
- Test: `apps/server/test/copies-view.test.ts`, `apps/server/test/nodes.test.ts`, `apps/web/test/Machines.test.tsx`,
  `apps/web/test/i18n.test.tsx`

**Interfaces:**
- Consumes: Task 4's columns as `rank` writes them; Task 6's route; plan 9's `DataView`, `CopiesView` and its lines.
- Produces:
  ```ts
  // modules/copies/view.ts, DataView becomes
  export type DataView = { number: number | null; why: string | null; pin: 'none' | number | null;
    unfit: Unfit | null; copy: CopyLine | null; leftAt: string | null };
  //   why: server_why as stored; pin: server_pin read
  // CopiesView: copies may hold any number of rows (three during a handover)
  // GET /api/machines gains priority: boolean, true for those who get data (the CEO and whole-company people)
  ```
  and the same in `apps/web/src/types.ts`.
- `Machines.tsx`, as the mockup's `prioCell` and `prioBody` and ruling 10:
  - a column `{ key: 'priority', label: t.cards.priority, direction: 1, className: 'k-prio' }` when the answer's
    `priority` is true, also for a company whose only machine is the server's, its value 1 for the `server` row, else
    `data.number` (null sorts last), its cell `.pn` (`.pn.one` for 1, with the title "Number set by hand" when pinned)
    or `.pdash` with the title of `t.machines.priority.cannot` or, pinned `none`, `t.machines.priority.out`, and the
    same words in an `.sr` span; with it the table's `initialSort` is `{ key: 'priority', direction: 1 }`, without it
    `status` as today (the table mounts once the answer is in, so its first sort sees the column).
  - The card's Priority part, for every machine when `priority` is true, in place of today's: `server`: `.pn.one` 1 and
    "The company server runs here", then the line; a number: `.pn` and its why, and for the CEO (`me.person.isOwner`) on
    numbers from 2 the radio group (`role="radiogroup"`, label Priority) Automatically, By hand, Does not take the
    server, a `select` of 2 to N (N the highest number in the table) under By hand, labelled "Priority of <host>";
    pinned `none`: `.pdash`, "Never takes the server: set by hand", and the radios with that one checked; `unfit`:
    `.pdash` and "Cannot take the server: <reason>". The line "If machine 1 goes away, machine 2 takes the server, then
    3." under every part but `unfit`'s.
  - A radio or the select calls `api.put('/api/machines/<id>/priority', { pin })`: Automatically `null`, By hand the
    machine's number now (or N + 1 from `none`), Does not take the server `'none'`, a select's value its number; while
    it runs the controls are disabled; an error shows under them by `errorText`, `only_copy` as
    `t.machines.priority.onlyCopy(host)`; then the tab reloads.
  - Plan 9's `why` and `unfit` lines under the owner go; the copy's line and `leftAt` stay.
  - The tab's line (plan 9) with three copies or more: "<leader> leads. <a>, <b> and <c> keep copies; <sync, else a>
    takes over if <leader> stops." / «<leader> ведет компанию. <a>, <b> и <c> хранят копии; <sync, else a> возьмет
    сервер, если <leader> остановится.»
- `theme.css`: `.pn`, `.pn.one`, `.pdash`, `.prio`, `.prio-n`, `.pmode`, `.pm-opt` as the mockup's, in the file's
  tokens; `.server-priority` goes.
- Text, `machines.priority` in both files, EN then RU:
  - `cannot`: "Cannot take the server" / «Не может взять сервер»; `out`: "Does not take the server" / «Не берет сервер»;
    `auto`: "Automatically" / «Автоматически»; `manual`: "By hand" / «Вручную»; `pinLabel`: "Priority of <host>" /
    «Приоритет <host>»; `line`: "If machine 1 goes away, machine 2 takes the server, then 3." / «Если машина 1 пропадет,
    сервер возьмет машина 2, за ней 3.»
  - `why`: `pinned` "Number set by hand" / «Номер задан вручную»; `out` "Never takes the server: set by hand" / «Никогда
    не берет сервер: так задано вручную»; `next` "Gets a copy if one of the first three leaves" / «Получит копию, если
    одна из первых трех уйдет»; `new` "New: connected less than 3 days ago" / «Новая: подключена меньше 3 дней назад»;
    `handing` "Keeps its copy until the new one is up to date" / «Хранит копию, пока новая не станет актуальной».
  - `online`: `always` "Always online" / «Всегда в сети»; `mostly` "Online almost always" / «Почти всегда в сети»;
    `often_off` "Often offline" / «Часто не в сети».
  - `part`: `best_link` "best connection to machine 1" / «лучшая связь с машиной 1»; `good_link` "good connection to
    machine 1" / «хорошая связь с машиной 1»; `fast_disk` "fast disk" / «быстрый диск»; `fast_internet` "fast internet"
    / «быстрый интернет»; `big` "plenty of memory" / «много памяти»; `many_cores` "many cores" / «много ядер»;
    `slow_link` "but a slow connection to machine 1" / «но связь с машиной 1 медленная»; `slow_internet` "but slow
    internet" / «но интернет медленный»; `slow_disk` "but a slow disk" / «но диск медленный»; `small` "but has the least
    memory" / «но памяти у нее меньше всех»; `little` "but has little memory" / «но памяти у нее мало»; `few_cores` "but
    has few cores" / «но ядер у нее мало». A key `<online>.<part>` reads "<online>, <part>".
  - `unfit`, after "Cannot take the server: " / «Не может взять сервер: », in place of plan 9's "Holds no copy: " lines:
    `phone` "it is a phone." / «это телефон.»; `no_core` "Hornhoof runs here without Docker; make <host> a full
    machine." / «здесь Hornhoof работает без Docker; сделайте <host> полной машиной.»; `memory` "Docker here gets less
    than 4 GB of memory." / «Docker здесь получает меньше 4 ГБ памяти.»; `scope` "the company's data stays only on
    machines of people who see the whole company, and <person> sees one department." / «данные компании хранятся только
    на машинах тех, кто видит всю компанию, а <person> видит один отдел.», with `departments` 2 or more "sees <n>
    departments" / «видит <n> отдела» (`plural`: «отдел», «отдела», «отделов»), and 0 "sees no department" / «не видит
    ни одного отдела»; `no_link`, `measuring`, `disk` and `fsync` in plan 9's words after the new lead, with "a copy
    needs" made "it needs" / «копии нужно» made «нужно».
  - `onlyCopy`: "<host> holds the only up-to-date copy; give another machine a place first." / «<host> хранит
    единственную актуальную копию; сначала дайте место другой машине.»; and in `errors`, for `errorText`: `leader_pin`
    "Move the server to another machine first." / «Сначала перенесите сервер на другую машину.»; `unfit` "This machine
    cannot take the server." / «Эта машина не может взять сервер.»
  - Today's `cards.priority` and `cards.serverHere` stay.

- [ ] **Step 1: Write failing tests.**
  - `copies-view.test.ts`, `shows the place and the pin`: a row with `server_order` 3, `server_why` `always.best_link`
    and `server_pin` `'3'` gives `number` 3, that `why`, `pin` 3; `'none'` gives `pin` `'none'`; `names every copy`:
    three data rows give three `copies`.
  - `Machines.test.tsx`:
    - `sorts by priority`: rows 1 (`server`), 3, 2 and one with no number show in the order 1, 2, 3, then the dash; the
      header's sort is on Priority; a listed person's answer, with no `data`, has no Priority column.
    - `says why in both languages`: `always.best_link` reads "Always online, best connection to machine 1" and in
      Russian «Всегда в сети, лучшая связь с машиной 1»; `always.small` "Always online, but has the least memory";
      `next` and `handing` their lines.
    - `lets the CEO choose`: for the CEO on number 2 of 4, the three radios with Automatically checked; By hand sends
      `PUT /api/machines/<id>/priority` with `{ pin: 2 }`, its number now; with that pin the select shows 2 to 4 with 2
      chosen, and choosing 3 sends `{ pin: 3 }`; Does not take the server sends `{ pin: 'none' }`; a 409 shows its
      message under them.
    - `shows the choice to the CEO alone`: a whole-company person sees the number and why, no radios.
    - `keeps a machine set out changeable`: pinned `none`: a dash, "Never takes the server: set by hand", the radios
      with Does not take the server checked; Automatically sends `{ pin: null }`.
    - `says why a machine cannot take the server`, in place of plan 9's `says why a machine holds no copy`: a phone,
      `no_core` on host "mac", `memory`, and `scope` with 1, 2 and 0 departments read the spec's lines in both
      languages; no radios.
    - `shows the server's machine as 1`: the `server` row shows 1 and "The company server runs here" whatever its
      `data`; for a company whose only machine is the server's (no shown machine, `builtin` alone, `priority` true) the
      CEO sees the Priority column with 1.
    - `words the refusals`: a 409 `leader_pin`, a 409 `only_copy` and a 400 `unfit` show their lines in English and in
      Russian, `only_copy` with the host.
  - `nodes.test.ts`, `says who sees the order`: `priority` is true for the CEO and a whole-company person, false for a
    listed person.
  - `i18n.test.tsx`, `words the server order in both languages`: each key of `machines.priority` and the two `errors`
    exists in both files; the Russian ones hold no `ё`, no em dash, no «компьютер» and no «узел».
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the view's fields, the types, the column, the part, the styles and both language files.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Show each machine's place in the server order, with why, and let the CEO pin it".

### Task 8: The lab: a pin, a machine kept out, and its copy handed back

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 7 committed. **Done when:** from the worktree
root `npm run test:lab` passes with Docker running; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/test/lab/copies.test.ts` (plan 9's scenario)

**Interfaces:**
- Consumes: plan 9's scenario and helpers; Task 6's route.
- A new step between plan 9's steps 3 and 4 (the writer still running), 35 minutes at most; the scenario's limit goes
  from 40 to 75 minutes:
  - 3a. The CEO's `PUT /api/machines/<m3>/priority` `{ pin: 2 }` on m1: m3 is 2 with `server_why` `pinned` and m2 3 with
    `new` at once; within 60 s the fake relay's record is `on` with m3's network id. `{ pin: null }` on m3: m2 and m3
    hold 2 and 3 (with the 5-point margin the order they had may stand), and within 60 s the record names whichever is
    2.
  - 3b. `{ pin: 'none' }` on m3, with both copies `ready`: 204; m3 has no number; within 10 minutes m3's row has the
    role `worker`, `upload_state` null and no `data_left_at`, m1 has the merge of m3's upload `merged` or `done`, m3's
    `.env` has empty `HORNHOOF_SECRET`, `NODE_KEY` and `POSTGRES_PASSWORD` and `HORNHOOF_ROLE=worker`, and its `docker
    volume ls` has no database volume; m1's `GET /api/machines` `copies` holds m2 alone; the fake relay's link key is
    unchanged.
  - 3c. `{ pin: null }` on m3: within 15 minutes m3 is 2 or 3, of the role `data`, and its copy `ready`; `checkRows` of
    m3 is empty.
  - 3d. m3's `db` paused, and then, once m1's `GET /api/machines` no longer shows m3's copy `ready` (within 30 s), `{
    pin: 'none' }` on m2: 409 `only_copy`; m3's `db` unpaused, and within 3 minutes both copies `ready` again.
- Plan 9's step 4 then runs as before, on m3 a copy again.

- [ ] **Step 1: Write the failing steps**; `npm run test:lab` fails at step 3a.
- [ ] **Step 2: Fix** what it finds in Tasks 2 to 7, each fix with its failing test first in that task's test file.
- [ ] **Step 3: Check the disk, then run Done when,** as plan 7's Task 10 Step 3. Expected: PASS.
- [ ] **Step 4: Commit** "Test the server order in the lab: a pin, a machine kept out and its copy given back".

### Task 9: Run everything and review

**Repo:** the `network` worktree, branch `network`. **Starts from:** Tasks 1 to 8 committed and reviewed. **Done when:**
Steps 1 and 2 pass for the agent; Step 3 is the team lead's, never an agent's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:lab` (after the disk
  check) → pass; the `tsc` commands → no output.
- [ ] **Step 2: Check the public-repo rule.** As plan 7's Task 11 Step 2.
- [ ] **Step 3: Review.** The team lead reads the branch against spec 3.3's server order, section 2's Priority row,
  section 4's row on pins and the daily ranking, section 12's server order bullet as ruling 1 divides it, the team
  lead's points for 9b and this plan's rulings, with Review Focus first; the CLI agent that did not write a task reviews
  it too; one fix pass, each fix with its failing test first.

The rehearsal, the merge into main, Ivan's Updates and the worktree's close are done once, for the whole series, at its
end. This plan's part of that rehearsal is Task 8's steps.
