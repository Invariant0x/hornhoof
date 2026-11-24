---
id: dsn-plan-review
kind: gate
sources: [garrytan/gstack plan-design-review/SKILL.md.tmpl]
---
Review the product or feature plan named in the assignment for missing design decisions before the affected visual work is built.

Mark each point pass, gap or not needed:

- [ ] **User and task**: users, main job, frequency and devices.
- [ ] **Screens and flow**: screens, transitions, way back and way out.
- [ ] **States**: empty, loading, error, success, no access and partial data.
- [ ] **Content**: real text in all supported languages and longest likely values.
- [ ] **System fit**: approved components, justified additions and required system decisions.
- [ ] **Layout**: narrow and wide widths, long content, wrapping and themes.
- [ ] **Accessibility**: keyboard path, focus, contrast, readable type and accessible names.
- [ ] **Edge cases**: many or no items, slow network and concurrent changes.
- [ ] **Character**: observable choices that distinguish the product within the system.

Return ready, ready once the listed gaps close, or needs design work first. Give evidence, impact and an estimate for unresolved work. Mark facts unavailable from the plan as unknown.

When the task assigns independent review, the reviewer is not the plan's author and leaves the reviewed plan unchanged. The task determines recipients, approval gates and which work depends on this verdict.
