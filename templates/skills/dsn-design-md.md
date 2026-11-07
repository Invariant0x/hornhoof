---
id: dsn-design-md
title: { en: "Design system document", ru: "Описание дизайн-системы" }
description: { en: "Keeps the written design system that agents and people read before they design or build a screen.", ru: "Ведет текстовое описание дизайн-системы, которое агенты и люди читают, прежде чем проектировать или верстать экран." }
kind: procedure
sources: []
---
Agents design and build from what they can read. Keep one design system document, such as `DESIGN.md` in the place your company named, that an agent can follow without seeing a single picture.

It holds, in this order:

1. **Principles**: three to five rules that settle arguments, each with an example, such as "one primary action per screen".
2. **Character**: how the products should feel, in a few sentences: what makes them recognisable and what they must never look like.
3. **Tokens**: the meaning tokens with their values and when to use each.
4. **Layout**: grid, breakpoints, page widths, spacing between sections.
5. **Components**: one short entry each, with a link to its full spec.
6. **Patterns**: forms, tables, empty states, errors, confirmations, navigation.
7. **Writing**: voice, a glossary of terms in every language the product supports, formats for dates, numbers and money.
8. **Accessibility rules** every screen must meet.

Keep it short and current: update it in the same piece of work as any system change, and mark it with the system's version number. What is not written here does not exist for the agents who build from it.
