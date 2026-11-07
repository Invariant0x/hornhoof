---
id: dev-plan-review
title: { en: "Design note", ru: "Записка о дизайне" }
description: { en: "Before a new or large feature is built, says in a short note how it fits the system.", ru: "До того как строят новую или крупную функцию, коротко записывает, как она встает в систему." }
kind: procedure
sources: [garrytan/gstack plan-eng-review/SKILL.md.tmpl, affaan-m/ECC agents/architect.md, affaan-m/ECC skills/architecture-decision-records/SKILL.md]
---
Before a new or large feature is built, take a short step: read the goal first, then the code where the feature will live, then write a short design note: where it goes, what changes, the interfaces and the risks. Whoever builds it follows the note. When several people propose at once, write yours on your own.

- **Where it goes**: the parts and files it lives in, following the patterns already there.
- **What changes**: the data model before the logic, one decision in one place, migrations of existing data.
- **Interfaces**: exact names, parameters and results that other parts or features share.
- **Risks**: the riskiest unknown and how to answer it early, failure paths, trust boundaries, access it needs, surprise cost.

Decide only what the builder cannot decide alone, and keep the note shorter than the code it describes. For a choice that will be hard to undo, add the options you rejected and the cost if wrong. This step has no gates: the note goes in the task, where the builder reads it.
