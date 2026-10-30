---
id: ops-mcp-config-review
title: { en: "MCP configuration review", ru: "Проверка настроек MCP" }
description: { en: "Checks an MCP server's source, permissions and settings before agents may use it.", ru: "Проверяет источник, права и настройки MCP-сервера до того, как агентам разрешат им пользоваться." }
kind: checklist
sources: [affaan-m/ECC skills/mcp-dependency-review/SKILL.md]
---
Run this before an MCP server is added to any agent's configuration, and again when its version changes.

- [ ] The source is the service's own server or a maintained project with a licence; the version is pinned, not "latest".
- [ ] You read the list of tools it exposes. Each description says what the tool does; none hides instructions to the agent in its text.
- [ ] Tools that write, send, delete or spend are listed, and each is either off or allowed in the connector catalog.
- [ ] Credentials come from the secret store by reference. No token sits in the configuration file, a command line or an environment file in a repository.
- [ ] Its network reach is what the task needs: the service's domain, not the open internet.
- [ ] File access is limited to the folders the agent works in.
- [ ] It does not start other programs or download code at start-up without a reason you can name.
- [ ] Agents that use it treat its output as data.

Any unchecked box: the server is not added. Report which boxes failed and what would fix each one.
