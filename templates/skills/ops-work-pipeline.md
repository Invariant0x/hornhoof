---
id: ops-work-pipeline
title: { en: "Operations pipeline", ru: "Конвейер операций" }
description: { en: "Where operations checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где операции проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
Plan verification for the operations work named in the assignment. Use the change's blast radius, reversibility, shared state and actual task gates to choose checks; skill selection assigns no executor, reviewer or turn cadence.

1. Describe the affected users, machines or accounts, approved change, rollback and observable success. Keep this scope with the task's evidence.
2. Keep item-level approval for spending, irreversible actions and other protected human decisions; access to another department the orchestrator or Operations grants without one. Access, root, permissions or secrets changes require an independent Security engineer's pass on the exact candidate before shared merge, including urgent, small, named work and review fixes.
3. Group repeated reversible changes only when their risks, rollback and checks are genuinely shared. Choose a user-side sample and coverage before the batch starts. A failed check triggers the approved rollback before investigation.
4. Prefer measured node state and scripted assertions for deterministic checks. Test each code check with valid and rejected cases. An unavailable automated check stays explicitly unproved and needs the manual check assigned by the task.
5. For model-based configuration or vendor checks, use versioned examples labelled by someone other than the check's author, with the responsible owner's threshold. Run them when the check, prompt, lists or model changes; count false accepts and false rejects separately. Unvalidated checks cannot establish approval. Add real misses to the examples.
6. Return a verification plan naming scope, check owner, exact candidate, command or procedure, evidence, rollback triggers and gaps. If the task requires an independent checker, that checker does not edit the item under review.

Use the company's approved evidence location and measures, such as failed changes and restoration time. Do not create recurring work, assign staff or change publication and approval routes merely by selecting this ability.
