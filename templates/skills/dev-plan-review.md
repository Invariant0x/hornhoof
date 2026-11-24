---
id: dev-plan-review
kind: procedure
sources: [garrytan/gstack plan-eng-review/SKILL.md.tmpl, affaan-m/ECC agents/architect.md, affaan-m/ECC skills/architecture-decision-records/SKILL.md]
---
You can inspect a proposed implementation plan for a missing contract, risk or check.

Before building a new feature or a change that reshapes the architecture, read the goal first, then the code where it will live, then write a short design note: the target structure, changes, interfaces and risks. Small or local work needs no note. Remove what the target replaces. Describe the design; the lead assigns the work. Whoever builds it follows the note. When several people propose at once, write yours on your own.

- **Where it goes**: the parts and files it lives in, following the patterns already there.
- **What changes**. Identify deployed consumers, persistent records, required compatibility and rollback. Design and prove the migration that preserves the data the project promises to keep.
- **Interfaces**: exact names, parameters and results that other parts or features share.
- **Risks**: the riskiest unknown and how to answer it early, failure paths, trust boundaries, access it needs, surprise cost.

Decide only what the builder cannot decide alone, and keep the note shorter than the code it describes. For a choice that will be hard to undo, add the options you rejected and the cost if wrong. This step has no gates: the note goes in the task, where the builder reads it.
