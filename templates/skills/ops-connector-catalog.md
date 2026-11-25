---
id: ops-connector-catalog
kind: procedure
sources: [anthropics/knowledge-work-plugins customer-support/CONNECTORS.md]
---
Maintain the connector catalog named in the assignment. It lets users request a capability, such as contact lookup or a payments sandbox, without guessing which service supplies it. Keep one entry per connector:

- Capability in plain words.
- Service and plan.
- API, MCP server or installed tool, with a pinned version.
- Allowed actions: read, write, send, delete or spend; an unlisted action is not permitted.
- Authorized users and approvals required for each action.
- Secret store entry names, never values.
- Rate limits, quotas and cost per use.
- Responsible owner, harmless smoke test, last check date and result.

Update the entry when the assigned connector changes. During an assigned audit, compare entries with the actual authorized setup and run the relevant harmless smoke tests through the approved check route. Mark failures as broken with their evidence. Propose retirement for unused entries; revoke access or delete resources only with the required authorization.

Record the available permissions, exact required scope and any assigned check. Use the approved resource mechanism to change access.
