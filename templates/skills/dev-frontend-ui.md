---
id: dev-frontend-ui
title: { en: "Frontend engineering", ru: "Фронтенд-разработка" }
description: { en: "Builds screens that match the design system, work on every size and are accessible.", ru: "Делает экраны по дизайн-системе, работающие на любом размере и доступные." }
kind: checklist
sources: [addyosmani/agent-skills skills/frontend-ui-engineering/SKILL.md, anthropics/skills skills/frontend-design/SKILL.md]
---
- Use the design system's tokens and components. A new colour, size or component goes to Design through your head, not into the code on its own.
- Every screen has its states: loading, empty, error, partial, and the normal one. An empty screen says what to do next; an error says what happened and how to fix it.
- Copy is in plain words, sentence case, and the same action has the same name everywhere. All copy goes through the translation files; nothing is hard-coded.
- Keyboard works everywhere: focus is visible, order is logical, Escape closes what it opened. Use real buttons and labels; give icons accessible names.
- Layout holds from a phone width (360 px) to a wide screen, with no horizontal scroll. Respect reduced motion.
- Keep state where it is used; fetch once and share; never block the page on something it can show later.
- Test behaviour the way a person uses it: by role and visible text, not by class names.
- Before reporting done, open the screen in a browser (dev-browser-check) in both themes and both languages, and attach screenshots.
