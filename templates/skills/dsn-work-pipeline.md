---
id: dsn-work-pipeline
title: { en: "Design pipeline", ru: "Конвейер дизайна" }
description: { en: "Where design checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где дизайн проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
How work moves through design. Check each item only where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Everything else goes in a batch, with a sample on top. The department owner is the person named for this department, or the CEO when there is none.

## Item by item

- The author checks each design before it goes to Development: its states, widths, languages and use of the system (dsn-ui-rules, dsn-handoff).
- A breaking change to the design system reaches every product, so it waits for its own approval (dsn-system-governance).

## In a batch

- DSN-QA checks built screens as one batch per product, not one at a time as they appear: their match with the design and their accessibility (dsn-visual-qa, dsn-accessibility-review).

## By sample

- Once per turn, DSN-QA checks one product against the system for drift (dsn-system-governance), and the head plans the fixes.

## By code

- Contrast, token use, layout at each width and text that overflows are measured by a script where the product has one, not judged by eye.
- Each code check has fast tests, including cases it must reject. A check named here that your tools do not run yet stays with a person, item by item, until they do.

## By a model

- Design critique (dsn-design-critique) and brand review (dsn-brand-consistency) are model checks, and each has no example set yet.
- A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets. Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart. Every miss found in real work becomes a new example. Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass. An action that cannot be undone keeps its approval item by item, whatever a set shows.

## Descriptions and measures

- DSN-UI writes a short description of its product, and DSN-SYS of the design system, on their first turn: what is in it, which widths, themes and languages count, where the checks above stand and the sample its owner set. Keep it in the department notebook.
- Name the department's own measures, such as designs returned and findings per product, in the department description: ask the orchestrator with "tell_orchestrator" to set it. The pipeline report of a turn says when a department has no description.
- A new company has these rules from its start and writes its descriptions on its first turn.
