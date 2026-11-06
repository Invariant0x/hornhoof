---
id: dsn-ux-copy
title: { en: "Interface text", ru: "Тексты интерфейса" }
description: { en: "Writes clear labels, messages and hints, natural in every language the product supports.", ru: "Пишет понятные надписи, сообщения и подсказки, естественные на каждом языке продукта." }
kind: procedure
sources: [anthropics/knowledge-work-plugins design/skills/ux-copy/SKILL.md]
---
Every interface text exists in every language the product supports. Write each language as itself, not as a word-by-word translation.

- **Labels name the action**: "Save changes"; not "OK" or "Submit". The same action has the same word everywhere.
- **Errors say what happened and what to do**: "Card declined. Try another card or contact your bank." Never blame the user; never show a bare error code.
- **Empty states** say what will appear here and offer the first action.
- **Confirmations** name the thing and the consequence: "Delete 3 files? This cannot be undone."
- **Short**: cut every word that does not change the meaning. Buttons are usually two or three words.
- **Terms**: use the glossary in the design system document. A new term goes into it.
- **Each language**: pick one form of address for the product and keep it; follow the company's spelling rules; use that language's quotes and plural forms; leave room for text up to a third longer.
- **Formats**: dates, numbers and money follow each language, such as "1,250.50" or "1 250,50".

Put the texts into the mockup itself and list them by screen in the handoff, with a key for each string if development uses keys.
