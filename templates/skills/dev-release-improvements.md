---
id: dev-release-improvements
title: { en: "Release improvement lanes", ru: "Линии улучшений выпуска" }
description: { en: "Use for each release measurement or for independent improvement work on a released version.", ru: "Применять при замере каждого выпуска и самостоятельных улучшениях выпущенной версии." }
kind: procedure
sources: []
---
Improvement lanes produce ordinary tasks for the next turn. Performance, released-version red team, deliverability and knowledge work are nonblocking: no task gate, no turn gate and no release veto from unfinished lane work. A confirmed defect is reported to the head for triage through the normal task flow.

| Mode | Owner | Result |
| --- | --- | --- |
| Each release | Performance engineer | A reproducible snapshot, comparison and next-turn task |
| Released version in a named isolated environment | Red team | Semantic test proposals and ordinary regression-test tasks |
| Risk/path/diff or explicit pre-release review | Security and red team gates | Verdict on the candidate under review |

For each release, pin its commit and record the environment and sample count. Use the project's own cheap benchmark to measure cold startup/readiness, key requests on a test database and memory (RSS and heap where available). Compare against the previous release under the same conditions, with an explicit relative regression threshold. Keep missing or incomparable metrics unknown; never report them as zero or claim an improvement without a comparable after measurement.

Read `pipeline_report` for the closed baseline turn 7 and current turn. Select the largest measured wait that delays acceptance, distinguishing aggregate overlapping waits from the critical path. Track issue-to-acceptance, not merely first submission. The first goal is at least 30% shorter issue-to-acceptance than turn 7; express targets only in percentages of that baseline, without fixed-minute goals. If acceptance data is absent, name it unknown and obtain the snapshot through the head. Do not replace it with a first-submission number.

Track test speed (T7): rank the slowest files and run parts, preserve setup/test/teardown costs, package medians and the scope of the sample. Read structured test timing lines when available. Distinguish summed file time from part wall time. Include reviewer usefulness by provider: confirmed findings, actionable fixes, review time and fix rounds; an unavailable source stays unknown.

Give the head one ordinary next-turn task per chosen improvement in this shape:

- Before: source snapshot, turn/commit, metric, sample/scope and measured number (100% of baseline).
- Target after: required reduction in percent and remaining percent of turn 7; for the first acceptance goal, at least 30% reduction and at most 70% remaining.
- Change: address the largest wait/cost with an owner and bounded scope.
- Proof: repeat the same measurement and dataset before and after; make the measurement a regression test. State any missing baseline or after value explicitly.

For the red-team lane, use a head-named isolated environment running the released version and synthetic data. Pilot model-generated semantic test variations, inspired by ACH-style work, on access decisions, company isolation and outbound policy. Derive expected decisions from the approved requirements; vary fixtures and assertions around those decisions. No live targets or customers are involved. A surviving variation becomes an ordinary test task for the responsible author, with the missing assertion and expected behavior. It does not become a blocking release mutation gate. Release mutation review retains its separate scope: pure logic and its fast unit tests only. Do not run broad or integration-heavy mutation workloads from this lane.

A harmless UI/text edit outside sensitive paths with no declared risk does not call security/red-team gates merely because it is public-facing. A head requests pre-release mode with `Review mode: pre-release` in a covered task body header. Gates use declared risk, changed paths, added risky code or an explicit pre-release mode; inability to read a complete trusted diff requires both security and red-team review. The improvement lane remains separate even when the same role also serves as a gate.
