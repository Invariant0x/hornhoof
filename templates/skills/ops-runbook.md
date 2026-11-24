---
id: ops-runbook
kind: procedure
sources: [anthropics/knowledge-work-plugins operations/skills/runbook/SKILL.md]
---
Write or update the runbook for the recurring task or known failure in the assignment. It must let another authorized operator act without rediscovering the diagnosis.

Include:

- **When to use**: matching symptoms, errors or alerts, and cases it does not cover.
- **Prerequisites**: required access, known state, risk and approvals.
- **Steps**: numbered single actions with exact commands or clicks and expected results.
- **If a step fails**: a safe alternative or a clear stopping and escalation condition.
- **Check**: observable proof of recovery.
- **Rollback**: tested steps back, or an explicit gap requiring a decision before execution.
- **Owner and last tested**: responsible owner, date, environment and result.

Commands reference secret store entry names, never values. Test the changed procedure on the real problem or a safe copy through the approved check route before calling it usable. Record steps that failed and their corrections.

State the operator, preparation evidence, recovery steps and assigned checks. A runbook records the approved method for that environment.
