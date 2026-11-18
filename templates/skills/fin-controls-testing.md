---
id: fin-controls-testing
title: { en: "Controls testing", ru: "Проверка контролей" }
description: { en: "Tests whether finance controls work in practice: approvals, separation of duties and access.", ru: "Проверяет, работают ли финансовые контроли на деле: согласования, разделение обязанностей и доступы." }
kind: checklist
sources: [anthropics/knowledge-work-plugins finance/skills/sox-testing/SKILL.md]
---
Each quarter, or when your head asks, test whether the controls the company relies on actually ran.

1. List the controls: spend approval, maker and checker on entries and reconciliations, separation between who approves and who pays, checks on changed bank details, access to bank and accounting systems, the period lock after close.
2. For each control, write what it should do, who runs it, and what evidence it leaves.
3. Choose the sample independently from the population, frequency, failure impact and confidence needed. Check exceptional high-risk items individually.
4. For each item, check the evidence: the approval exists, came before the payment or posting, was given by someone with the authority, and that person did not also make or pay it.
5. Check access lists: who can pay, post and change bank details. Anyone who has left and still has access is a finding.
6. Rate each control: works, works with exceptions (list them), or fails.
7. For each failure, recommend a fix and say what risk stays open until then.

Report to your head. The people who run a control own its fix, not you.

During this check, do not edit the records, controls or access being checked. Agents never post entries, make payments or file returns. Any figures released outside the company need a separate checker to rebuild the key numbers from source records with SQL or a script and confirm they match.
