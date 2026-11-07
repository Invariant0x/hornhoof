---
id: orch-resources
title: { en: "Manage company resources", ru: "Управлять ресурсами компании" }
description: { en: "Changes subscriptions, machines, repositories and hosted access only within an authorized request.", ru: "Меняет подписки, машины, репозитории и внешний доступ только в рамках разрешенного запроса." }
kind: procedure
---
You can configure an explicitly authorized company resource.

Read the exact subscription, machine, repository, public link or software version first. Resource changes come only from the CEO through the dedicated tool in the turn answering that person. An employee requesting them goes through the authorized company coordinator; a skill supplies a method, not tool access or a human approval.

Before disconnecting a machine, removing a subscription or repository, changing public access or updating running software, verify the exact requested target and consequence. Do not reuse another machine owner's access approval. For protected machine access, use ask_computer_access with the reason and wait for its actual authorization; never ask the CEO to type shell commands.

Apply the narrowest change with the dedicated resource tool. Keep credentials in their protected store, preserve running work and the documented rollback path, and do not publish or deploy an unapproved commit. Read the resulting record or completion receipt before reporting success. A command acceptance proves acceptance, not that a machine finished an update.
