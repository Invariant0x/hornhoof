---
id: dsn-component-spec
kind: procedure
sources: [anthropics/knowledge-work-plugins design/skills/design-system/SKILL.md, wshobson/agents plugins/ui-design/skills/design-system-patterns/SKILL.md]
---
Specify the shared component named in the assignment using the approved design system as input. Prefer a justified variant of an existing component over a duplicate.

Include:

- **Purpose**: intended use, excluded uses and the existing alternatives.
- **Anatomy**: parts, required and optional.
- **Variants**: sizes and kinds, with a rule for choosing each.
- **States**: default, hover, focus, active, disabled, loading, error and selected where applicable; visible focus throughout.
- **Tokens**: semantic tokens used by each part, without private colours or spacing.
- **Behaviour**: keyboard, pointer and touch actions, long text, overflow and layout at narrow and wide widths.
- **Accessibility**: role, accessible name, state announcements and touch targets of at least 44 by 44 px.
- **Content**: labels and messages in every supported language, with expansion and direction changes considered.
- **Examples**: two or three correct and incorrect uses.

Show all variants and states on a mockup page, at representative narrow and wide widths and in each supported theme. Record affected products, compatibility and unresolved system decisions. Return the spec and examples to the recipient named in the task; a proposed component becomes approved only through the system's authorized change process.
