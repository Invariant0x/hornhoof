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

When another owner's check is required, read its real result before calling that stage ready; your green check never proves unrun work. On `small: true` work only the report shrinks. Report DONE_WITH_CONCERNS if required proof is unavailable, naming it. Never weaken a test, check or threshold to pass.
