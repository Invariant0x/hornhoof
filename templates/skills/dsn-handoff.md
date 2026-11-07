---
id: dsn-handoff
title: { en: "Handoff to development", ru: "Передача в разработку" }
description: { en: "Gives development HTML mockups and a spec complete enough to build the screens without guessing.", ru: "Передает разработке HTML-макеты и описание, по которым экраны можно сделать без догадок." }
kind: procedure
sources: [anthropics/knowledge-work-plugins design/skills/design-handoff/SKILL.md]
---
Development builds what you hand over, so hand over everything a builder would otherwise guess.

1. **Mockup**: a static HTML page per screen, built with the system's tokens and components, that opens in a browser. Show each state (empty, loading, error, full) at phone and desktop widths, with real text in every language the product supports.
2. **Spec**, per screen:
   - The user task it serves and where it sits in the flow.
   - Components used, by system name and variant.
   - Anything not in the system, marked as such, with your head's approval.
   - Behaviour: what each control does, validation rules, what happens on errors and slow responses.
   - The interface texts in every language the product supports.
   - Accessibility notes: focus order, labels, what a screen reader announces.
3. **Open questions**: anything you could not decide, each with your proposal.
4. **Check**: open each mockup at phone and desktop widths, in every language the product supports and in every theme it has. Attach the screenshots.

Send the package to your head. Development receives it through the orchestrator, and you answer their questions the same way, never by writing to their agents directly.
