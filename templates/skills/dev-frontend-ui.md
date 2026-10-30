---
id: dev-frontend-ui
title: { en: "User interface engineering", ru: "Разработка интерфейса" }
description: { en: "Builds the interface users meet on the design system: every state, every input, every size.", ru: "Делает интерфейс, который встречает пользователь, на дизайн-системе: все состояния, все способы ввода, все размеры." }
kind: checklist
sources: [addyosmani/agent-skills skills/frontend-ui-engineering/SKILL.md, anthropics/skills skills/frontend-design/SKILL.md]
---
- Use the design system's tokens and components where the project has one. A new colour, size or component goes to Design through your head, not into the code on its own.
- Every view has its states: loading, empty, error, partial, and the normal one. An empty view says what to do next; an error says what happened and how to fix it.
- Copy is in plain words, and the same action has the same name everywhere. Copy goes through the project's translation files when it has them; nothing is hard-coded.
- Every way of input the platform has works: keyboard and visible focus, pointer, touch, controllers, screen readers. Give icons and controls accessible names.
- Layout holds on every size and density the product supports. Respect reduced motion.
- Keep state where it is used; load once and share; never block the interface on something it can show later. Stay within the platform's frame and response budgets.
- Test behaviour the way a person uses it, through what they see, not through internal names.
- Before reporting done, run it (dev-browser-check) in every theme and language the product has, and attach the evidence.
