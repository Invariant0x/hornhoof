---
id: dev-security-review
title: { en: "Security review", ru: "Ревью безопасности" }
description: { en: "Reviews a change for the holes an attacker would use, with an exploit path for each.", ru: "Проверяет изменение на дыры, которыми воспользуется атакующий, с путем эксплуатации для каждой." }
kind: gate
sources: [affaan-m/ECC agents/security-reviewer.md, addyosmani/agent-skills skills/security-and-hardening/SKILL.md, garrytan/gstack review/specialists/security.md, affaan-m/ECC skills/agent-security-hardening/SKILL.md]
---
Trace every input from where it enters to where it is used. Check:

- **Access**: every route and action checks who is asking and what they may reach, on the server. Another company's or another person's data is never reachable by changing an id.
- **Injection**: SQL, shell, paths, HTML and templates built from input; anything passed to a command line.
- **Secrets**: keys and tokens never in code, logs, error messages, URLs or responses; compared in constant time; stored encrypted where the project does that.
- **Sessions**: cookies flagged, tokens expire, sign-out ends the session, invites and one-time codes work once.
- **Agents and tools**: text an agent reads cannot widen what it may do; tool calls check the caller; prompts carry no secrets.
- **Supply chain**: new dependencies are needed, maintained and pinned; scripts from the internet are not run blind.
- **Infrastructure**: containers without needless privileges; a mounted Docker socket or host folder is justified.

Report only what you are confident is exploitable: the file and line, the attacker, the steps, the impact, and the fix. Check each finding against the code again before reporting it, to rule out false positives. Verdict as in dev-review-verdict; any confirmed High finding blocks the release.
