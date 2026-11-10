# Plan coverage audit (reading only)

Date 2026-11-04. Sources: spec `specs/2026-11-02-single-network-design.md`, overview `plans/2026-11-03-network-phase-1-overview.md`
(written "ov:") and the 16 plan files (written "p<N>:<line>"). I read each plan's top, task headings, Done when lines and
the rulings, and grepped for carry-overs. I did not read the plans end to end. Where I only grepped, the entry says so.
No code was run, no plan edited.

Severity: Blocks (a later plan cannot be built without it), Gap (promised behavior has no task), Note.
Counts: Blocks 1, Gap 4, Note 11.

## 1. Real order

One list, from each plan's own first-task "Starts from" line:

| # | Plan | Starts from (plan's own line) | Overview "Depends on" |
|---|------|-------------------------------|------------------------|
| 1 | 1 relay contract | nothing (p1:187) | nothing (ov:57) |
| 2 | 1b company certificate | main with plan 1 merged (p1b:211) | 1, deployed (ov:79) |
| 3 | 2 keeper and front | main with plan 1b merged (p2:208) | 1 and 1b (ov:97) |
| 4 | 3 fences and journal | main with plan 2 merged (p3:226) | 2 (ov:113) |
| 5 | 4 work survives restart | main with plan 3 merged (p4:241) | 2 and 3 (ov:127) |
| 6 | 5 authority and peer link | main with plan 4 merged (p5:223) | 1 to 4 (ov:144) |
| 7 | 5b machines join | main with plan 5 merged (p5b:325) | no entry |
| 8 | 6 computer access | main with plan 5b merged (p6:257) | 5 (ov:155) |
| 9 | 7 backups | main with plan 6 merged (p7:334) | 3 and 5 (ov:167) |
| 10 | 8 merge | plan 7's last task, in `network` worktree (p8:399) | 3, 5 and 7 (ov:180) |
| 11 | 9 copies | plan 8's last task (p9:448) | 1 to 5 and 8 (ov:211) |
| 12 | 9b server order | plan 9's last task (p9b:303) | no entry |
| 13 | 9c planned switch | plan 9b's last task (p9c:376) | no entry |
| 14 | 10 takeover | plan 9c's last task (p10:360) | 1 to 9 (ov:247) |
| 15 | 11 splits | plan 10's last task (p11:312) | 10 and 8 (ov:266) |
| 16 | 11b the work | plan 11's last task (p11b:220) | no entry |
| 17 | 13 lab and real tests | no file | 1 to 11 (ov:285) |

Where they disagree:
- The chain is strictly linear in the plans (each starts from the one before). The overview lists wider dependencies
  (plan 7 on 3 and 5, plan 8 on 3, 5 and 7); the linear order satisfies all of them, so only a Note.
- Merge model. ov:11-13 says the series is on one `network` branch and "no plan merges alone". Plans 1 to 7 each use
  their own branch, start from "main with plan N merged" and end with Merge, `git push origin main`, Ivan's Update and
  closing the worktree (for example p7:1536-1582, p2 Task 11). Only plans 8 and later use the `network` branch and say
  "none of it is shipped" (p8:~40). See B1.
- Plan 13 depends on 1 to 11 (ov:285); the real set also holds 5b, 9b, 9c and 11b.
- ov:36-37 says plan 5 brings the Docker-in-Docker lab machines; it is plan 5b Task 9 (p5b:237, 1352).
- Plan 11 (p11:145) says "its entry [plan 11b] goes into the overview"; it is not there. Same for 5b, 9b, 9c.

## 2. Coverage gaps (scope promised, no task)

Checked per plan against its overview Scope line and the spec section it names. Most scope items map to a task; the
ones that do not:

| Sev | Plan or place | Gap | Promised at |
|-----|---------------|-----|-------------|
| Gap | Plan 13 (no file) | Everything plan 13 owns has no task; see section 4. Also series-end work that other plans park there: the rehearsal, merge into main, Ivan's Updates and worktree close "done once, for the whole series, at its end" (p9c:1652-1659, and plans 8 to 11b end without shipping), plus the relay deploy of addenda A1 and A2 (p1:1023-1031, p9c:1637-1638). | ov:276-287 |
| Gap | Lab (plans 5b, 9) | Joins "from 2 to 5 and back", a fifth machine and `tc netem` are promised to plan 9 ("Network cuts, `tc netem` and five machines come with plan 9", p5b:240). Plan 9 Task 12 (p9:1830-1884) runs 3 machines and no netem; plan 11 Task 9 uses 4 (p11:1159). `netem` appears in no plan but 5b. grep over all plans. | spec 12 lab bullet; ov:276-283 |
| Gap | Guide pages | Plans 5b, 6, 9, 9b, 9c, 10, 11, 11b change what people see or do and none touches `guide/` (grep count 0 each). Only plans 1b, 2, 7, 8 do. Overview gives "the guide pages" to plan 13, which has no file. | ov:285 |
| Gap | Plan 5, scope "plan credentials re-sealed to machine keys" | p5 ruling 4 (p5:117-120) keeps node keys and says plan 7 makes the machine age key. Plan 7 makes the age key (p7:128-131) but no plan reseals plan credentials to machine keys. Spec 3.8 "Keys" (spec:708) and section 10 (spec:1085) still say they are. Ruling exists; no later owner and no ledger line seen. | ov:140, discrepancy 1 (ov:293-300) |
| Note | Overview line "other texts written ahead of the code are owned by plans 5, 7, 9, 10, 11, 12" (ov:~600) | Plan 12 was removed; `SECURITY.md` appears only in plans 1, 1b, 2, 7. I could not read `notes/ops/going-public.md` (not on this machine), so I do not know which lines belonged to plans 5, 9, 10, 11 or 12. Not checked. | ov discrepancy 15 |
| Note | Spec 12 / ov:228 | The relay-outage case: spec says 90 s, overview says "75 s to 2 minutes". Plan 10's table has rows for 60, 75 and 90 s (p10:675-677) and none for 120 s. Small. | spec:1125, ov:228 |

Items I checked and found covered (so the lead does not redo them): R1 to R7 in plan 1 Tasks 2 to 10; plan 1b cookie,
limits, robots, 14-day warning, test:real and Pebble (Tasks 1 to 9); plan 2 keeper, front, ports, maintenance (Tasks 1 to
10); plan 3 fences, lint, `libpg-query` parser (ruling 3, a deviation from "pgsql-parser"), PUBLIC revokes; plan 4 node
numbering, 60 s hold, tool calls; plan 5 CRL, `x-hornhoof-via`; plan 5b online share, expired-certificate renewal, "Open
here", "Make Mac a full machine"; plan 7 6-hour bundles, latest two, "Keep company backups"; plan 8 savepoints, merge
task, picks, fork bundles; plans 9 to 11b their Scope lines. Priority-row details of ov:204-207 map to p9b Task 7 and p9
Task 11 (p9:1804 has "Only <leader> holds changes since").

## 3. Carry-overs (item handed to a later plan)

Method: grepped every mention of a later plan inside each plan (114 lines), then checked the named target. Listing only
the dropped ones and the stale texts. The rest resolve (examples: p1 addendum A1 to p9 Task 3 `changeKey(next)`; p3
ruling 6 and 5 ruling 13 to p9 and p10 link frpc stop (p10:96, 754); p3 `invocation` to p4 Task 3; p4 ruling 9 to p9c Task
2; p5b link-key change to p9 ruling 20; p7 recipients, recovery pair and "Debian leads" to p9:275, 387-388; p8 MergeSource
over the data link to p9 Task 9; p8 parked results to p10 Task 8; p9 "Copy: stopped"/`led` to p10 Task 7; p9c ruling 12
three items to p10 Tasks 6, 7, 10 (p10:157-160); p10 disk figure to p11 Task 2; p11 to p11b Tasks 1 to 7).

| Sev | From | Item | Target | Result |
|-----|------|------|--------|--------|
| Gap | p5b:240 | `tc netem` and five machines in the lab | plan 9 | dropped (see section 2) |
| Note | p5b:214-218 | "A Mac address that changes after that is plan 9's"; copies "tell it" | plan 9 | no task found by grep (only the db-door allow list, p9:206) |
| Note | p7:282-285 (ruling 17e) | check Caddy and relay settings for a body limit or timeout below a bundle's size; "stops the merge until a plan lifts it" | plan 7 Task 11 review, then "a plan" | no plan owns the lift if the check fails |
| Note | p2:148 | "Plan 3 ... drains those changes" (in-flight writes when the app leaves `lead`) | plan 3 | no task or ruling uses the word; p3 rulings 8 and 9 (fence at once, `read`) may cover it. Not settled. |
| Note | p4:178-180 | "plan 5 splits the identity and makes `jobsOf` ... per machine" | plan 5 | stale. p5 ruling 13 moved it to plan 9; p9c Task 2 and p9c:143 own it. Fix the p4 text, no work lost. |
| Note | p3:137-138 | "Plan 5 ... stops [the `alone` flag]" | plan 5 | stale for the same reason; plan 9 does it (p9:~364 "lease ... with sync alone while another data machine is listed"). |
| Note | p9b:116-120, 132-137 | round trip from heartbeats (plan 10) and the internet check (plan 11) may feed the same medians | plans 10, 11 | optional wording only; plans 10 and 11 do not mention it. Behavior still has its own sources in 9b. |
| Note | p9c Task 12 and p1 addendum A1 | relay deploy "with the series' other relay work, at its end" | no plan | lead step, no owner file (see plan 13 Gap) |

Targets that do not exist: "plan 12" (removed on purpose, ov:271-274) is named by ov discrepancy 15 only; "plan 13"
is named by many plans and has no file.

## 4. Plan 13: what it must hold, and what can run here

From ov:276-287 and spec section 12 (lab and real bullets), plus the parked series-end work found in section 2.

Must hold:
1. Lab (spec:1167-1171): 5 Docker-in-Docker machines; `tc netem`, iptables, `docker pause`, a stepped clock; joins 2 to 5
   and back; CEO reorders 3 data machines and a pin; number 1 cut off and back; leader and sync copy stopped together;
   2+3 split across homes; three homes with the relay down; a split side meeting a newer leader; writer, checker,
   overlap checker. Most scenarios exist in plans 5b, 7, 8, 9, 9b, 9c, 10, 11, 11b; missing: 2-to-5 joins, 5 machines, netem.
2. Real run on Ivan's Debian and Mac through the full installer, a third company on both; power pulled, Docker quit, lid
   closed, router unplugged, relay restarted and stopped, update during a switch; timings; screenshots of the Machines
   tab, banners and the Priority row.
3. Fixes, each with its failing test first; the guide pages (ov:285).
4. Series-end items other plans park there: one rehearsal, one merge of `network` into main, Ivan's Updates, closing the
   worktree; deploy of relay addenda A1 and A2 at night before the rehearsal; pushing `hornhoof-edge` (lead steps).
5. Texts owned by the removed plan 12 (see section 2 Note).

Can be built and run here, without Docker and without real machines (my reading, not tested):
- Writing the guide pages (item 3) and checking `SECURITY.md`/README lines against what the plans ship.
- Pure-code parts: the stepped-clock decision tables of plans 10 and 11 (already planned as unit tests in their own
  tasks) and the overlap checker's unit test (p10:1578).
- Writing the missing lab scenarios (joins to 5, netem steps) as code and type-checking them; they cannot run.
- Relay tests with real frps and Caddy binaries need no Docker (ov:28-29) but need the checksum-verified downloads of
  `network-build/briefs/plan1-task8-download-approval.md`; I did not check they are run for plan 13.
Cannot run here: everything in items 1 (execution) and 2, Postgres pairs (no Docker), `tc`/iptables (need root), and
anything touching the droplet or Ivan's machines. Very little of plan 13 is runnable on this machine.

## 5. Steps that need Docker, the droplet or Ivan's real machines

Docker = `npm run test:real` or `test:lab`, Pebble, Postgres pairs. Unit tests of install and updater use a stub
`docker` (p2 Task 1, `updater-stubs/docker`), so they do not need it. Compose files are edited as text; running them is
the step listed. Task-level detail for plan 3 Tasks 2 to 4 comes from mention counts, not a full read.

| Plan | Task | Needs |
|------|------|-------|
| 1 | 1, 8, 9 | not Docker: real frps/frpc/Caddy binaries downloaded, sha256 checked (p1 Task 1 frp.sh) |
| 1 | 13 steps 7, 8, 10 | droplet (night deploy via `$EDGE_SSH`), push of hornhoof-edge; lead only |
| 1 | A1 step 6 | droplet deploy at series end; lead only |
| 1b | 6 | Docker (Pebble) |
| 1b | 10 | Docker (`test:real`); step 4 `dig` CAA check of hornhoof.org; steps 5, 6 merge, push, Ivan's install |
| 2 | 11 | steps 4 to 7: rehearsal on a machine of Ivan's, push, Ivan presses Update |
| 3 | 1 (and 2 to 4) | Docker (real Postgres 17.11); Task 6 steps 4 to 7: rehearsal, push, Ivan |
| 4 | 1, 3 | Docker (`test:real`); Task 8 steps 4 to 7: rehearsal, push, Ivan |
| 5 | 6 | Docker (`test:real`); Task 7 steps 4 to 7: rehearsal, push, Ivan |
| 5b | 2, 5 | Docker (`test:real`) |
| 5b | 9 | Docker (`test:lab`, privileged Docker-in-Docker) |
| 5b | 10 | Docker; rehearsal with a worker, push, Ivan's Update |
| 6 | 2 | Docker (`test:real`); Task 7: rehearsal, push, Ivan |
| 7 | 4 | Docker (`test:real`) |
| 7 | 10 | Docker (`test:lab`, 4 machines) |
| 7 | 11 | Docker; rehearsal, push, Ivan's Updates and recovery-file click |
| 8 | 6, 10, 11 | Docker (`test:real`, `test:lab`) |
| 9 | 4, 6, 9 | Docker (`test:real`) |
| 9 | 8 | Docker, both architectures (amd64 and arm64 under emulation) |
| 9 | 12, 13 | Docker (`test:lab`, `docker pause`) |
| 9b | 8, 9 | Docker (`test:lab`) |
| 9c | 4, 9 | Docker (`test:real`) |
| 9c | 11, 13 | Docker (`test:lab`) |
| 9c | 12 step 6 | droplet deploy (traffic counter); lead only |
| 10 | 4, 5 | Docker (`test:real`) |
| 10 | 11, 12 | Docker (`test:lab`) |
| 11 | 9, 10 | Docker (`test:lab`, iptables inside the lab) |
| 11b | 8, 9 | Docker (`test:lab`) |
| 13 | all | Docker, root tools, droplet and Ivan's Debian and Mac (no file) |

Also for QUESTIONS.md, steps that CLAUDE.md forbids but plans contain: `git push origin main` (plans 1b to 7, last
task), "merge into main" (same), any ssh to the droplet (plan 1 Task 13), pushing `hornhoof-edge` (p1 Task 13 step 10;
CLAUDE.md says it keeps no remote), Ivan updating his companies (plans 2 to 7, last task).

## Blocks and other points the lead should settle

| Sev | What | Where |
|-----|------|-------|
| Blocks | Build chain versus the merge model. Plans 1b to 7 start from "main with plan N merged" and each ends with merge and push; CLAUDE.md allows no push and only a local branch `network` in the `hornhoof` clone; the overview says one branch, one merge at the end. Plans 1b, 2, 3, 4, 5, 5b, 6, 7 cannot start as written unless the lead rules that "merged" means the previous plan's last commit on the local `network` branch. | ov:11-13; p1b:211, p2:208, p3:226, p4:241, p5:223, p5b:325, p6:257, p7:334 |
| Note | Plan 2 needs the relay deployed before any frpc drops its heartbeat (ov:97). The deploy cannot be done from here (no droplet). Building against the fake relay is possible; shipping is not. | ov:97, p1 Task 13 |
| Note | Plan 1 builds `hornhoof-edge` at `/Users/0x/Projects/hornhoof-edge` (the Mac); here it lives at `~/hornhoof-network/hornhoof-edge`. Paths in plan 1 and 9c Task 12 differ from this machine. | p1:49, 187; p9c:1585 |
