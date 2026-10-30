---
id: dev-i18n-en-ru
title: { en: "English and Russian copy", ru: "Тексты на английском и русском" }
description: { en: "Keeps every user-facing text in both languages with the same meaning and the house style.", ru: "Держит каждый текст интерфейса на двух языках с одинаковым смыслом и в стиле компании." }
kind: checklist
sources: []
---
- Every text a person sees exists in English and Russian, in the translation files, with the same meaning. English is the source; Russian is written, not machine-translated word for word.
- Plain words, short sentences, sentence case. Buttons say what happens ("Save changes", "Сохранить изменения").
- No em dashes in either language; use a colon, a comma or a plain hyphen. In Russian write е, never the dotted yo letter.
- Plurals use the plural helper, never "1 items" or "(s)". Russian has three plural forms.
- Numbers, dates and times are formatted for the person's language.
- Russian text runs about a third longer: check that buttons and labels still fit.
- Errors explain what happened and what to do, in both languages, without apologising.
- When you add a key, add it to both files in the same commit; the type check must keep the two files the same shape.
