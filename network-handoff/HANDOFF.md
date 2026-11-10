# Network phase 1: handoff

This branch, `network`, holds everything the network build produced, so a new lead can pull it and go on.
Written 2026-11-10 by David AI at Ivan's request. Nothing here was run after the merges listed below.

## What the work is

Hornhoof's network phase 1: a company's machines work as one network. Plans run on any of the owner's
machines, another machine takes over the server when the first goes away (same link), copies and encrypted
backups live on the company's own machines, and the hornhoof.org relay passes TLS through by name, so it can
never read company traffic.

- Spec: `network-handoff/specs/2026-11-02-single-network-design.md` (the authority the plans argue from).
- Plans: `network-handoff/plans/`, 17 files, about 180 tasks. Start with
  `2026-11-03-network-phase-1-overview.md` (order and dependencies).
- Order of work: `network-handoff/build/queue.md`.
- Ledger: `network-handoff/build/progress.md`. Every `Task N: complete` line is done, every `Ruling:` line stands.
- Rules the build ran under: `network-handoff/CLAUDE.md` and `network-handoff/BRIEF.md` (conveyor v4:
  `network-handoff/FROM-DAVID-conveyor-v4.md`).
- Open questions and answers: `network-handoff/QUESTIONS.md`.
- Briefs, review reports and check logs: `network-handoff/build/briefs/`, `network-handoff/build/runs/`.
- The relay (repository hornhoof-edge, Python): `network-handoff/hornhoof-edge/`, with its full history.

## Who built it and why it stopped

- 2026-11-03 to 11-04: Codex on Ivan's Mac led; then Claude Code (Opus) on a-host, in `~/hornhoof-network`,
  tmux `~/hornhoof-network/bin/tmux -L network`, session `network`, with agent teams, Antigravity (`agy`) and
  a remote test machine (home-api) for heavy runs.
- 2026-11-05 11:52 UTC: the lead's Claude sign-in ran out ("Login reached its time limit · Please run /login").
  Its writers on b9fix, p10t3, p5t5, p3t3 and b10fix stopped with it. Nothing ran after that. The session is
  still open and idle on a-host.
- Nothing of this was on GitHub before this branch. The relay repository had no remote at all.

## Where it stands (from the ledger)

Landed on `network` by the lead, reviewed and fixed (network was at f11376d6 when it stopped):
- Plan 1 (relay contract): Tasks 1 to 12. Task 13 (deploy) is left for David AI and Ivan.
- Plan 1b (company certificate): Tasks 1 to 7.
- Plan 2 (keeper and front): Tasks 1, 2, 3, 4, 8, 9, 10. Task 11's rehearsal and push were skipped.
- Plan 3: Task 3's sql-check part. Plan 4: Task 5.

Merged here on 2026-11-10, NOT reviewed to the end:
- `batch-8` (fast-forward, 14 commits): plan 2 Tasks 5 to 7 (keeper, link certificate, public link through
  the keeper), plan 1b Tasks 8 and 9, the late-stop fix of QUESTIONS item 16, two flaky-test fixes. Its review
  had begun: Antigravity 0 Critical, 3 Important (`build/runs/batch8-keeper-agy.md`). No Claude read, no fix round.
- `task-b9fix` (c71c3392): batch 9 (plan 3 Tasks 1, 2 and the lease part of 4: Postgres 17.11 real tests,
  journal under a lease, migration snapshot, lease step) plus its fix round. Readers done
  (`build/runs/batch9-merged.md`). Last check: 2480 tests passed; red only on dryer, a duplicate in
  `apps/server/src/db/client.ts` lines 73-76 and 91-94.
- `task-p10t3` (628f3864): plan 10 Task 3, the decision of lease, takeover and way back. Last check: 300 tests
  passed; red only on dryer, a duplicate in `apps/server/src/modules/keeper/beats.ts` lines 40-48.
- `task-p3t3` (6f46026d): the rest of plan 3 Task 3 (SQL parsing, 5 s transaction end, commit confirmation).
  Author check OK at 228fd988.
- `task-ptables` (c121d776): plan 9c Task 3, plan 9 Task 7's sync-step part, plan 9c Task 9's update-steps
  part, as pure decision tables. Handed in, not reviewed.
- `task-p5t5` (11f3c3cd): plan 5 Task 2 (company certificate authority), Task 4's keys part, and Task 5
  UNFINISHED. Commit 90f3d30c holds four files its writer never committed (`apps/server/src/net/peer-server.ts`,
  `peer-door.ts`, `apps/server/src/modules/network/via.ts`, `apps/server/test/peer-server.test.ts`): a red test
  and part of the code. Treat Task 5 as not done.
- `task-p8t4` (9113bfb4): plan 8 Tasks 2 and 4 (merge rule per table, merge plan). Handed in, not reviewed.
- 5b1ddaf1: an `ours` merge that keeps the history of 18 lanes whose work is already here in rewritten
  versions under the same titles (checked by title and patch id). It takes no files.

Merge conflicts resolved on 2026-11-10, both sides kept in each:
- `apps/server/test/compose.test.ts`: imports of batch 8 and of batch 9's real-test checks.
- `apps/server/src/db/client.ts`: imports of `confirm.js`, `FENCED` and `JOURNAL_NEEDS_PUTTING_BACK`.
- `apps/server/test/journal.test.ts`: batch 9's version of the same-transaction assertion, and both new
  describe blocks ("the journal taken off for a migration", "a write when the lease has ended").

The relay, `network-handoff/hornhoof-edge/` (its own history, subtree-merged):
- main 4b1122a = Plan 1 complete. batch-10 4a5af9c adds 5 commits (owner chooses the new key, operator add
  waits for the old tunnel, retired key text, monthly bytes, large upload test: plan 1 A1, plan 7 A1, plan 9c
  Task 12). Readers done: Claude 0 Critical, 0 Important, 8 Minor; Antigravity 0 Critical, 1 Important
  (`build/runs/batch10-merged.md`).
- 5817e5c is batch 10's fix round, committed 11:50 UTC. Its author check was red: 1 of 129 tests failed.

Not started, as far as the ledger shows (check it against `queue.md`): plans 5b, 6, 7 (except A1), 9 (except
the sync-step part), 9b, 9c (except the parts above), 10 (except Task 3), 11, 11b, 13; plan 3 Tasks 5 and 6;
plan 4 except Task 5 and Task 4's protocol part; plan 1b Task 10.

## First steps for the new lead

1. Run the whole suite on `network` as it is. The merges above were never run together. Then finish batch 8's
   review (a Claude read and a fix round), batch 9's two dryer duplicates, p10t3's duplicate, batch 10's
   failing relay test, and the review of ptables, p8t4 and p5t5.
2. The big one: `network` is based on main 73d086ba (2026-11-04). Main is now 0.18.0 (4568a8a5), 2225 commits
   ahead; 73 files changed on both sides. Migrations clash: network adds 0053 to 0057, main already has
   0053 to 0082 and more. The network work has to move onto current main, migrations renumbered. Each plan
   was written against main 04bec1d, so each plan starts with a conflict scan against today's code (the
   skill's table in the ledger).
3. The relay goes into its own repository when Ivan says so:
   `git subtree split --prefix=network-handoff/hornhoof-edge` gives its history back.
4. Before any relay deploy: `QUESTIONS.md` items 12, 15 and 17 (setup-relay.sh is incomplete; do not run it
   on the droplet as it stands).

## Rules that bind this work today

- Commits as Ivan Korol (invariant0x@icloud.com), with no Co-Authored-By or other Claude lines.
- Repository text in English, no em dashes. The UI in English and Russian.
- The relay never terminates TLS for company names; it routes by SNI only.
- Never print a secret value. The test machine's key stays in `~/hornhoof-network/.ssh` on a-host and was
  not copied here.
- The folder `network-handoff/` is working material and the relay, not product code: it never goes to main.
