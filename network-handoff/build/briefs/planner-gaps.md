# Planner's brief: the plans' open gaps

You are the planner on the team building Hornhoof's network phase 1. The coverage audit is in
`/home/altera/hornhoof-network/network-build/runs/plan-audit.md`: read all of it. The lead's rulings on it are the last
lines of `/home/altera/hornhoof-network/network-build/progress.md`. Spec, the binding authority:
`/home/altera/hornhoof-network/specs/2026-11-02-single-network-design.md`. Overview and plans: `/home/altera/hornhoof-network/plans/`.
Code as it stands: `/home/altera/hornhoof-network/hornhoof` (branch network, read only for you) and `/home/altera/hornhoof-network/hornhoof-edge`.

Rules: read `/home/altera/hornhoof-network/CLAUDE.md` and `/home/altera/hornhoof-network/network-build/briefs/build-rulings.md`.
English; plain sentences; no em dashes; in Russian UI strings "е" not "ё", "машина" and "нода", never "компьютер" or "узел". Change no code. Run no tests. Do not dispatch subagents.
Never write Ivan's email address or any private fact into a plan. Do not run git log with author output.

## What to write

1. **Plan 13, a new file** `plans/2026-11-03-network-phase-1-plan-13-lab-and-real.md`, in the form of the other plans: take
   `plans/2026-11-03-network-phase-1-plan-11b-the-work.md` as the model for its top (Goal, Architecture, Spec, Global
   Constraints, Rulings, Review Focus) and its tasks (Repo, Starts from, Done when, Files, Interfaces, steps with test names
   and expected failures, exact values). Scope: overview's plan 13, spec section 12's lab and real bullets, and the audit's
   section 4, including what other plans parked there. Tasks fall in two kinds and each says which on its first line:
   - **Runs in this build** (no Docker, no root, no real machine): above all the guide pages. Read `hornhoof/guide/` (or
     wherever the app's guide lives) and which plans change what people see (5b, 6, 9, 9b, 9c, 10, 11, 11b touch no guide
     page); give each page its own exact content outline in the app's plain, simple voice, with its Russian strings. Also a
     check that `SECURITY.md` and the README say what the series ships.
   - **Written here, run elsewhere** (needs Docker, root tools, the droplet or Ivan's machines): the lab's missing scenarios,
     5 machines, `tc netem`, joins from 2 to 5 and back, and the rest of the lab bullet; the real run with its timings and
     screenshots; series-end steps (one rehearsal, one merge, Updates, relay deploy before the rehearsal). These say who runs
     them: David AI or Ivan, never this build's writers.
2. **Addenda, at the end of the plan that owns each.** Do not rewrite a plan's existing text. Each addendum is a short
   section like plan 1's `## Addendum: R6.1 takes the new key it is given`, with a full Task of the plans' form, or a clear
   sentence that no task is needed and why:
   - Plan credentials sealed to machine keys. Overview discrepancy 1 and plan 5's scope promise it, spec 3.8 "Keys" and
     section 10 rest on it, p5 ruling 4 kept node keys and p7 made the machine's age key, and no plan reseals. Read those,
     and how `plan_credentials` works in the code, and work out what a person gets today and what breaks without the reseal
     (a stolen machine, a backup restored, a node added). Then give it an owner and a task in the right plan, or argue from
     the spec why node keys meet its promise, for the lead to rule on.
   - p2:148 "Plan 3 drains those changes": settle whether plan 3's rulings 8 and 9 cover it, and add a task if not.
   - p7:282-285 (ruling 17e): who lifts a body limit if the check fails.
   - p5b:214-218: a Mac's changed address and copies "telling it".
   - p10's relay outage row at 120 s (spec 90 s, overview "75 s to 2 minutes"): whether a row is missing.
3. **The overview**: add one short section "The real order" with the audit's list, and an entry for each of 5b, 9b, 9c, 11b:
   scope, depends on, owner sees, risk, as its other entries. Change nothing else in it.

## How to work

Find facts in the spec, plans and code, and cite them (`file:line`), as the plans do. When the spec and code disagree, the
spec binds, and you say so. Where you decide something, write it in the plan's Rulings with why and what it costs if wrong.
Check every Russian string for "ё". Plans are the writers' only brief, so exact values, test names and expected failures
matter more than prose. Keep each addendum and each task as small as the promise allows; no feature the spec does not ask for.

Write what you changed, each decision, and anything you could not settle to
`/home/altera/hornhoof-network/network-build/runs/planner-gaps-report.md`. Reply to the lead with at most eight lines.
