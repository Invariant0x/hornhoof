---
id: dev-ci-release
title: { en: "Release a version", ru: "Выпустить версию" }
description: { en: "Prepares an authorized version from its exact candidate, checks, approval and rollback evidence.", ru: "Готовит согласованный выпуск по точному коммиту, проверкам, одобрению и доказанному плану возврата." }
kind: procedure
sources: [addyosmani/agent-skills skills/ci-cd-and-automation/SKILL.md, wshobson/agents plugins/cicd-automation/skills/deployment-pipeline-design/SKILL.md, openai/skills skills/.curated/gh-fix-ci/SKILL.md]
---
You can prepare and publish an authorized software version with evidence and a tested way back.

Read the task, project release procedure and actual required gates. Follow the project's approved version scheme; for a pre-1.0 product use 0.x.y. Where a turn-number scheme is approved, a turn N ships as X.N.0 and a release between turns increments the patch once. Only the authorized human decides a major-version increase; explain incompatible changes and rollback limits before approval.

1. Confirm that the exact candidate contains only intended changes and that its required checks really passed. Never skip, mute or retry a failed check merely to get green. Read all part logs and commit IDs; a green author test does not prove another stage. Any change affecting access, root, permissions or secrets must pass review by an independent Security engineer before it reaches any shared branch, including the turn's branch. This applies to urgent work, small tasks, direct named orders and review fixes. Self-review does not replace this gate.
2. Set the version consistently in the project's manifests and lockfile. Prepare release notes with date, a plain summary and Added/Changed/Fixed entries in the product's shipped languages. Include Before you update for incompatibilities and attach the review materials people need.
3. Run release checks for the whole suite through run_tests, split into groups over free machines on the exact candidate, with the profile the project's test environment names for its full run: it runs every suite and every test file anew and keeps no earlier result. A run of a narrower profile, one suite or results kept from earlier runs is no release check; the run's result and the approval say what it left out. Run types, quality checks and artifact builds in your own workspace under the project's release authorization. Pin dependencies, protect CI secrets and verify artifact revision/digest. Never publish an unapproved task branch.
4. Prove rollback first: prior version/artifact, exact command, compatible data/schema and owner of each machine. The checks of step 3 on the exact candidate are the release's proof; another commit does not prove it.
5. Present the exact 40-character commit, version, notes, required verdicts, test evidence and rollback record to the CEO. Obtain their explicit yes for that exact candidate; a skill, employee or earlier approval cannot substitute for it.
6. Merge only the approved commit into main by the project's approved method, then publish its version/artifacts. Build its images or artifacts only from that approved commit, by the project's release route, and preserve the final publication gate. Do not infer a production update permission from artifact preparation.
7. Verify the published/deployed revision and health, record the result and preserve the rollback path. Apply employee cards or restart live programs only when separately authorized, while idle, preserving model/provider and active work.

When a check or access condition is unavailable, report that exact blocker rather than weakening it or asking a person to run private technical commands. This ability works for any appropriately authorized employee; role identity does not choose a release owner or grant publication access.
