---
id: sal-work-pipeline
title: { en: "Sales pipeline of checks", ru: "Конвейер продаж" }
description: { en: "Where sales checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где продажи проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
Use this ability to choose a verification plan for an assigned commercial output or channel. Inputs are the recipient scope, account, language, approved approach, risk, channel policy and available evidence. Task gates and employee assignment determine who performs each check.

1. Describe the channel, audience, sending account, limits, approved template and segment, owner policy and measures such as replies, bounces and complaints. Keep one assigned writer for shared account state to avoid collisions; this grants no credentials.
2. Require every external message to use the server outbound gateway and published catalog sources. Consent, suppression, unsubscribe, approved claims, links, prices and daily account/domain limits must be checked. Sending credentials stay server-side.
3. Apply the authorized human approval scope: exact item or exact approach only where server policy permits it. New channels require each message reviewed in a fresh context by an independent provider. Custom prices, discounts, contract or legal terms require the authorized owner's decision. Public items always retain exact per-item approval; a human signs contracts.
4. Group internal deal review and record inspection when a shared snapshot makes them comparable. Batches or schedules for external sends require an approved approach, assignment and server policy, never this plan alone.
5. Use the owner's sampling policy only for checks eligible for sampling. Include initial messages of a new segment or sender; failed samples or rising bounces/complaints stop channel dispatch for a decision. Sampling cannot waive protected approvals.
6. Require deterministic checks to have fast tests including rejected cases. For model checks, require versioned examples labeled independently, an owner-set threshold, separate false-accept/reject counts, and new examples from real misses. Revalidate on check, prompt, list or model change. Keep company examples private; unvalidated or unavailable checks prove no pass and need authorized human assessment.

For outbound review, use the company and product scoped private example set `model-check-set:outbound_review`; never copy its examples into a template or repository.

Return checks, evidence, gaps and approval requirements. The plan imposes no turn cadence, downstream reviewer or permission to send.
