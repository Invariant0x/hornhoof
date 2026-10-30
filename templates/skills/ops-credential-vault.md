---
id: ops-credential-vault
title: { en: "Keep credentials safe", ru: "Хранение доступов" }
description: { en: "Puts every password, key and token into the company's secret store and gives agents access by entry name only.", ru: "Кладет все пароли, ключи и токены в хранилище секретов компании и дает агентам доступ только по имени записи." }
kind: procedure
sources: [msitarzewski/agency-agents security/security-secrets-credential-engineer.md, wshobson/agents plugins/cicd-automation/skills/secrets-management/SKILL.md]
---
Secrets live in one place: the secret store your company names. Nowhere else.

- Never put a secret in chat, a report, a ticket, a file, a commit, a log, a screenshot or a prompt. Not partly, not for a moment.
- Store each secret under a clear name: service, account, purpose, such as `crm-sales-readonly`. Record its owner, scope and the date it was created or rotated.
- Give an agent access by the entry's name, at the narrowest scope: one entry, read-only where possible, only for the departments that need it.
- One credential per use. Do not share a key between departments, or between test and production.
- Rotate on schedule (at least every 90 days for keys that can write or spend), when someone leaves, and at once when a secret may have leaked.
- If you see a secret where it should not be, do not copy it anywhere. Report its location to your head as an incident, then rotate it. Deleting the text is not enough: copies may exist.
- When an account is closed, delete its entries and record that you did.

Report changes by entry name only, such as "created crm-sales-readonly, scope: read contacts". Never the value.
