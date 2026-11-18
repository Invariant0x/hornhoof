---
id: dsn-accessibility-review
title: { en: "Accessibility review", ru: "Проверка доступности" }
description: { en: "Checks a mockup or a built screen against WCAG 2.2 AA, with evidence for each finding.", ru: "Проверяет макет или готовый экран на соответствие WCAG 2.2 AA и подкрепляет каждое замечание доказательством." }
kind: checklist
sources: [anthropics/knowledge-work-plugins design/skills/accessibility-review/SKILL.md, wshobson/agents plugins/ui-design/skills/accessibility-compliance/SKILL.md, affaan-m/ECC agents/a11y-architect.md]
---
Review the assigned mockup or built screen against WCAG 2.2 level AA. State the version, widths, languages and themes examined. A mockup can prove only part of accessibility; list checks that require the built product.

- [ ] **Contrast**: 4.5:1 for body text and 3:1 for large text, meaningful icons and control borders, in every theme. Measure and record each relevant ratio.
- [ ] **Keyboard**: every action works with Tab, Enter, Space and arrows as appropriate; logical order, no trap and visible focus.
- [ ] **Names**: controls, meaningful images and icon buttons have accessible names; decorative images are hidden from screen readers.
- [ ] **Structure**: a clear main heading, ordered headings, landmarks, real lists and table headers.
- [ ] **Forms**: visible labels, errors associated with fields and announced, required state in text rather than colour alone.
- [ ] **Zoom and reflow**: usable at 200 percent zoom and 320 px width without horizontal scroll or lost content or actions.
- [ ] **Targets**. Check the applicable accessibility minimum and the design system's stricter touch target where one is set. Record which requirement applies.
- [ ] **Motion**: no flashing above three times per second; reduced-motion preferences respected.
- [ ] **Language**: the page and each translated version declare their language.

Use an automated checker on the built product through the approved check route, then inspect keyboard and assistive-technology behavior manually. Automation alone cannot prove accessibility. Report unrun checks explicitly.

Return a verdict with each finding's criterion, location, evidence and proposed fix. For an independent review required by the task, the reviewer is not the author and does not edit the item under review. This restriction concerns that review, not other implementation assignments.
