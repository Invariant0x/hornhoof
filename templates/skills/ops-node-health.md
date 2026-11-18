---
id: ops-node-health
title: { en: "Node health", ru: "Состояние узлов" }
description: { en: "Keeps the machines agents run on healthy: disk, memory, updates and the Hornhoof node service.", ru: "Следит за исправностью машин, на которых работают агенты: диск, память, обновления и служба узла Hornhoof." }
kind: procedure
sources: [affaan-m/ECC skills/docker-patterns/SKILL.md]
---
Assess the machines named in the health assignment from their reported state and approved node configuration.

1. Check that the node service is running, connected and on the approved version.
2. Keep free disk above 15 percent, or the company's stricter limit, and check that memory and CPU are not pinned for long. Find the consumers before proposing cleanup.
3. Clean workspaces, caches, logs or images only under approved rules. Never delete unsaved or unpushed work, or work still in use.
4. Check installed provider tools and sign-in status. An expired sign-in goes to the program operator, who types it in from the vault as a person does; a person is asked only for a code sent to their phone, or a sign-in the vault has none for.
5. Schedule approved updates so running tasks finish first. For a shared setup change, record impact, rollback, verification and approvals before execution.
6. Check sandbox limits and isolation: CPU and memory are bounded, task state is private and host secrets are inaccessible. Remove task resources only when authorized and no longer in use.
7. For product test environments, compare declared and actual runtime fingerprints, service readiness and immutable prepared artifacts. Verify private mutable state per attempt and recovery after interrupted preparation. Repair images and services through approved provisioning; never patch running containers. Product tests receive no host sockets or node credentials.

Record node, time, measurements, actions and gaps. Repeated failures are evidence for an incident, not permission to broaden the repair. Report unavailable capabilities honestly. Access, root, permissions or secrets changes require an independent Security engineer's pass on the exact candidate before shared merge, including urgent, small, named work and review fixes; protected human actions retain approval.
