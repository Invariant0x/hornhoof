---
id: dsn-theme
title: { en: "Themes", ru: "Темы оформления" }
description: { en: "Builds a new theme, such as dark mode or a client's brand, by changing token values only.", ru: "Создает новую тему, например темную или под бренд клиента, меняя только значения токенов." }
kind: procedure
sources: [anthropics/skills skills/theme-factory/SKILL.md]
---
A theme changes how the products look without changing any component.

1. Start from the meaning tokens. A theme gives each of them a new value; it never adds overrides for single components.
2. Choose a small palette: one or two brand colours, neutrals, and status colours that stay recognisable (danger still reads as danger).
3. Check every text and background pair in the new theme against WCAG AA contrast.
4. Check images, icons, charts and shadows: they must stay visible on the new surfaces.
5. Show the theme on the same set of screens as the default theme, side by side, including forms, tables and error states.
6. Name the theme and record its version next to the system's version.

A theme that needs a component change is a system change: take it to your head.
