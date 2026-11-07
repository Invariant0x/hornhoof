---
id: ops-capacity-plan
title: { en: "Capacity plan", ru: "План мощностей" }
description: { en: "Tracks nodes and subscriptions against the work planned and warns before they run out.", ru: "Сверяет узлы и подписки с планами работы и заранее предупреждает, когда их перестанет хватать." }
kind: procedure
sources: [anthropics/knowledge-work-plugins operations/skills/capacity-plan/SKILL.md]
---
Capacity in Hornhoof is two things: nodes, the machines agents run on, and subscriptions, the AI provider plans people bring. A subscription belongs to its owner and serves wherever its owner works; you report on it, you never move it.

Once per turn, and before any big piece of work starts:

1. List each node: owner, CPU, memory, free disk, the agents it carries, and how often it was busy or offline.
2. List each subscription: owner, provider, plan, the agents using it, how close it came to its limits, and when the limits reset.
3. Read the plans the orchestrator shares for the coming turn: which departments grow, which work is heavy (builds, tests, research).
4. Find the gaps: a node that will run out of disk or memory, a provider that will hit its limits, a department with no second provider for cross-checks.
5. For each gap propose one fix with its cost: clean up, add a node, add a plan, shift heavy work to quieter hours, move routine tasks to a cheaper tier.
6. Send the proposals to the CEO through the orchestrator. Buying anything or adding a machine is the CEO's decision.

Keep the numbers from each turn so a trend, not one bad day, drives the proposal.
