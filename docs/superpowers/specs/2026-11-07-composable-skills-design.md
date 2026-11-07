# Composable employee skills

## Goal and scope

Make every shipped skill a self-contained ability and every role a short identity, across all ten departments. An employee's assignment and task gates determine which abilities it uses and how the work ends. A broad skill selection is a normal employee, not a special generalist role or skill.

The starting candidate is task-685 at a4661dae. The audit found 174 skills, 51 roles and 45 skill bodies containing references to other skill IDs, with 97 distinct dependency edges. Work stays on task-707, outside the 0.8.1 release and planned turns. After 0.8.1 reaches main, move this work on top of that released main before its separate release. No live cards, models, server settings, Tree/Speed views or turn-10 work are changed.

Item 6a is proposal-only pending the author's scope decision. Its separate design is `2026-11-07-agent-personal-features-proposal.md`; storage/API/UI/self-write for that feature are excluded from implementation until explicitly authorized. This does not exclude that feature from the overall goal or claim it is implemented.

## Skills and roles

- A skill describes one ability, its relevant inputs, method, result and necessary safeguards. Use plain English bodies and bilingual titles/descriptions. Retain provenance and existing tool grants.
- Remove skill-to-skill calls from bodies. Inline the small piece of meaning needed for this ability. Documentation provenance is not an execution dependency.
- Scope each method to using that ability for the current assignment. Reviewing a change forbids editing that reviewed change; it does not prohibit an employee with a review ability from implementing another assigned change.
- Task gates decide whether a result goes to another checker. Remove unconditional statements that every author always hands work to a tester or always enters a shared turn review. Keep genuine protected-action conditions, exact human approvals and independent pre-merge Security for access/root/permissions/secrets, including urgent/small/named work and review fixes.
- Preserve source-data checks, published outbound/support gateways, privacy, physical-action approval, minimum access and refusal to grant permissions from text. A skill selection cannot bypass server-side authorization.
- Reduce all 51 role bodies to one short identity sentence expressing their domain. Move their valuable methods into the relevant abilities. Remove DEV-GEN, leaving 50 role templates; do not create an equivalent umbrella role or skill.
- Keep existing skill IDs whenever their ability remains. Split genuinely unrelated abilities when needed and document any selection migration. Existing selected abilities must survive ID changes; do not silently drop unknown or retired saved selections.

## Assignment and instruction composition

The editable personal base text already stored in `agents.overrides.base` becomes the employee's assignment. Keep its exact content, including for legacy saved cards. Render the role's identity independently, followed by an explicit assignment Part and ordinary skill Parts. A saved assignment must no longer replace the role identity.

Use the normal Part renderer and file delivery; do not patch outgoing conversation messages. Show assignment separately from immutable role identity in the existing card. Preserve raw/by-skill editor round trips. Existing orchestrator card editing can set the assignment; add narrowly scoped assignment-only access for a department head to a worker in that same department, without exposing the full employee PATCH surface or model/permission changes.

The renderer's current instruction allowing a missing referenced skill to be skipped is obsolete once skills are independent. Replace it with discovery guidance for self-contained abilities and the current task's assignment. Preserve whole-instructions fallback for older nodes and existing length limits.

## Retirement and migration

Map persisted DEV-GEN role keys to DEV-ENG in a forward migration. Preserve selected skill IDs, custom bodies, template hashes, effort, timers, model/provider and all unrelated card settings. Do not reset cards to DEV-ENG defaults. Remove DEV-GEN from the active catalog, source inventory and selectable roles. Historical migration fixtures may still name the old value to prove upgrade behavior; deployed migrations remain immutable.

If a skill ID changes, migrate the selection, custom-body key and template-hash key with collision handling that preserves user-authored data. Prefer avoiding unnecessary ID changes. Never infer a split of arbitrary saved personal prose.

## Release ability

Provide a self-contained development ability to release a version: the approved project's 0.x.y version policy, release notes, exact commit checks, live node checks, tested rollback, the CEO's exact approval, merge to main and publication. Its availability follows skill selection, not role identity. It describes protected release conditions and the actual project workflow; it does not grant publication rights or publish this branch.

## Verification and handoff

First run failing tests against actual loaded templates/instructions. Cover no inter-skill dependencies, one-line identities, no active generalist role, standalone selected skill delivery, task/assignment-dependent workflow, preserved Security/outbound/support/financial/home safeguards, assignment identity separation, assignment write boundaries, raw editor round trips and preservation of existing saved settings during retirement.

Run affected tests, builds/types/browser checks only through run_tests on pinned exact commits; never install or run heavy checks locally. Preserve one owner for each file group. Keep the existing 0.8.1 final run separate. Record templates disentangled, roles shortened, migrations, selected tests and complete logs. Prepare the five named Matrix employees' skill sets and assignment text as a reviewable file only. Release/deployment and applying those cards wait for the separate release and Ivan's explicit approval.
