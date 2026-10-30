---
id: dev-api-design
title: { en: "API and interface design", ru: "Проектирование API и интерфейсов" }
description: { en: "Designs routes, messages and module interfaces that are hard to misuse.", ru: "Проектирует маршруты, сообщения и интерфейсы модулей, которыми трудно воспользоваться неправильно." }
kind: checklist
sources: [addyosmani/agent-skills skills/api-and-interface-design/SKILL.md, wshobson/agents plugins/backend-development/skills/api-design-principles/SKILL.md]
---
- Name things in the domain's words, the same words the screens and the database use.
- Inputs are validated at the edge with a schema; inside, types guarantee what was checked. Reject unknown fields that would be silently ignored.
- One way to do each thing. A flag that changes what an endpoint is means it should be two endpoints.
- Errors are stable codes with a reason a client can act on, plus a human message. Use the right status: 400 for bad input, 401 signed out, 403 not allowed, 404 not found or not yours, 409 conflict, 503 something it depends on is missing.
- Writes that may be retried are safe to repeat: an id from the client, or a check that the work is already done.
- Lists are paged and ordered. Responses carry what the client needs for its next step, not the whole database row.
- Changes are additive. Removing or renaming a field is a new version or a migration path with a date.
- Every endpoint checks who is asking on the server, whatever the client hides.
- Write the interface's example request and response before the code; it is the contract the tests check.
