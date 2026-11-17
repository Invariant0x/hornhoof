---
id: hh-work-fast
title: { en: "Work fast, keep the proof", ru: "Работать быстро, сохраняя проверку" }
description: { en: "Reduce delay with the same proof, using helpers for independent parts of a turnkey task and running heavy checks one at a time.", ru: "Сокращает задержки с той же проверкой: независимые части задачи под ключ ведет с помощниками, тяжелые проверки запускает по одной." }
kind: checklist
sources: [unclebob/ub-mode SKILL.md, addyosmani/agent-skills skills/incremental-implementation/SKILL.md, addyosmani/agent-skills skills/context-engineering/SKILL.md, affaan-m/ECC skills/iterative-retrieval/SKILL.md, affaan-m/ECC skills/search-first/SKILL.md, affaan-m/ECC skills/parallel-execution-optimizer/SKILL.md, affaan-m/ECC skills/agentic-engineering/SKILL.md, obra/superpowers skills/subagent-driven-development/SKILL.md, garrytan/gstack ETHOS.md]
---
You can reduce delay and reading cost while preserving evidence and approvals.

Spend less on everything except the proof: the result must stay just as checkable. Where a rule here would cost you a check or an approval, the check and the approval win.

- **A small step, not a big plan.** Take the smallest step whose result you can check, check it, then choose the next one. Write a plan only when steps depend on each other or the work is new and large.
- **Read only what the step needs.** Start from what the task names. Search before you open, read the part that answers the question rather than the whole file, log or thread, and stop when you can act. Widen only when a question stays open. Hand bulk reading to a helper and keep its conclusion. A skill you follow and the output of a check are read whole.
- **Use what exists.** Before you make something, look for it in your project, your tools and your skills.
- **Do not prove it twice.** A check that passed on this exact commit or version stands: read its result instead of running it again. After a change, run only what that change could affect.
- **Do things at once.** Reads and searches that do not depend on each other go together. For a turnkey task with independent parts, run them in parallel with your program's helpers (subagents in Claude Code), one assignment per part. Merge and check their results yourself. Run heavy checks on the machine (whole-app tsc, vitest and browser tests) one at a time, never in parallel helpers. If your program has no helpers, do the parts in turn.
- **Do not wait without a reason.** While a check or an answer is pending, start the next independent piece. Wait only for what truly stops you, with a named owner and a deadline. Settle what is yours to decide instead of asking.
- **A short report.** The result, its evidence and what you need next. No retelling of your steps or of the task, and nothing said twice.
- **Effort by size.** A small task gets a few lines of brief, one check and one line of report; only a risk of real harm earns more care than its size. Give a step to the cheapest helper that can do it, and move up only when it fails for lack of reasoning. Stop when the acceptance is met.
