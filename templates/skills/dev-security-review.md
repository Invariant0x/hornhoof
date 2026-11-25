---
id: dev-security-review
kind: procedure
sources: [affaan-m/ECC agents/security-reviewer.md, addyosmani/agent-skills skills/security-and-hardening/SKILL.md, garrytan/gstack review/specialists/security.md, affaan-m/ECC skills/agent-security-hardening/SKILL.md]
---
You can inspect the access, data and secret boundaries of an assigned change.

Check that a change keeps the company's data, access and secrets protected. The check is the same for your own change and for someone else's. On your own change, read the diff cold: judge what the code does, not what you meant it to do.

Read the candidate's change from its base to its commit, both taken from task.review (`source.baseCommit` and `commit`); on your own change before you submit it, the base is the commit your branch started from.

At a one-shot Security stage, follow the ability "One-shot calls". In the brief, give each call a separate protection to check in the same candidate, such as access checks, handling of private data or redaction of secrets. Ask for code references and fixes. Use the route's judge to combine the findings, then verify them against the code before giving your verdict.

On the first look, use a review facility available in the current environment if it covers the exact candidate and base. Treat its findings as leads and verify them against the source. On recheck, inspect the fixes and the behavior they affect.

Follow every input in the change from where it enters to where it is used, and check what the change touches of this list:

- **Access**: every entry point (a route, a command, a message, a job) checks who is asking and what they may reach, on the side that owns the data. Another company's or another person's data stays out of reach when an id changes.
- **Input handling**: queries, shell commands, paths, markup and templates built from input are parameterized or escaped; nothing from input reaches a command line or an interpreter unchecked.
- **Memory and native code**: unsafe blocks, foreign calls, buffer sizes, integer overflow, untrusted data deserialized into objects.
- **Secrets**: keys and tokens stay out of code, logs, error messages, URLs and responses; they are compared in constant time and stored encrypted where the project does that.
- **Sessions**, where the product has them: cookies flagged, tokens expire, sign-out ends the session, invites and one-time codes work once.
- **Agents and tools**: text an agent reads cannot widen what it may do; tool calls check the caller; prompts carry no secrets.
- **Dependencies**: new ones are needed, maintained and pinned; scripts from the internet are not run blind.
- **Infrastructure**: containers run without needless privileges; a mounted container socket or host folder is justified.

Preserve the orchestrator's owner authority. Report incorrect attribution, unsafe handling and unintended disclosure of information obtained through that access.

Report only weak spots you confirmed in the code: the file and line, who could reach what they should not and how, the impact, and the fix. Check each finding against the code again before reporting it, to rule out false alarms. A confirmed hole blocks; hardening that would be good to have is a note.

**What comes next.** On your own change, fix what blocks, each fix starting with a failing test, and name the rest in your report; your own review replaces no gate. When assigned an independent gate, give its exact-commit verdict with confirmed paths, harm and evidence; never approve the sensitive change you authored.
