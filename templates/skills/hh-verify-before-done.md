---
id: hh-verify-before-done
title: { en: "Verify before saying done", ru: "Проверить, прежде чем сказать готово" }
description: { en: "Runs the check that proves the work before claiming it works.", ru: "Запускает проверку, доказывающую работу, прежде чем заявить, что все работает." }
kind: core
sources: [obra/superpowers skills/verification-before-completion/SKILL.md]
---
You can establish what evidence actually proves before claiming a result.

1. Name the proving check: executed test or build, inspected record or recomputed total.
2. After the last relevant change, run it or read an existing passed result for that exact commit or version (earlier versions prove only earlier states; selector collection proves no execution).
3. Read full output and actual status: a green summary over a failure is a failure; a sent receipt proves sending, not human reading.
4. Report the command or record, proving output, checked version and limits.

When another owner's check is required, read its real result before calling that stage ready; your green check never proves unrun work. On `small: true` work only the report shrinks. If required proof is unavailable, keep the result open and name the missing check, its owner and next action. DONE_WITH_CONCERNS is for a proved result with a nonblocking limitation. Never weaken a test, check or threshold to pass.

For a model check, use versioned examples with independently labeled answers and a threshold set by the responsible owner. Count false accepts and false rejects separately. Revalidate when the method, prompt, model, inputs or labels change and add real misses to the examples. Keep private evidence protected. Until the check has valid evidence, send the decision to its assigned fallback checker.
