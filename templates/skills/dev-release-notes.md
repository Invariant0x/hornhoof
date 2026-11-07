---
id: dev-release-notes
title: { en: "Release notes", ru: "Заметки к выпуску" }
description: { en: "Writes what a release changes for the people who use it, in each language the product has.", ru: "Пишет, что выпуск меняет для тех, кто им пользуется, на каждом языке продукта." }
kind: procedure
sources: [garrytan/gstack document-release/SKILL.md.tmpl]
---
For every release, from the merged changes and their reports:

1. **One line on top**: what this version is about, in a person's words.
2. **New**: what people can do now that they could not, each in one sentence, starting with the verb.
3. **Changed**: what works differently, and what a person has to do about it, if anything.
4. **Fixed**: bugs people saw, described as they saw them, not by the code.
5. **Before you update**: database changes, anything that makes going back to the previous version unsafe, new settings, steps an admin must take.
6. **Version and commit**, so anyone can find the exact build.

Write them in each language the product has, the source language first. Leave out internal refactors and test changes unless they change behaviour. No hype and no promises about the next version. The head checks the notes against the release before the CEO approves it.
