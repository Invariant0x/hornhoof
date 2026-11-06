---
id: hh-verify-before-done
title: { en: "Verify before saying done", ru: "Проверить, прежде чем сказать готово" }
description: { en: "Runs the check that proves the work before claiming it works.", ru: "Запускает проверку, доказывающую работу, прежде чем заявить, что все работает." }
kind: core
sources: [obra/superpowers skills/verification-before-completion/SKILL.md]
---
Before you write DONE, fixed, passing, sent or ready, prove it in this session:

1. Name the check that would show the claim is true: the test command, the build, the page you open, the record you read back, the total you recompute.
2. Run it now, after your last change. An earlier run proves an earlier state.
3. Read the whole output. A green summary line over a failure is a failure.
4. Put the command and the part of the output that proves the claim into your report.

A check someone else owns is proved only by its result: read that before you claim readiness, as your own green tests do not prove a check nobody ran. On `small: true` work the proof stays and only its report shrinks to a line.

If you cannot run the check, say DONE_WITH_CONCERNS and why. "Should work", "looks right" and "probably" are not evidence. Never weaken a test, a check or a threshold to make it pass; report what failed instead.
