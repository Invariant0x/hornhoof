---
id: dsn-tokens
kind: procedure
sources: [nextlevelbuilder/ui-ux-pro-max-skill .claude/skills/design-system/SKILL.md, affaan-m/ECC skills/design-system/SKILL.md]
---
Define the design tokens named in the assignment within the approved shared system. Build them in layers:

1. **Base values**: palette, font families, type and spacing scales, radii, shadows and motion durations. Components do not use these directly.
2. **Semantic values**: names by purpose, such as `color.text.primary`, `color.surface.raised`, `color.action.primary`, `color.status.danger` and `space.inline.sm`. Components use these names.
3. **Component values**: add them only for a component-specific value that a theme must control.

Give every semantic token values in light and dark themes and any other supported theme. Measure text/background contrast, recording at least 4.5:1 for body text and 3:1 for large text and meaningful icons or control boundaries. Check non-colour status indicators and visible focus too.

Keep scales short, merging values with no useful distinction. Name by purpose rather than appearance. Export from one source into the formats builders use, such as CSS variables and JSON; do not maintain the same value by hand in two places.

Return the token definitions, measured evidence, affected components and products, and compatibility impact. Follow the system owner's authorized change process and the task's review gates before adoption; this ability does not approve its own changes.
