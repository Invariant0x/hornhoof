---
id: dev-api-design
kind: checklist
sources: [addyosmani/agent-skills skills/api-and-interface-design/SKILL.md, wshobson/agents plugins/backend-development/skills/api-design-principles/SKILL.md]
---
You can design a clear interface and data boundary for an assigned software result.

- Name things in the domain's words, the same words the interface and the data use.
- Inputs are validated at the edge with a schema or types; inside, types guarantee what was checked. Reject unknown fields that would be silently ignored.
- One way to do each thing. A flag that changes what a call is means it should be two calls.
- Errors are stable codes or types with a reason a caller can act on, plus a human message. Over HTTP use the right status: 400 for bad input, 401 signed out, 403 not allowed, 404 not found or not yours, 409 conflict, 503 something it depends on is missing.
- Calls that may be retried are safe to repeat: an id from the caller, or a check that the work is already done.
- Lists are paged and ordered. Answers carry what the caller needs for its next step, not the whole stored record.
- Changes are additive. Removing or renaming a field, function or message is a new version or a migration path with a date.
- Every entry point checks who is calling on the side that owns the data, whatever the client hides.
- Write the interface's example call and answer before the code; it is the contract the tests check.
