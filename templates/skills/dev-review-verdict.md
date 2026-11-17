---
id: dev-review-verdict
title: { en: "Review verdict", ru: "Вердикт ревью" }
description: { en: "Records exact-candidate findings and keeps repairs with the current checking owner.", ru: "Фиксирует находки точного кандидата и оставляет исправления текущему владельцу проверки." }
kind: gate
sources: [obra/superpowers skills/requesting-code-review/code-reviewer.md]
---
You can record findings, repair them as the current checker and hand an exact candidate forward.

Read task.echelons, the brief, candidate, allowed paths and actual evidence first. Review is required for every executable result. It checks correctness, simplicity and basic security; Security checks deeper access and data risks. Only the current checking owner may act. Check another employee's input with a model not weaker than its producer. Prefer another provider when available; the same provider, subscription or tariff is allowed without waiting for a second provider. Role names grant no ownership or permission.

On a first look, inspect the assigned candidate and common contracts at the role's or card's base level. Reuse applicable completed author evidence. After your repair, inspect only the fixes and the paths they affect; skip your program's own review and never reread the whole patch solely because a finding was repaired. The candidate, its immutable parent, producing agent, model and subscription retain who wrote each change. Your repair is authorship, not another independent review of your own fix.

End a checking decision with "verdict", the exact 40-character reviewedCommit and structured issues ({ taskId?, category: 'security' | 'data' | 'spec' | 'other' | 'mechanical', blocking, path, line, harm }).

- A failing check, unmet requirement, security hole or data loss is blocking. Record every confirmed blocking defect together with file, line, what breaks and harm to a person. A failed verdict keeps ownership with you. Reproduce each defect with a failing test, fix it within the assigned paths and run affected checks by the assignment's route. Submit the corrected candidate in the same branch with actual base/fix SHAs, parent and evidence. Ordinary defects never return to the original author.
- Pass only the exact current candidate with no unresolved blocking findings and actual applicable proof. Nonblocking suggestions are notes under the pass. Missing required browser evidence remains explicitly unproved. Low coverage alone is not a finding; request additional tests only for a named harm to a person.
- If the work pursues the wrong goal, use escalate with the evidence. The head decides the goal or scope; do not return the work to its original author or expand your paths yourself.
- Review can add Security with the concrete access, secret, personal-data or external-input risk. Only the head enables optional Cleanup after Review; it is absent by default. A required checker without an eligible owner waits for the head rather than skipping the stage.

Reserve mechanical for fixes that provably cannot change behaviour, such as formatting or lint cleanups, a safe local rename, or restoring a missing translation key under that boundary. Public API renames or changes in semantics are not mechanical. When in doubt, keep a regular category and the full base level; never classify security, data, spec or behavioural findings as mechanical to run at medium. A verdict does not set effort or change effort inside a running turn. It never opens another review or sends a mechanical fix back to the author.

The server records findingId, candidateId, revision, stage, authorId, reviewerId, reviewerVendor and reviewedCommit. The same issue is not counted twice across stages. Provider usefulness counts independently confirmed findings through "confirm_finding" with task, findingId, revision, confirmed, reason and an actual fixCommit when claiming a producer fix. A checker cannot confirm its own finding. Confirmation does not mark a blocking finding fixed or APPROVE; preserve both provenance and repair evidence.

Read the author's description of the local checks they ran, requirement -> test links, screenshots and verification before done evidence, and rerun what you doubt in your own workspace. Your own named-file or selector run there proves that commit. A receipt for another candidate proves nothing about this one. Give a comment explaining the decision. Even authors of internal role or skill rules never take or grant main or release approval; only the authorized human owns approval of the exact commit.
