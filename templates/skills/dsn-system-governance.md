---
id: dsn-system-governance
title: { en: "Design system governance", ru: "Управление дизайн-системой" }
description: { en: "Keeps one design system for all products and decides what enters it.", ru: "Поддерживает одну дизайн-систему для всех продуктов и решает, что в нее входит." }
kind: procedure
sources: [anthropics/knowledge-work-plugins design/skills/design-system/SKILL.md]
---
The company has one design system. Products differ in content and flows, not in private buttons, colours or spacing.

- **One source**: tokens, components and the design system document live in one place your company named. Product designs reference it; they never copy it.
- **Requests**: when a product designer needs something the system lacks, they ask whoever owns the system, who decides: an existing part already does it (point to it), a variant of an existing part, or a new part. A new part must serve more than one screen, or likely more than one product.
- **Changes**: the design system designer makes them, and someone other than the maker approves them. Each change states what it affects in every product, whether it breaks existing screens, and how built screens get updated. A breaking change goes to the CEO through the orchestrator before it lands, with its cost for development.
- **Versions**: number each release of the system and keep a short list of changes, so development knows what to update.
- **Exceptions**: a product may break a rule only with a written reason from the system's owner and an end date. Track them; an exception that keeps coming back means the system is missing something.
- **Drift**: when design QA's sample of a product against the system finds drift, plan the fixes.

You approve system changes; the designer who made a change never approves it.
