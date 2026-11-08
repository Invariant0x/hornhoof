---
id: dev-gates
title: { en: "Choose development checks", ru: "Выбирать проверки разработки" }
description: { en: "Chooses checks from the assignment, task and risk, preserving independent approval before protected integration.", ru: "Выбирает проверки по назначению, задаче и риску, сохраняя независимое одобрение перед слиянием защищенных изменений." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md, affaan-m/ECC skills/council-multi-model/SKILL.md, affaan-m/ECC skills/santa-method/SKILL.md]
---
You can choose and enforce a development check route for an assigned change.

Read the employee's assignment, task acceptance, declared risk and actual gates. Skill selection supplies abilities, not a mandatory pipeline. A standalone named order may be completed by its assigned owner; shared review, testing and release stages exist only when the task assigns them. A turn is a sprint, with order and conditions rather than fixed units of time.

## Security before integration

Any change affecting access, root, permissions or secrets must pass review by an independent Security engineer before it reaches any shared branch, including the turn's branch. This applies to urgent work, small tasks, direct named orders and review fixes. Self-review does not replace this gate. This protected condition takes precedence over small/fast paths, tasks without gates and a no-second-review convention. If the required independent reviewer is unavailable, keep the branch separate and report the missing approval.

## Development

When `task.echelons` is present, use its persisted route, owner and candidate rather than legacy gate numbers. The route is Architecture, Development, Review, Security when required, then Tests. Small tasks skip Architecture. Review is always required. The head includes Security for risk to access, secrets, personal data or external input; Review may add Security when it discovers that risk. Coordination and non-code deliverables stay outside this code route. A newly created Development department receives the default; existing departments and tasks retain their recorded route. A skill selection never activates it.

The current stage owner is the sole writer during Review or Security repairs. Record findings against the input candidate, repair within the assigned paths, verify the resulting candidate and hand it forward. Ordinary findings never return to the original author. A wrong goal goes to the head with the stage, candidate and evidence preserved. Independent tasks can overlap at Development and Review when their files and dependencies permit it.

Use different models and explicit stronger edges from the recorded model policy. Claude reviews Codex; Codex never reviews Claude. Pin canonical model identities and the actual candidate producer, including a Review or Security fixer. A deeper roster tier or higher effort does not prove an edge. An unknown model, unresolved alias or missing eligible checker leaves the task waiting for the head; never use a same-model or silent provider fallback. Different vendors are not an additional requirement when a different-model edge is explicitly approved.

Use unique source findings and their independent confirmations for Review and Security metrics as evidence for the head; never automatically remove required Security from risky work or invent a numerical disable threshold. Tests consumes the final candidate including every repair. Select changed code and tests, reuse only matching verified fingerprints, and mutate only changed pure functions with nonempty fast tests, excluding database, process, network and unknown effects. A content failure goes to the head; an infrastructure failure waits or retries at Tests. Tests does not edit the candidate or return it to its author.

For a legacy task with no echelon route, follow the task's existing checks and the scope below.

Keep a connected block with one owner and resolve shared-file collisions. A design step is needed only when the assignment or missing architecture requires it. For small work preserve context, state the change and its check briefly, and omit unnecessary process. The owner may choose a visual check for a simple visual change; required approvals remain.

## Review

When an independent review is assigned, the author cannot pass it. Read the exact comparison and existing author evidence, use the assigned scope and report all blocking findings together. Check code, tests and obvious security problems; sensitive access/sign-in/secrets/permissions and data risks require the independent expertise the task and protected condition demand. Prefer another provider where available and report degraded independence honestly. A scoped return checks its original findings and new breakage, not unrelated unchanged work.

## Testing

When broader validation is assigned, one owner freezes the exact candidate and coordinates required suites, types/build/language checks, user-facing surfaces and quality measurements. Use run_tests on compatible free machines and read every part's actual SHA and full log. Reuse a proved result only for the same candidate/fingerprint; after fixes rerun what failed and what changed, rather than starting duplicate full runs. A missing or refused stage is NOT_RUN, never PASS.

## Release

Release requires actual passed required checks, release notes, a tested rollback and the authorized human's approval of the exact commit. Publication and live updates use the project's approved route. Merely having an ability never authorizes an action on another person's machine or a public release.
