# Planner's report: plan 13 and the plans' open gaps

Date 2026-11-04. I changed no code and ran no tests. Every quoted screen string in plan 13's Tasks 1 to 7 (73 English and
Russian pairs) was checked by script against the plans and the spec: all found. No "ё" in a Russian string, no em dash, no
email address, no private fact in anything I wrote. The two places plan 13 names "ё" and the banned words are rules or test
assertions.

## What I changed

| File | Change |
|---|---|
| `plans/2026-11-03-network-phase-1-plan-13-lab-and-real.md` | New: 17 tasks, top as plan 11b's |
| `plans/2026-11-03-network-phase-1-overview.md` | Added "The real order", and entries 5b, 9b, 9c, 11b. Nothing else touched |
| `plans/...-plan-3-fences-and-journal.md` | Addendum: no task (p2:148) |
| `plans/...-plan-5-authority-and-peer-link.md` | Addendum: the argument for the lead, and Task A1 |
| `plans/...-plan-7-backups.md` | Addendum and Task A1 (ruling 17 e) |
| `plans/...-plan-9-copies.md` | Addendum and Task A1 (a Mac's changed address) |
| `plans/...-plan-10-takeover.md` | Addendum: no task, no row |
| `plans/...-plan-11-splits.md` | Addendum and Task A1 (the 2-minute edge) |

Every addendum is appended at the end; no plan's existing text was rewritten.

Plan 13's tasks: Tasks 1 to 8 run in this build (the guide, one test that keeps pages true to the screens, `SECURITY.md`, the
README, everything runnable here). Tasks 9 to 12 are lab code written and type-checked here, with their pure parts tested here.
Tasks 13 to 17 are steps for David AI and Ivan: the lab, the relay deploy, the rehearsal, the real run, the merge.

## Rulings for the ledger

Ready to copy. The first needs the lead's decision; the rest are mine and stand unless overruled.

- Ruling (for the lead to take or refuse): plan credentials stay sealed to node keys, no reseal, and spec 3.8 and section 7's "machine keys" are read as the keys held on the owner's machines - why: every promise holds and two get stronger (plan 5's addendum has the table), while a reseal must either give agents' containers the key that opens every bundle, or run every token through a worker's keeper in the clear, or share one key among a machine's plans - cost if wrong: a task in plan 7 for a protocol change and a one-time reseal; nothing has shipped.
- Ruling: plan 5 Task A1 added: a holder of a sign-in that comes online seals it for a node that waited - why: found while reading `credentials.ts`: the Codex path does it (`:85-86`), the others do not (`:89-91`), so a node joined while its only holder slept stays unsigned until its own next hello, against spec:975 - cost if wrong: a few extra `cred.seal` messages.
- Ruling: p2:148 "drains those changes" needs no task, and means "fences those changes" - why: rulings 8 and 9 do not say it, but fence 1, fence 4 and ruling 5 settle every way such a change can end, each with its test, and spec 3.4 fence 4 asks for termination, not a wait - cost if wrong: none found; a change that ended badly is retried by its source.
- Ruling: plan 7 Task A1 owns any lift of a limit on a bundle's way through the relay; the check reads none today, and a test against the real Caddy and frps proves it - why: `Caddyfile` has no body limit, frps's `vhostHTTPTimeout` starts after the body, `MAX_BODY` guards only the relay's API, plan 2's doors have `requestTimeout: 0`, but plan 1 still changes that path - cost if wrong: a 70-second test on the relay's suite.
- Ruling: plan 9 Task A1 wires `PeerLink.seen()` into the leading keeper's report; p5b's "copies, which dial it, tell it" has the direction wrong - why: a copy that dials the Mac sees its own address; the Mac's own dial to its copies is what tells it, and the follow keeper already reports it - cost if wrong: a Mac server with no copy stays on the relay's path until `install.sh` runs again, as p5b ruling 11 already accepted.
- Ruling: no row at 120 s in plan 10's table; plan 11 Task A1 tests the edge (back at 120 and 124 s: the question; at 125 s: a split) - why: to plan 10 every outage from 75 s up reads the same; the edge is where the question meets plan 11's count - cost if wrong: none.
- Ruling: the guide stays in English and names each screen's word in Russian at its first mention on a page - why: `AGENTS.md` keeps repository text in English, and a person on a Russian screen looks for the Russian word - cost if wrong: a little more text.
- Ruling: one new page, `guide/network.md`, tells the whole of several machines, and other pages change only what became untrue - why: one question, six plans - cost if wrong: a page that grows.
- Ruling: the lab gets a real frps and relay in one scenario (plan 13 Task 12) - why: spec:1166 says "a local frps with the contract", the audit did not list it, and p9:1846 says "No frps runs in the lab", so Hornhoof's frpc settings would first meet a real frps in the rehearsal - cost if wrong: one more image and scenario; https mode between frps and a keeper still shows first in the rehearsal.
- Ruling: the stepped clock shifts one machine's keeper by `--require lab-clock.cjs` and its `db` by `libfaketime` in a lab-only image, while `docker pause` holds it - why: the spec asks for it, no plan has it, a paused keeper otherwise sees a late tick so fence 3 is never reached, and a kernel clock must not move on a host other things run on - cost if wrong: harness work; plan 13's ruling 8 has the fallback.
- Ruling: `netem` shows a slow copy, a lossy link and a slow copy being made; it does not force a re-ranking - why: the spec says "the CEO reordering" and plan 9b's lab does that, while the score's median of a day cannot move in a run - cost if wrong: a ranking bug only real measures show waits for the real run.
- Ruling: lab scenarios are written and type-checked here, and get their first red from David AI; their pure helpers go test first here - why: CLAUDE.md's TDD cannot be met without Docker (QUESTIONS.md item 4) - cost if wrong: a typo costs one lab run.
- Ruling: the series' end runs lab, relay at night, migrations numbered, rehearsal, real run on a branch build, and only then the merge - why: spec section 11 wants the real run passed first, and an Update reaches every company - cost if wrong: none, each step is only later.
- Ruling: spec section 10's "recommends FileVault or LUKS" joins plan 9's `leftAt` line (plan 13 Task 7) - why: no plan has it - cost if wrong: one sentence.
- Ruling: physical steps of the real run are Ivan's to time or leave out, and one left out is written "not done" - why: they stop whatever else runs on those machines - cost if wrong: a row not proved, and Ivan knows it.

## Findings beyond the brief and the audit

1. Lab: besides the audit's three (2 to 5, five machines, netem), the spec's **local frps** and **stepped clock** are missing from every plan. Both now have tasks. The frps gap is the larger one.
2. `SECURITY.md:55` still says "Three or more machines that are always on choose the leader by vote", and `README.md:103` lists "Voter". Voting was removed. `SECURITY.md:52`'s list of what the relay keeps is short of what plan 1 stores, while p1:221 says the two agree. All in Task 7.
3. `plan_credentials` gap above: a node that waits is not sealed for when its holder comes online (today's code, not a plan's).
4. Spec section 10's FileVault or LUKS line had no plan.
5. Spec 3.3's "the card then offers a new company secret and API keys as the CEO's choice": p9 ruling 10 makes it a line, not an action, and rules on it. I left it.
6. p7 ruling 15 is still marked "deviation to rule on": the spec wants the restore screen to list plans that need a fresh sign-in, and plan 7 has one line. I found no ruling on it and left it, for the lead.

## What I could not settle

1. **Node keys against the spec's words** is the lead's to rule on. The spec binds, so plan 5's addendum argues and does not decide. The overview's plan 5 scope line and discrepancy 1 still read as before, since the brief said to change nothing else there. `SECURITY.md:27` and the README stand either way. Plan 13's Task 2 words the guide for node keys; if the lead refuses, that one sentence changes.
2. `notes/ops/going-public.md`'s list (the removed plan 12's texts) is not on this machine. Task 7 checks both texts line by line without it, and Task 17 Step 1 has David AI read the list.
3. Lab harness facts I could not test here: `libfaketime` under Postgres 17 with `FAKETIME_NO_CACHE`, `sch_netem` in the kernel of whatever host runs the lab (it fails with a clear line), `compose.lab.yaml` through `COMPOSE_FILE` surviving a machine's role change (a product step that drops the line is reported), and `Stack` bound to all addresses in a container. Each is a first-run risk for David AI, stated in its task.
4. Guide outlines rest on the plans' strings, since the code is at plan 1 today. `guide-words.test.ts` fails where a writer's final wording differs, and Global Constraints say the code's word wins.
5. `guide/public-link.md:35` ("machines that were connected through it lose the connection") may be untrue for a machine with a core after a rename. I did not trace it through plans 5b and 9, and left the line alone. Whoever writes Task 6 should look; if it is wrong, that is a finding of its own.
6. "A third company on both" (spec:1172) I read as a further company beside what each machine already runs, installed once from each side (Task 16 Step 1). Ivan may mean otherwise.
7. Task 16 Step 7's router row has two expected outcomes, since it depends on whether the local network survives the unplug. Ivan says which happened.
8. The order of the addenda in the build: plan 5's A1 after its Task 6, plan 7's A1 once plan 1's Task 9 is in the relay repo, plan 9's A1 after its Task 12, plan 11's A1 after its Task 5. The lead's task list needs them, as they sit outside each plan's numbered chain.
