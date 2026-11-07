---
id: dsn-ui-rules
title: { en: "Interface rules", ru: "Правила интерфейса" }
description: { en: "Checks a screen against the basic rules of layout, type, colour and interaction before it leaves the designer.", ru: "Сверяет экран с базовыми правилами компоновки, типографики, цвета и взаимодействия перед передачей дальше." }
kind: checklist
sources: [nextlevelbuilder/ui-ux-pro-max-skill .claude/skills/ui-ux-pro-max/SKILL.md, wshobson/agents plugins/ui-design/skills/visual-design-foundations/SKILL.md]
---
Go through this list for every screen before you hand it over.

**Layout**
- [ ] One primary action, placed where the eye ends up.
- [ ] Spacing only from the system's scale; related items closer together than unrelated ones.
- [ ] Content sits on the grid; nothing is a few pixels off.
- [ ] Works at phone width (360 px) and on a wide desktop, with no horizontal scroll.

**Type**
- [ ] Few text sizes on one screen; body text at least 16 px on phones.
- [ ] Reading text runs 45 to 80 characters per line.

**Colour**
- [ ] Colour only from meaning tokens; status is never shown by colour alone.
- [ ] Contrast meets WCAG AA in every theme.

**Interaction**
- [ ] Touch targets at least 44 by 44 px; visible focus on every control.
- [ ] Every action shows a result: loading, success, or an error that says what to do.
- [ ] Destructive actions ask for confirmation or can be undone.
- [ ] Forms keep what the user typed after an error and mark the field that failed.

**Content**
- [ ] Real text in every language fits; numbers, dates and money follow each language's format.

A box you cannot tick is either fixed or written into the handoff as a known gap.
