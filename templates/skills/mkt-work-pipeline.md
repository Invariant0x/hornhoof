---
id: mkt-work-pipeline
title: { en: "Marketing pipeline", ru: "Конвейер маркетинга" }
description: { en: "Where marketing checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где маркетинг проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
How work moves through marketing. Check each item only where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Everything else goes in a batch, with a sample on top. The department owner is the person named for this department, or the CEO when there is none.

## Item by item

- Everything public and every message to a list passes the outbound gate (mkt-publish-approval). What went out cannot be taken back, and risk adds up piece by piece.
- While a channel is new, each piece is checked once, in a fresh context, on another provider than its author's.
- The department owner approves each approach, meaning a template and a segment.

## In a batch

- Where the department owner has lifted piece by piece approval for a channel, the pieces of an approved campaign go out together (mkt-campaign-plan).
- Search work looks over a whole site at a time (mkt-seo-audit).

## By sample

- Past a channel's start, check a sample under the owner's policy. A failed sample or a rise in complaints stops the channel.

## By code

- The rules of the outbound gate, where a piece reaches people directly: the price list, approved links and claims, do-not-contact flags and consent, unsubscribe, and daily limits per sending account and per domain.
- Page markup goes through a validator (mkt-schema-markup).
- Each code check has fast tests, including cases it must reject. A check named here that your tools do not run yet stays with a person, item by item, until they do.

## By a model

- Reviewing a piece before it goes out is a model check with its set: `model-check-set:outbound_review`.
- A link like this means the set of this department and product. The set itself is private to the company and goes into no template or repository.
- Brand review (mkt-brand-voice) has no example set yet.
- A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets. Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart. Every miss found in real work becomes a new example. Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass. An action that cannot be undone keeps its approval item by item, whatever a set shows.

## Descriptions and measures

- MKT-HEAD writes a short description of each channel on its first turn: who it reaches, from which account, its limits, its approach and the sample its owner set. Keep it in the department notebook; the product's own story stays in its marketing context (mkt-product-context).
- Name the department's own measures, such as reach and complaints, in the department description: ask the orchestrator with "tell_orchestrator" to set it. The pipeline report of a turn says when a department has no description.
- A new company has these rules from its start and writes its descriptions on its first turn.
