---
id: ops-postmortem
kind: procedure
sources: [wshobson/agents plugins/incident-response/skills/postmortem-writing/SKILL.md]
---
Write a blameless postmortem for the incident assigned for review, after recovery facts are available.

- **Summary**: what happened in three sentences understandable outside Operations.
- **Impact**: who was stopped, for how long, and what was lost or spent, with sources.
- **Timeline**: first sign, detection, actions and recovery, with log timestamps rather than memory.
- **Root cause**: the chain of causes and evidence for each link, ending at an actionable cause. Separate unproved hypotheses.
- **What helped or hurt**: detection, communication, tools and runbook accuracy.
- **Actions**: each proposed prevention has an owner, date and observable completion check. Prefer making failure impossible or detectable to reminders to be careful.

Describe systems and steps rather than blame. Return the account, supporting evidence and proposed runbook corrections through the assignment's route. Writing an action does not authorize its execution, spending or access changes; task gates and protected approvals still apply.
