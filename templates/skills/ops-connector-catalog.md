---
id: ops-connector-catalog
title: { en: "Connector catalog", ru: "Каталог подключений" }
description: { en: "Keeps one list of the outside services the company is connected to, what each can do and who may use it.", ru: "Ведет единый список внешних сервисов, к которым подключена компания: что каждый умеет и кто может им пользоваться." }
kind: procedure
sources: [anthropics/knowledge-work-plugins customer-support/CONNECTORS.md]
---
The catalog lets other departments ask for a capability, such as "CRM", "email sending" or "payments sandbox", without knowing which product sits behind it. Keep it where your company named, one entry per connector:

- **Capability**: the plain name departments use.
- **Service**: the product and plan behind it.
- **How**: API, MCP server or installed tool, with its version.
- **Actions allowed**: read, write, send, delete, spend. Anything not listed is not allowed.
- **Who may use it**: departments and roles, and which actions need an approval first.
- **Credentials**: the name of the secret store entry, never the secret itself.
- **Limits and cost**: rate limits, quotas, price per use.
- **Owner and check**: who fixes it and the smoke test that proves it works.
- **Last checked**: date and result of the last smoke test.

When you add or change a connector, update its entry in the same piece of work. Run each smoke test at least once per turn and after every change; a failed test marks the entry broken and goes to your head. Remove entries for services the company no longer uses, together with their access.
