---
id: dev-frontend-ui
title: { en: "User interface engineering", ru: "Разработка интерфейса" }
description: { en: "Builds the interface users meet on the design system: every state, every input, every size.", ru: "Делает интерфейс, который встречает пользователь, на дизайн-системе: все состояния, все способы ввода, все размеры." }
kind: checklist
sources: [addyosmani/agent-skills skills/frontend-ui-engineering/SKILL.md, anthropics/skills skills/frontend-design/SKILL.md]
---
You can build an interface on the existing design system for every shipped state and language.

- Read the repository's documented UI reference or style book (such as `AGENTS.md`, `CONTRIBUTING.md` or the project's style guide) before changing layout. Use the design system's tokens and components where the project has one; a new colour, size or component goes to Design through your head, and you never invent unapproved tokens or spacing on your own.
- Non-visual work (server, data, API, logic, states, live data, behaviour tests and a simple temporary skeleton) runs in parallel without waiting on a design mockup; only final visual styling waits for the approved design reference and visual check.
- Every view has its states: loading, empty, error, partial, and the normal one. An empty view says what to do next; an error says what happened and how to fix it.
- Every panel, card, row, settings item and table cell holds its full text and actions within the container width, with no sideways or horizontal scroll. Long words, identifiers, paths and URLs wrap. When space runs short, an entry's action buttons move below the text as a whole group on one even row, sharing a consistent edge and spacing across entries from the project's design reference instead of wrapping buttons one by one. Never hide or clip or drop or truncate text or action buttons with ellipsis or clipped overflow to disguise overflow; every text stays readable in full and every control stays reachable and clickable.
- On the web, reset browser default margins, paddings, borders and backgrounds on interactive controls, and give each component explicit sizing, padding, border, background, font inheritance, icon centring and interactive states instead of relying on browser default geometry. Reserve scrollbar space in scrollable panels without assuming overlay scrollbars so width-taking and overlay scrollbars alike never clip or cover trailing text or actions.
- Copy is in plain words, and the same action has the same name everywhere. Copy goes through the project's translation files when it has them; nothing is hard-coded.
- Design layouts for 20 to 30 languages rather than a fixed two-language pair: allow 1.5x to 2x text expansion, scripts such as CJK and Devanagari with taller line-height, and RTL scripts (such as Arabic and Hebrew) with mirrored layout (on the web, logical CSS properties), without adding unrequested translations.
- Every input the platform has works: keyboard and visible focus, pointer, touch, controllers, screen readers. Give icons and controls accessible names.
- Layout holds on every size and density the product supports. Respect reduced motion.
- Keep state where it is used, load once and share, never block the interface on something it can show later. Stay within the platform's frame and response budgets.
- Test behaviour as a person uses it, through what they see, not internal names.
- Verify an affected web view on an isolated fixture/stand across Chromium, Firefox and WebKit, narrow/wide widths, all shipped themes and the actually longest/shortest shipped locales plus a shipped RTL locale when available: a task's check runs it in Chromium only, and Firefox and WebKit check it in the repository's CI. Run named browser test files in your own workspace and keep screenshots and geometry evidence; browser installation is allowed.
