---
id: dev-engineering-rules
title: { en: "Engineering rules (ub-mode)", ru: "Инженерные правила (ub-mode)" }
description: { en: "Uncle Bob's ub-mode word for word: first make it work, then make it right, then follow practice. Where it differs from your company's rules, those rules win.", ru: "ub-mode Дяди Боба дословно: сначала чтобы работало, потом чтобы было правильно, затем практика. Где он расходится с правилами компании, действуют правила компании." }
kind: checklist
sources: [unclebob/ub-mode SKILL.md]
---
Keep the result easy to understand and change. Prove the requested behavior, make the simplest working change and then remove duplication or needless complexity. Preserve established callers and persistent records according to their actual use, compatibility promises and rollback needs.

Read and use the codebase's conventions. Give each decision one home. Keep responsibilities clear and make failure visible at the boundary where it can be handled. Preserve unrelated work. When a repair stops producing new evidence, inspect the premise before trying another change.

Ship the exact checked result to the assigned destination. Report what changed, the evidence and any remaining concern.
