---
id: dev-i18n-en-ru
kind: checklist
sources: []
---
You can deliver interface text in the languages the product ships.

- Every text a user sees exists in each language the product supports, in its translation files, with the same meaning. The repository says which languages there are and which one is the source. Each translation is written, not translated word for word by a machine.
- Plain words, short sentences. Buttons say what happens ("Save changes", not "OK").
- Follow the copy rules the repository sets for each language.
- Plurals use the plural helper, never "1 items" or "(s)"; some languages have three or more plural forms.
- Numbers, dates, times and money are formatted for the user's language and region.
- A translation runs longer or shorter than the source: check that buttons and labels still fit.
- Errors explain what happened and what to do, in every language, without apologising.
- When you add a key, add it for every language in the same commit, and keep the files the same shape.
