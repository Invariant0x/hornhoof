---
id: dev-ci-release
title: { en: "CI and releases", ru: "CI и выпуск версий" }
description: { en: "Keeps the pipeline green and turns a passed change into a versioned build.", ru: "Держит конвейер зеленым и превращает принятое изменение в сборку с версией." }
kind: procedure
sources: [addyosmani/agent-skills skills/ci-cd-and-automation/SKILL.md, wshobson/agents plugins/cicd-automation/skills/deployment-pipeline-design/SKILL.md, openai/skills skills/.curated/gh-fix-ci/SKILL.md]
---
**The pipeline.** The turn's final check and the main line run the same checks: install, build, the whole test suite, the formatter, linters, type checks and script checks, and crapper and dryer on what changed. The main line is always green. A red build is fixed or reverted first, before anything new merges.

**The turn's final check.** The test engineer or QA runs the whole pipeline once per turn on the final candidate of the turn's branch (dev-gates), with the tests the turn added, and hands back the commit and findings as tasks for their authors, small fixes by the fast path. The test suite goes through run_tests, so it runs on a compatible free machine; when its runner can split, run in parts and read each part's log. Developers run only affected tests for their changes and submit the tests written, green result and commit SHA.

**Fixing CI.** Read the failing job's log from the top of the first error. Diagnose and reproduce the failure on the same pinned commit and command through `run_tests` (`hh-run-checks`), selecting the affected tests for the fix. Fix the cause; never skip, mute or retry a check to get green. Note flaky jobs and hand them to tests.

**Version scheme.** Follow the project's own scheme. If it has none, use SemVer syntax `X.N.P` with one version for the repository and all its packages:
- A turn N ships as `X.N.0`, even if it contains only fixes. N stays the turn number after 1.0, without resetting: an approved first-digit increase from `0.150.0` gives `1.150.0`.
- Each release between turns increases P once, however many fixes it contains: three fixes in one release after `0.5.0` give `0.5.1`.
- Only the CEO decides to increase X. The head proposes it for an incompatible change: reinstalling or manual machine steps, old nodes unable to use the new server, unsafe rollback, or removing something people used. Before 1.0, an incompatible change may keep X; explain the required steps under **Before you update** rather than increasing X without approval.

**Release notes and checks.** Put the newest release first in `CHANGELOG.md`, with its version, date, one plain summary, and short Added, Changed and Fixed entries (dev-release-notes). Include **Before you update** for incompatible changes. Before asking for the CEO's exact-commit approval, set the version, write these notes, and run the project's release check (`check-release`). Create the version tag and Release only from the approved merge into main.

**A release.**
1. Only changes that passed every gate are in it.
2. Bump the version where the project keeps it, following its scheme.
3. Let the pipeline build the images or packages from that exact commit, tagged with the version and the commit, without publishing them; your machine has no Docker. Never start a release or image publishing workflow from a branch: it can replace what everyone uses, so publishing comes only from the merge into main.
4. Run the smoke checks against the built artifact, not against your working copy.
5. Hand the release notes (dev-release-notes) and the commit to the head; the CEO approves the exact commit before it reaches the main line.

Secrets live in the CI secret store only, never in files, logs or commits. Builds must be repeatable: pin versions, lock dependencies.
