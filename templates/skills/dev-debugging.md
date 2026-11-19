---
id: dev-debugging
title: { en: "Systematic debugging", ru: "Систематическая отладка" }
description: { en: "Finds the root cause of a bug before changing any code.", ru: "Находит первопричину ошибки, прежде чем менять код." }
kind: procedure
sources: [obra/superpowers skills/systematic-debugging/SKILL.md]
---
You can locate the cause of an observed software failure before changing it.

No fix without a root cause.

1. **Read the error** completely: the message, the stack, the line. Most answers are in it.
2. **Reproduce** it reliably, with the smallest input and steps. If you cannot reproduce it, gather more data (logs, inputs, versions) before guessing.
3. **Check what changed**: recent commits, dependencies, configuration, data.
4. **Trace backwards** from where it fails to where the wrong value first appeared. Add temporary logging at each boundary rather than guessing.
5. **Form one hypothesis**, state it in a sentence, and test it with the smallest change or experiment. One variable at a time.
6. **Fix at the source**, with a failing test that reproduces the bug first. Then remove the temporary logging.
7. **Defend in depth** where the bad value could enter again: validate at the boundary that let it in.

Observe the actual completion condition. Continue while each attempt tests a new supported hypothesis. When evidence stops advancing, report what you ruled out and change the premise, approach or repair owner.
