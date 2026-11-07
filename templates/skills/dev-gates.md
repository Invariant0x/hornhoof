---
id: dev-gates
title: { en: "The path of a turn", ru: "Путь хода" }
description: { en: "Moves each turn through four gates in order: development, review, testing and release. Review and testing run once per turn.", ru: "Проводит каждый ход через четыре ворот по порядку: разработка, ревью, тестирование и выпуск. Ревью и тестирование идут один раз за ход." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md, affaan-m/ECC skills/council-multi-model/SKILL.md, affaan-m/ECC skills/santa-method/SKILL.md]
---
A turn is a sprint. It passes four gates in order, and each opens when the one before it is done. Rules here name order and conditions, never units of time. Who runs which check is in dev-testing-policy.

## Development

- **Design for a large block.** Architects of different models each propose a solution on their own and write no code; the head, as arbiter, picks one or merges them into one design note, which the block waits on.
- **One owner for a connected block.** It goes whole to one developer, with no chains or `after` between developers. Two developers work on separate features, never on the same task.
- **Work goes out without gates**, under the department's task of the turn. A developer writes the code and a failing test, runs the affected tests, submits, and merges the branch into the turn's branch as soon as it hands the work in. An author's own review, where the role has one, comes before this and replaces no later gate.
- **Small tasks** (`small: true`) go to whoever already holds their context, until the testing gate starts; after that they wait for the next turn.

## Review

One review per turn, on what the turn changed. When the department's last work of the turn is in, Hornhoof opens the review of the turn: of each gate role one reviewer of each provider, the least busy, checks everything the turn changed on its branch at the same time, and each runs its program's own review. Reviewers verify the author's affected-test evidence without rerunning its checks.

- **Who reviews.** Code review checks the code, the tests and obvious security problems. Security, when it is on, checks what touches access, sign-in, secrets or permissions. Red team, when on, checks the changed logic and flows. Security and red team join for declared money/access/security/data risk, sensitive changed paths, risky added diff or explicit pre-release mode, which a head requests with `Review mode: pre-release` in a covered task body header. A missing or incomplete trusted comparison wakes both. Harmless UI/text outside these triggers does not wake either.
- **Never the author.** Whoever made a piece of work does not pass its gate.
- **Other providers check.** Reviewers run on other providers than the developer when you have them. With only one provider, use a fresh session on another tier and say "cross-check degraded" in your status.
- **The verdicts come to the head in one list**, what blocks first. The head gives each blocking finding as a fix task without gates to the member whose change it is, all at once. Each fix starts with a test that fails and then passes; there is no second review. A note that does not block goes into those tasks only when it is cheap.
- **A gate on one task** only where a change must not reach the turn's branch unchecked, such as a migration that rewrites existing data. Research, reports, plans, docs and the architect's design note never get one; the head reads them when they come back. At such a gate **a second round checks only the fixes**, by the reviewers who sent it back, each for its own findings; one that passed is not asked again.

## Testing

Once per turn, with the turn's branch frozen: nothing enters it now but the fixes this gate returns. The head assigns a test engineer or QA to run the final check once per turn on the final pinned commit, as T3 in dev-testing-policy lists it. Coordinate ownership so each check runs once, through run_tests on a compatible free machine, in parts when its runner can split. After fixes run only what failed and the tests around it; do not repeat the whole suite for each fix. Where the manifest declares a full run, `run_tests` without a command on the final profile and the turn's branch is this check and does the choosing itself: it runs the groups in parallel on free machines, a test file proved green on the main branch or the turn's at the same fingerprint does not run again, and on the turns the manifest names everything runs. Read its result for failed files and for any mismatch with the kept results; a mismatch is a finding. Acceptance and QA run once per turn, on the turn's branch, against these results.

## Release

The CEO's word on the exact commit; nothing else reaches the main line. The update then reaches machines one at a time.

## Beside the gates

Improvement lanes run in the background and hold nobody. Performance and the released-version red team inspect released work and open ordinary next-turn tasks with measurements that become tests, never task or turn gates.
