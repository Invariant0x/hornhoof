---
id: sal-work-pipeline
title: { en: "Sales pipeline of checks", ru: "Конвейер продаж" }
description: { en: "Where sales checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где продажи проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
Use this ability to choose a verification plan for an assigned commercial output or channel. Inputs are the people to write to, the mailbox or account, language, approach, risk and available evidence. Task gates and employee assignment determine who performs each check.

1. Describe the channel, audience, mailbox or account, the provider's limits and measures such as replies, bounces and complaints. Keep one writer per mailbox at a time to avoid collisions.
2. Check claims, links, prices and "do not write" marks against the department's own records before a message goes, and keep to the provider's daily limits; every contact is marked in the department's git at once and committed. Sign-ins stay in the vault.
3. The first messages of a new channel get a second read by another employee in a fresh context. Custom prices and discounts go by the department's price rule. Every message, public items too, waits for nobody unless its department set an approval rule or its own check stopped it; a human signs contracts.
4. Group internal deal review and record inspection when a shared snapshot makes them comparable. Batches or schedules for external sends require an assignment, never this plan alone.
5. Rising bounces or complaints stop the sending until the head has looked at them.
6. Require deterministic checks to have fast tests including rejected cases. For model checks, require versioned examples labeled independently, an owner-set threshold, separate false-accept/reject counts, and new examples from real misses. Revalidate on check, prompt, list or model change. Keep company examples private; unvalidated or unavailable checks prove no pass and need authorized human assessment.

Return checks, evidence, gaps and any approval rule the department set. The plan imposes no turn cadence, downstream reviewer or permission to send.
