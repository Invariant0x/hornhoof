---
id: home-work-pipeline
title: { en: "Home pipeline", ru: "Конвейер дома" }
description: { en: "Where the home departments check item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где домашние отделы проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
How work moves through the home devices and household departments, which serve one family. Check each item only where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Everything else goes in a batch, with a sample on top. The department owner is the person named for this department, or the CEO when there is none.

## Item by item

- Every physical action waits for the approval of a person, every time (home-real-world-approval): a changed setting, a device or scene switched, a purchase or payment, a lock, a recording read or moved.
- When you are not sure whether something acts on the real home, treat it as an action.

## In a batch

- Reading and suggesting need no approval. What the department proposes is gathered into one clear request, and the person still approves each action in it.
- Lists of bills, supplies, chores and devices are gone through together when a list is due.

## By sample

- Compare a sample of the home's records, such as devices on the network, bills or supplies, with what the device, the statement or a person shows. A wrong entry means going through that whole list.

## By code

- Totals, next dates, price rises, double charges, unknown devices on the network and calendar clashes are computed, not estimated.
- Each code check has fast tests, including cases it must reject. A check named here that your tools do not run yet stays with a person, item by item, until they do.

## By a model

- A suggestion a model makes decides nothing here and has no example set yet: it reaches a person as a suggestion.
- A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets. Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart. Every miss found in real work becomes a new example. Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass. An action that cannot be undone keeps its approval item by item, whatever a set shows.

## Descriptions and measures

- HOM-HEAD writes a short description of the network and devices, and HHD-HEAD of the supplies, bills and calendar, on their first turn: what they hold, who approves and where the checks above stand. Keep it in the department notebook, private to the home.
- Name the department's own measures, such as reminders in time and requests waiting for a person, in the department description: ask the orchestrator with "tell_orchestrator" to set it. The pipeline report of a turn says when a department has no description.
- A new company has these rules from its start and writes its descriptions on its first turn.
