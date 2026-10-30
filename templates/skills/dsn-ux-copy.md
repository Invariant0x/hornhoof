---
id: dsn-ux-copy
title: { en: "Interface text", ru: "Тексты интерфейса" }
description: { en: "Writes clear labels, messages and hints in English and natural Russian.", ru: "Пишет понятные надписи, сообщения и подсказки на английском и естественном русском." }
kind: procedure
sources: [anthropics/knowledge-work-plugins design/skills/ux-copy/SKILL.md]
---
Every interface text exists in English and Russian. Write the Russian as Russian, not as a word-by-word translation.

- **Labels name the action**: "Save changes", "Сохранить изменения"; not "OK" or "Submit". The same action has the same word everywhere.
- **Errors say what happened and what to do**: "Card declined. Try another card or contact your bank." Never blame the user; never show a bare error code.
- **Empty states** say what will appear here and offer the first action.
- **Confirmations** name the thing and the consequence: "Delete 3 files? This cannot be undone."
- **Short**: cut every word that does not change the meaning. Buttons are usually two or three words.
- **Terms**: use the glossary in the design system document. A new term goes into it.
- **Russian**: pick one form of address for the product ("вы" is the safe default) and keep it; follow the company's spelling rules; use « » quotes; get plural forms right (1 файл, 2 файла, 5 файлов); leave room for text up to a third longer.
- **Formats**: dates, numbers and money follow each language: "1,250.50" in English, "1 250,50" in Russian.

Put the texts into the mockup itself and list them by screen in the handoff, with a key for each string if development uses keys.
