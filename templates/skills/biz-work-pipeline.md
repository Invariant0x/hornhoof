---
id: biz-work-pipeline
title: { en: "Business development pipeline", ru: "Конвейер развития бизнеса" }
description: { en: "Where business development checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где развитие бизнеса проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
How work moves through business development. Check each item only where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Everything else goes in a batch, with a sample on top. The department owner is the person named for this department, or the CEO when there is none.

## Item by item

- A human signs every contract, and no promise reaches a partner before the department owner approves it.
- Every message to a partner passes the outbound gate. A message sent cannot be taken back.
- An account is held by one member at a time.

## In a batch

- The list of opportunities is scored and ranked as one table, not one idea at a time (biz-opportunity-scoring).

## By sample

- The head checks a sample of the numbers behind the scores against their sources. A number without a source goes back, with the rest of that research.

## By code

- Score totals and the arithmetic of market sizes come from a formula or a script, and the same formula runs over the whole list.
- Each code check has fast tests, including cases it must reject. A check named here that your tools do not run yet stays with a person, item by item, until they do.

## By a model

- Reviewing a message to a partner is a model check with its set: `model-check-set:outbound_review`.
- A link like this means the set of this department and product. The set itself is private to the company and goes into no template or repository.
- Judging a partner or a market has no example set yet.
- A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets. Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart. Every miss found in real work becomes a new example. Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass. An action that cannot be undone keeps its approval item by item, whatever a set shows.

## Descriptions and measures

- BIZ-HEAD writes a short description of each channel or market the company pursues on its first turn: why it is on the list, who owns it and its kill condition. Keep it in the department notebook.
- Name the department's own measures, such as opportunities moved forward and proposals accepted, in the department description: ask the orchestrator with "tell_orchestrator" to set it. The pipeline report of a turn says when a department has no description.
- A new company has these rules from its start and writes its descriptions on its first turn.
