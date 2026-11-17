---
id: dev-deploy-rollback
title: { en: "Deploy and roll back", ru: "Развертывание и откат" }
description: { en: "Ships a build with a backup, a health check and a tested way back.", ru: "Выкатывает сборку с резервной копией, проверкой здоровья и проверенным путем назад." }
kind: checklist
sources: [anthropics/knowledge-work-plugins engineering/skills/deploy-checklist/SKILL.md, addyosmani/agent-skills skills/shipping-and-launch/SKILL.md, affaan-m/ECC skills/docker-patterns/SKILL.md]
---
You can deploy an approved build and restore the previously agreed working version.

Before:
- The build passed every gate and this exact commit has the approval of the release owner, the CEO or the orchestrator acting for the owner, or the server's recorded auto-approval under the department's autonomous release.
- A backup of the data was taken and you know how to restore it.
- You know the previous version and the command to go back to it.
- Migrations in this release: can the previous version run on the new schema? If not, say so before deploying.

During:
- Deploy to a preview or staging environment first when one exists, and check it.
- Then deploy; watch the health check until it reports the new version.

After:
- Walk the main flow once on the deployed version and watch errors and logs until they settle.
- If health fails or errors jump, roll back first and investigate after. A rollback is not a failure; a broken service left running is.
- Report what you deployed, when, the health result and anything unusual.

Containers: small images, a non-root user, pinned base images, health checks, no secrets baked into layers.
