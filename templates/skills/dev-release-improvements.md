---
id: dev-release-improvements
title: { en: "Release improvement lanes", ru: "Линии улучшений выпуска" }
description: { en: "For each release measurement or independent improvement work on a released version.", ru: "Для замера каждого выпуска и самостоятельных улучшений выпущенной версии." }
kind: procedure
sources: []
---
You can identify improvements in released software without expanding current work.

When an improvement lane is assigned, it produces proposals without holding unrelated work; its owner and schedule come from that assignment. Performance, released-version red team, deliverability and knowledge work are nonblocking: no task gate, no turn gate and no release veto from unfinished lane work. A confirmed defect is reported to the head for triage through the normal task flow. A lane stays separate even when the same role also serves as a gate.

| Mode | Owner | Result |
| --- | --- | --- |
| An assigned release measurement | Assigned measurement owner | A reproducible snapshot, comparison and next-turn task |
| Released version in an authorized isolated environment | Assigned adversarial checker | Semantic test proposals and ordinary regression-test tasks |
| Risk/path/diff or explicit pre-release review | Assigned independent reviewers | Verdict on the candidate under review |

For the assigned release measurement, pin its commit and record the environment and sample count. Use the project's own cheap benchmark to measure cold startup/readiness, key requests on a test database and memory (RSS and heap where available). Compare against the previous release under the same conditions, with an explicit relative regression threshold. Keep missing or incomparable metrics unknown; never report them as zero or claim an improvement without a comparable after measurement.

Use only an authorized isolated measurement or a recorded baseline supplied by the owner. Do not run an expensive operation against production merely because a measurement ability is enabled. Distinguish aggregate overlapping waits from the critical path and issue-to-acceptance from first submission. Agree a relative target with the task owner and keep unavailable baseline/after values unknown.

Compare test timings under comparable conditions. Preserve the scope, setup, test and teardown costs and distinguish summed time from elapsed time. Identify regressions against the agreed baseline and impact. Record reviewer usefulness by confirmed findings, actionable fixes and check time. Leave unmeasured values unknown.

Propose one bounded follow-up per accepted improvement to the task owner in this shape:

- Before: source snapshot, turn/commit, metric, sample/scope and measured number (100% of baseline).
- Target after: required reduction in percent and remaining percent of the baseline.
- Change: address the largest wait/cost with an owner and bounded scope.
- Proof: repeat the same measurement and dataset before and after; make the measurement a regression test. State any missing baseline or after value explicitly.

For the red-team lane, use a head-named isolated environment running the released version and synthetic data. Pilot model-generated semantic test variations, inspired by ACH-style work, on access decisions, company isolation and outbound policy where the product has them. Derive expected decisions from the approved requirements; vary fixtures and assertions around those decisions. No live targets or customers are involved. A surviving variation becomes an ordinary test task for the responsible author, with the missing assertion and expected behavior. It never becomes a blocking gate, and this lane runs no mutation workloads of its own.
