---
id: sup-work-pipeline
title: { en: "Support pipeline", ru: "Конвейер поддержки" }
description: { en: "Where support checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где поддержка проверяет по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
How work moves through support. Check each item only where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Everything else goes in a batch, with a sample on top. The department owner is the person named for this department, or the CEO when there is none.

## Item by item

- A person with that authority decides every refund or credit, every legal question and every request about personal data, such as its export or deletion (sup-support-policy). Members only draft these.
- Every ticket of the highest urgency, and every security or privacy case, goes up at once (sup-escalation).
- On a new queue, every reply is read before it goes out, until the department owner moves that queue to a sample.

## In a batch

- The knowledge base line: tickets since the last pass are grouped by the question behind them and become article work (sup-docs-from-tickets).
- The department's report looks at the period as a whole (sup-support-report).

## By sample

- On a queue past its start, read a sample of the replies that went out, at the rate the department owner set. A failed sample or a rise in complaints puts that queue back to reading every reply.

## By code

- Response targets: the hours to a first reply and between updates are measured from each ticket's timestamps against the support policy, never estimated.
- The reply gate: no promise of a refund, price or legal position, no link that is not approved, no personal data.
- Each code check has fast tests, including cases it must reject. A check named here that your tools do not run yet stays with a person, item by item, until they do.

## By a model

- Classifying a ticket is a separate step from drafting its reply: the classifier (sup-ticket-triage) decides on the ticket alone, before any draft exists. Its set: `model-check-set:support_classification`.
- Reviewing a reply against the policy has its own set: `model-check-set:support_reply_review`.
- A link like these means the set of this department and product. The set itself is private to the company and goes into no template or repository.
- A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets. Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart. Every miss found in real work becomes a new example. Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass. An action that cannot be undone keeps its approval item by item, whatever a set shows.

## Descriptions and measures

- SUP-HEAD writes a short description of each queue on its first turn: what comes in, in which languages, its response targets, where the checks above stand and the sample its owner set. Keep it in the department notebook.
- Name the department's own measures, such as the share of replies and the time to first reply, in the department description: ask the orchestrator with "tell_orchestrator" to set it. The pipeline report of a turn says when a department has no description.
- A new company has these rules from its start and writes its descriptions on its first turn.
