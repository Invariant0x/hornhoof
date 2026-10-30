---
id: ops-tool-install
title: { en: "Tool installation", ru: "Установка инструментов" }
description: { en: "Installs the shared tools and MCP servers agents need on their nodes from trusted sources, pinned and recorded.", ru: "Устанавливает на узлы общие инструменты и MCP-серверы для агентов из надежных источников, с закрепленной версией и записью в учет." }
kind: procedure
sources: []
---
Agents may install tools for their own work. Anything shared on a node, and any tool that needs credentials, goes through you.

1. Confirm the need: which agent, which task, and why what is already installed does not do it.
2. Pick the source: the vendor's official package, image or release. Not a fork, not a script from a forum, a chat or a ticket.
3. Check before installing: licence, maintainer, last release, open security issues, and what it can reach (files, network, shell). A tool that wants more than the task needs gets a narrower setup or is refused.
4. Pin the version. Install on one node first, use it once on a real task, then roll it out to the others through a change request.
5. Record it: node, tool, version, source, who asked, date. Add it to the connector catalog if departments use it as a capability.
6. Docker runs only on the machine the company set aside as a sandbox. Do not install it on other nodes.

Removing a tool is recorded the same way. Report the install command you ran and the output of the version check.
