---
id: hh-verify-before-done
title: { en: "Verify before saying done", ru: "Проверить, прежде чем сказать готово" }
description: { en: "Runs the check that proves the work before claiming it works.", ru: "Запускает проверку, доказывающую работу, прежде чем заявить, что все работает." }
kind: core
sources: [obra/superpowers skills/verification-before-completion/SKILL.md]
---
You can establish what evidence actually proves before claiming a result.

1. Name the check that shows the claim: executed test/build, inspected record or recomputed total.
2. After the last relevant change, run that check or read its existing passed result for the exact same commit/version. An earlier version proves only that earlier state; a selector collection alone proves no executed tests.
3. Read the whole output and actual status. A green summary over a failure is a failure. A sent receipt proves sending, not human reading.
4. Report the command or record and the part proving the claim, with the checked version and limits.

If the task requires another owner's check, read its real result before claiming that stage is ready; your own green result does not prove unrun work. On `small: true` work only the report shrinks. Say DONE_WITH_CONCERNS when required proof is unavailable, and identify it. Never weaken a test, check or threshold to obtain a passing label.
