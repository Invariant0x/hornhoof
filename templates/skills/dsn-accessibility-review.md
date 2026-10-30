---
id: dsn-accessibility-review
title: { en: "Accessibility review", ru: "Проверка доступности" }
description: { en: "Checks a mockup or a built screen against WCAG 2.2 AA, with evidence for each finding.", ru: "Проверяет макет или готовый экран на соответствие WCAG 2.2 AA и подкрепляет каждое замечание доказательством." }
kind: checklist
sources: [anthropics/knowledge-work-plugins design/skills/accessibility-review/SKILL.md, wshobson/agents plugins/ui-design/skills/accessibility-compliance/SKILL.md, affaan-m/ECC agents/a11y-architect.md]
---
Check against WCAG 2.2 level AA. Test a built screen; on a mockup, check what can be checked and list the rest for the built version.

- [ ] **Contrast**: 4.5:1 for body text, 3:1 for large text, icons and control borders, in every theme. Measure and record the ratio.
- [ ] **Keyboard**: every action works with Tab, Enter, Space and the arrows; the order follows the visual order; no trap; focus always visible.
- [ ] **Names**: every control, image and icon button has an accessible name; decorative images are hidden from screen readers.
- [ ] **Structure**: one main heading, headings in order, landmarks, lists as lists, tables with header cells.
- [ ] **Forms**: visible labels; errors tied to their field and announced; required fields marked in text, not by colour alone.
- [ ] **Zoom and reflow**: usable at 200 percent zoom and at 320 px width without horizontal scroll.
- [ ] **Targets**: at least 24 by 24 px, and 44 by 44 for main touch controls.
- [ ] **Motion**: nothing flashes more than three times a second; animation respects the reduced-motion setting.
- [ ] **Language**: the page declares its language, and the Russian version declares Russian.

Run an automated checker (for example axe through Playwright), then check by hand: tools find only part of the problems. Each finding gives the criterion number, where it is, the evidence (screenshot or tool output) and the fix.
