---
id: dev-ci-release
title: { en: "Release a version", ru: "Выпустить версию" }
description: { en: "Prepares an authorized version from its exact candidate, checks, approval and rollback evidence.", ru: "Готовит согласованный выпуск по точному коммиту, проверкам, одобрению и доказанному плану возврата." }
kind: procedure
sources: [addyosmani/agent-skills skills/ci-cd-and-automation/SKILL.md, wshobson/agents plugins/cicd-automation/skills/deployment-pipeline-design/SKILL.md, openai/skills skills/.curated/gh-fix-ci/SKILL.md]
---
You can prepare and publish an authorized software version with evidence and a tested way back.

Read the project's release procedure, actual gates and version scheme. Derive the next version from its published versions and compatibility promises. Explain any breaking change and the limits of rollback to the people responsible for the release.

1. Confirm that the exact candidate contains the intended changes and that its assigned checks passed. Read all part outputs and commit identifiers. Never skip, mute or retry a failed check merely to get green. Preserve the evidence and scope of each check.
2. Set the version consistently in the project's manifests and lockfile. Keep the changelog in the repository's required language. Write user-facing release information and required update steps in the languages in which the release is presented.
3. Freeze the checked release candidate on an eligible release or configured integration branch. Run its whole release suite with run_tests. Reuse prior passing work only when the runner confirms applicable scope and fingerprints. Record what ran and what was reused. Keep progressing later work while testing the frozen candidate. Pin dependencies, protect secrets and verify the revision of the build artifacts.
4. Prove rollback first: prior version/artifact, exact command, compatible data/schema and owner of each machine. The checks of step 3 on the exact candidate are the release's proof; another commit does not prove it.
5. Record the checked release revision and suite result with release_turn where the project uses turns, before moving the integration branch. When there is no approval rule, integrate on the required evidence. If the department set a commit rule, apply it to the exact checked candidate through the authorized decision or autonomous proof path. When the applicable autonomous route accepts turnkey evidence, use its holder's own review, security check and tests. Check every eligibility requirement of that path against the current run, candidate and integration target.
6. Move main to the exact checked commit by the project's authorized method, using approval of that commit where required. Build and publish artifacts from that commit by the project's release route. On a turn the version tag on main closes the turn. Follow any separate policy for a production update.
7. Verify the published/deployed revision and health, record the result and preserve the rollback path. Apply employee cards or restart live programs only when separately authorized, while idle, preserving model/provider and active work.

When a check or access condition is unavailable, report that exact blocker rather than weakening it or asking a person to run private technical commands. This ability works for any appropriately authorized employee; role identity does not choose a release owner or grant publication access.
