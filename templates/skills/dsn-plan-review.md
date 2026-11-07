---
id: dsn-plan-review
title: { en: "Design review of a plan", ru: "Дизайн-ревью плана" }
description: { en: "Checks a product or feature plan for design gaps before anyone builds it.", ru: "Проверяет план продукта или функции на пробелы в дизайне до начала разработки." }
kind: gate
sources: [garrytan/gstack plan-design-review/SKILL.md.tmpl]
---
When a plan for a product or feature reaches Design, review it before development starts. A missing design decision found now costs minutes; found after the build, it costs days.

Mark each point pass, gap or not needed:

- [ ] **User and task**: who uses it, the main job they do, how often, on which devices.
- [ ] **Screens and flow**: every screen and how the user moves between them, including the way back and the way out.
- [ ] **States**: empty, loading, error, success, no access, partial data.
- [ ] **Content**: real text in every language the product supports, not placeholder text; the longest likely values.
- [ ] **System fit**: which existing components it uses; anything new is named and justified.
- [ ] **Accessibility**: keyboard path, contrast, readable text sizes, labels for screen readers.
- [ ] **Edge cases**: many items, no items, a slow network, two people changing the same thing.
- [ ] **Distinct look**: what makes this product recognisable, not a stock template.

Return a verdict: ready, ready once the listed gaps are closed, or needs design work first, with an estimate of that work. Send it back the way the plan came, through the orchestrator.
