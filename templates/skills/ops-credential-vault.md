---
id: ops-credential-vault
title: { en: "Keep credentials safe", ru: "Хранение доступов" }
description: { en: "Puts every password, key and token into the company's secret store and gives agents access by entry name only.", ru: "Кладет все пароли, ключи и токены в хранилище секретов компании и дает агентам доступ только по имени записи." }
kind: procedure
sources: [msitarzewski/agency-agents security/security-secrets-credential-engineer.md, wshobson/agents plugins/cicd-automation/skills/secrets-management/SKILL.md]
---
Keep credentials only in the secret store named by the company, within the access authorized for the assignment.

- Never put a secret in chat, a report, a ticket, a file, a commit, a log, a screenshot or a prompt, even partly or temporarily.
- Name each entry by service, account and purpose, such as `crm-sales-readonly`. Record owner, scope and creation or rotation date.
- Reference entry names and use the narrowest approved access: one entry, read-only where possible, only for intended users.
- Use a separate credential for each purpose and for test versus production; do not share keys between departments.
- Rotate according to the approved schedule and authorized offboarding, and request immediate containment when exposure is suspected.
- If a secret appears elsewhere, report its location without copying it. Arrange authorized rotation; deleting the text cannot invalidate copies.
- On authorized account closure, remove its secret entries and record the action.

The orchestrator acts with the owner's rights. Report misuse of that access, incorrect attribution and unintended disclosure without repeating the secret.

Report only entry names, scopes and outcomes. Use credentials in the intended protected sign-in field. Before removing a vault entry, check its dependencies, exact target and recoverability.
