---
id: ops-node-health
title: { en: "Node health", ru: "Состояние узлов" }
description: { en: "Keeps the machines agents run on healthy: disk, memory, updates and the Hornhoof node service.", ru: "Следит за исправностью машин, на которых работают агенты: диск, память, обновления и служба узла Hornhoof." }
kind: procedure
sources: [affaan-m/ECC skills/docker-patterns/SKILL.md]
---
A node is a Linux or macOS machine where the Hornhoof node service runs agents on their owner's subscriptions.

Check each node daily, and whenever an agent reports it slow or offline:

1. The node service runs, is connected to the server and is on the version the company runs.
2. Free disk stays above 15 percent; memory and CPU are not pinned for long. Find what uses them before you clean anything.
3. Old workspaces, caches, logs and container images are cleaned only by rules your head approved. Never delete a work folder that holds unsaved or unpushed work.
4. Provider command-line tools are installed and signed in. If a sign-in expired, the subscription's owner signs in again; never ask for their password.
5. Security updates are applied in a window that cuts off no running task; other updates go through a change request.
6. On the sandbox machine, containers run with memory and CPU limits, without access to the host's secrets, and are removed when their task ends.

Record each check: node, time, the numbers, what you did. A node that fails the same check twice in a week is an incident.
