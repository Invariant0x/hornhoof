---
id: dev-release-notes
title: { en: "Release notes", ru: "Заметки к выпуску" }
description: { en: "Writes what a release changes for users as one short list in the repository's language.", ru: "Пишет, что выпуск меняет для пользователей, одним коротким списком на языке репозитория." }
kind: procedure
sources: [garrytan/gstack document-release/SKILL.md.tmpl]
---
You can write release notes that tell a user what changed and what they must do.

For every release, from the merged changes and their reports, write one short list in the repository's language, with no translation into other languages:

1. **Fixed**: bugs people saw, described as they saw them, not by the code.
2. **Added**: what people can do now that they could not, starting with the verb.
3. **Changed**: what works differently. When people must act before updating (a database change, anything that makes going back to the previous version unsafe, a new setting, a step an admin must take), make that the first entry, starting with "Before you update:".

Keep this order, each heading once and only when it has entries, one line per entry in plain words, with no summary paragraph and no other section. Give the version, date and commit where the project's release format asks for them, so anyone can find the exact build. Leave out internal refactors and test changes unless they change behaviour. No hype and no promises about the next version. The head checks the notes against the release before the department's owner, or the CEO, approves it.
