---
id: dsn-tokens
title: { en: "Design tokens", ru: "Дизайн-токены" }
description: { en: "Defines the named colours, type, spacing and other values every product's interface is built from.", ru: "Задает именованные цвета, шрифты, отступы и другие значения, из которых строится интерфейс каждого продукта." }
kind: procedure
sources: [nextlevelbuilder/ui-ux-pro-max-skill .claude/skills/design-system/SKILL.md, affaan-m/ECC skills/design-system/SKILL.md]
---
Tokens are the named values the whole system is built from. Build them in layers:

1. **Base values**: the raw palette, font families, a type scale, a spacing scale (for example in 4 px steps), radii, shadows, motion durations. No component uses these directly.
2. **Meaning tokens**, named by purpose: `color.text.primary`, `color.surface.raised`, `color.action.primary`, `color.status.danger`, `space.inline.sm`. Components use only these.
3. **Component tokens**, only where a component needs its own value that themes should be able to change.

Rules:

- Every meaning token has a value in the light and the dark theme.
- Text and background pairs meet WCAG AA contrast: 4.5:1 for body text, 3:1 for large text and interface parts. Check every pair and record the ratio.
- Keep scales short. If two values are rarely told apart, merge them.
- Name by purpose, never by look: `danger`, not `red`.
- Export the tokens from one source into the formats development uses (CSS variables, JSON). Never edit the same value by hand in two places.

A token change is a change for every product: describe what it affects and send it to your head before release.
