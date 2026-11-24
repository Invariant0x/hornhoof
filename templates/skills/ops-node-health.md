---
id: ops-node-health
kind: procedure
sources: [affaan-m/ECC skills/docker-patterns/SKILL.md]
---
Assess the machines named in the health assignment from their reported state and approved node configuration.

1. Check that the node service is running, connected and on the approved version.
2. Reserve enough space for the peak concurrent workload, recovery and a safety margin based on observed growth. Inspect actual consumers before making a storage change.
3. Clean workspaces, caches, logs or images only under approved rules. Never delete unsaved or unpushed work, or work still in use.
4. Check installed provider tools and sign-in status. An expired sign-in goes to the program operator, who types it in from the vault as a person does; a person is asked only for a code sent to their phone, or a sign-in the vault has none for.
5. Schedule approved updates so running tasks finish first. For a shared setup change, record impact, rollback, verification and approvals before execution.
6. Check sandbox limits and isolation: CPU and memory are bounded, task state is private and host secrets are inaccessible. Remove task resources only when authorized and no longer in use.
7. Compare the reported runtime and readiness with what the assigned product needs. Give any discrepancy and relevant evidence to the provisioning owner.

Record the node, observations, action and evidence gaps. Send recurring failures to the incident owner and identify the affected trust boundaries.
