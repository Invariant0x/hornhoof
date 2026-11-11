---
id: orch-resources
title: { en: "Manage company resources", ru: "Управлять ресурсами компании" }
description: { en: "Changes subscriptions, machines, repositories and hosted access only within an authorized request.", ru: "Меняет подписки, машины, репозитории и внешний доступ только в рамках разрешенного запроса." }
kind: procedure
---
You can configure an explicitly authorized company resource.

Read the exact subscription, machine, repository, public link or software version first. Resource changes come only from the CEO through the dedicated tool in the turn answering that person; the repository of a department and its sub-units' urgent-only setting also come from that department's owner, as from the CEO. An employee requesting them goes through the authorized company coordinator; a skill supplies a method, not tool access or a human approval.

A department can keep several repositories: its own, set with set_repository on the department, and one on each of its products. To add another one, use add_repository on the department; it becomes a new product of that department, named after the end of its address unless a name was asked for, and its tasks name that product. To connect a repository to a product the department already has, use set_repository with the product's id. Two repositories of one department whose addresses end in the same name cannot both be kept, because its agents would clone them into one folder.

Every department keeps at least one repository of its own, and all of its work lives there as files: not only code, but letters, texts, layouts and tables too, so that each change is kept and any earlier version can be brought back. In company, a department whose repository is null and whose products have none keeps none; until it has one, its work is handed in as documents with no history. When a department has none, offer it to the CEO or the department's owner in your turn: say why, in plain words (every version of its work kept, any earlier one brought back), and what it takes: a GitHub key saved for the whole company in Company settings or for that department under Repositories on its screen, with which you create a private repository yourself, or the address of a repository they have and a token that may push to it. view of /api/org shows, as each department's repoHost, the key it would be created with, or null. With their word in a turn that answers them, call create_repository with a name for it; without a key it says what is missing, and you pass that on. Otherwise connect the repository they gave with set_repository. Never create one without their word.

Before disconnecting a machine, removing a subscription or repository, changing public access or updating running software, verify the exact requested target and consequence. Do not reuse another machine owner's access approval. For protected machine access, use ask_computer_access with the reason and wait for its actual authorization; never ask the CEO to type shell commands.

Apply the narrowest change with the dedicated resource tool. Keep credentials in their protected store, preserve running work and the documented rollback path, and do not publish or deploy an unapproved commit. Read the resulting record or completion receipt before reporting success. A command acceptance proves acceptance, not that a machine finished an update.
