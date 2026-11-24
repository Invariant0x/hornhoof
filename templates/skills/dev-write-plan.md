---
id: dev-write-plan
kind: procedure
sources: [obra/superpowers skills/brainstorming/SKILL.md, obra/superpowers skills/writing-plans/SKILL.md, anthropics/knowledge-work-plugins engineering/skills/system-design/SKILL.md]
---
You can describe a new or dependent implementation as checkable steps.

Before a plan, make sure the goal is understood: what it is for, who uses it, what is out of scope, what would make it a failure even if it works. Ask whoever gave you the task when that is unclear.

A plan says what the implementer cannot decide alone:
1. **Files**: which ones are created or changed, and what each is responsible for. Small focused files over large ones; follow the patterns already there.
2. **Interfaces**: exact names, parameters and return types that tasks share, so later tasks use what earlier ones produced.
3. **Tasks**: each the smallest unit with its own test cycle, in order. For each: the failing test (name and assertions, with exact values), the code step (signature, file, the values that are pinned), the command that proves it and its expected output, the commit.
4. **Global constraints**: versions, naming, copy rules, limits, once.
5. **Review focus**: the inputs and failure modes no task tests that are most likely to hurt a user.

Leave out what the implementer can decide: function bodies the signature and tests already fix, obvious steps. Lines that decide nothing ("handle errors", "add tests") are gaps; replace them with the decision. Then check the plan against the design: every requirement has a task.
