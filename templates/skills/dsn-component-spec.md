---
id: dsn-component-spec
title: { en: "Component specification", ru: "Спецификация компонента" }
description: { en: "Writes the full description of a shared component: its parts, variants, states and rules of use.", ru: "Полностью описывает общий компонент: части, варианты, состояния и правила использования." }
kind: procedure
sources: [anthropics/knowledge-work-plugins design/skills/design-system/SKILL.md, wshobson/agents plugins/ui-design/skills/design-system-patterns/SKILL.md]
---
Write a spec for each shared component before development builds it:

- **Purpose**: what it is for, and what it is not for (name the component to use instead).
- **Anatomy**: its parts, which are required and which optional.
- **Variants**: the sizes and kinds it comes in and when to choose each. Fewer is better.
- **States**: default, hover, focus, active, disabled, loading, error, selected, as they apply. Focus is always visible.
- **Tokens**: the meaning tokens each part uses.
- **Behaviour**: keyboard use, what a click or tap does, how it handles long text, overflow and narrow screens.
- **Accessibility**: role, accessible name, how its state is announced, a touch target of at least 44 by 44 px.
- **Content**: rules for its labels and messages in English and Russian. Russian text often runs 20 to 30 percent longer.
- **Do and don't**: two or three examples of each.

Show every variant and state on one mockup page. When an existing component almost fits, propose a variant before a new component.
