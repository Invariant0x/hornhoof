---
id: dev-gates
title: { en: "Gates and cross-checks", ru: "Ворота и перекрестные проверки" }
description: { en: "Routes each change through the right gates in order, with independent reviewers.", ru: "Проводит каждое изменение через нужные ворота по порядку, с независимыми проверяющими." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md, affaan-m/ECC skills/council-multi-model/SKILL.md, affaan-m/ECC skills/santa-method/SKILL.md]
---
The order for a change: plan review (big plans only) by the architect, implementation, code review, tests, security review, red team on a preview (when the change crosses a trust boundary), QA acceptance, then the release with the CEO's approval of the exact commit.

- **Never the author.** Whoever made a piece of work does not pass its gate.
- **Another provider when you have one.** The reviewer, security and QA run on a different provider than the implementer (Claude writes, Codex reviews, or the other way round). With only one provider, use a fresh session on another tier and say "cross-check degraded" in your status.
- **Security is doubled** for changes to access, secrets or agent tools: two reviewers, same checklist, both must pass, findings merged and checked for false positives.
- **A gate's verdict needs its reasons.** APPROVE without a comment is sent back.
- **Changes requested** go back to the same author, then through the same gate again (hh-fix-loop).
- **Do not double the builders.** Two implementers work on separate areas, not on the same task.

Keep a line per change: which gates it passed, by whom, and when. The release lists them.
