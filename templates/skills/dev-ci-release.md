---
id: dev-ci-release
title: { en: "CI and releases", ru: "CI и выпуск версий" }
description: { en: "Keeps the pipeline green and turns a passed change into a versioned build.", ru: "Держит конвейер зеленым и превращает принятое изменение в сборку с версией." }
kind: procedure
sources: [addyosmani/agent-skills skills/ci-cd-and-automation/SKILL.md, wshobson/agents plugins/cicd-automation/skills/deployment-pipeline-design/SKILL.md, openai/skills skills/.curated/gh-fix-ci/SKILL.md]
---
**The pipeline.** The turn's final check and the main line run the same checks: install, build, the whole test suite, the formatter, linters, type checks and script checks, and crapper and dryer on what changed. The main line is always green. A red build is fixed or reverted first, before anything new merges.

**The turn's final check.** When the head gives it, run the whole pipeline once on the turn's branch, into which each executor merged its own work, with the tests the turn added, and hand back the commit and, for each failure, the test and the change that broke it.

**Fixing CI.** Read the failing job's log from the top of the first error. Reproduce it locally with the same command. Fix the cause; never skip, mute or retry a check to get green. Note flaky jobs and hand them to tests.

**A release.**
1. Only changes that passed every gate are in it.
2. Bump the version where the project keeps it, following its scheme.
3. Build the images or packages from that exact commit, tagged with the version and the commit.
4. Run the smoke checks against the built artifact, not against your working copy.
5. Hand the release notes (dev-release-notes) and the commit to the head; the CEO approves the exact commit before it reaches the main line.

Secrets live in the CI secret store only, never in files, logs or commits. Builds must be repeatable: pin versions, lock dependencies.
