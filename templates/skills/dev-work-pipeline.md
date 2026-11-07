---
id: dev-work-pipeline
title: { en: "Development pipeline", ru: "Конвейер разработки" }
description: { en: "Where development checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где разработку проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
You can select the proportionate proof for a software result.

Start from the task, employee assignment and potential harm, rather than a fixed sequence of roles. For small work describe a bounded change and its check; shared turn review or extra metrics exist only when assigned. Protected actions and real dependencies are never removed by a fast path.

Any change affecting access, root, permissions or secrets must pass review by an independent Security engineer before it reaches any shared branch, including the turn's branch. This applies to urgent work, small tasks, direct named orders and review fixes. Self-review does not replace this gate.

Use direct fast tests for pure logic, narrow integration checks for boundaries and a few end-to-end flows for user-visible behavior. After a batch, check the affected result on one pinned commit. When a full candidate validation is assigned, give it one explicit owner, coordinate the complete required stages once and read the actual logs rather than asking each author for duplicate final metrics.

Versioned model checks need examples labelled independently, a hidden subset where practical and an acceptance threshold chosen by the authorized owner. Record false accepts and false rejects separately, and add real misses to the versioned examples. Run them when the model, prompt or examples change; until a model check has actual validation, say what it cannot prove and retain the required human decision.

Use code for reproducible totals, access refusals, schema constraints and acceptance conditions. Record exact inputs, selection scope, version, command and observed outcome. A collected graph or cached summary without applicable completed receipts is not execution evidence. A skill neither creates a tester handoff nor waives a human release approval.
