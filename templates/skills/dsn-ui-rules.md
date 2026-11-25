---
id: dsn-ui-rules
kind: checklist
sources: [nextlevelbuilder/ui-ux-pro-max-skill .claude/skills/ui-ux-pro-max/SKILL.md, wshobson/agents plugins/ui-design/skills/visual-design-foundations/SKILL.md]
---
Check the assigned screen against the approved system and its user task before handing it over.

**Layout**
- [ ] One clear primary action placed at the natural end of the task.
- [ ] System spacing, with related content grouped, and alignment to the system grid.
- [ ] Check layout against the approved design reference at the supported narrow and wide widths.
- [ ] Inspect the real content and action groups at those widths and report any departure from the reference.

**Type**
- [ ] A short type scale, with body text at least 16 px on phones.
- [ ] Reading lines run about 45 to 80 characters.

**Colour**
- [ ] Semantic tokens only, with status conveyed by more than colour.
- [ ] WCAG AA contrast in every theme: 4.5:1 body text and 3:1 large text and meaningful icons or control boundaries.

**Interaction**
- [ ] Touch targets at least 44 by 44 px and visible focus on every control.
- [ ] Explicit hover, focus, active, disabled, loading, error and success states where relevant.
- [ ] Every action communicates its result; errors say how to continue.
- [ ] Destructive actions require confirmation or offer undo.
- [ ] Forms preserve input after an error and identify the failing field.

**Content**
- [ ] Real text in every supported language fits, with room for longer translations and relevant writing directions.
- [ ] Numbers, dates and money follow locale conventions.
- [ ] Empty, partial-data and long-content states remain usable.

Return the checked screen, evidence and unresolved gaps. Use the task's gates for any required independent review; this author check does not replace it.
