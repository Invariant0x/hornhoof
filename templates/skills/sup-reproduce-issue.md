---
id: sup-reproduce-issue
title: { en: "Reproduce the issue", ru: "Воспроизведение проблемы" }
description: { en: "Turns a customer's description into exact steps that make the problem happen again.", ru: "Превращает описание клиента в точные шаги, которые снова вызывают проблему." }
kind: procedure
sources: [obra/superpowers skills/systematic-debugging/SKILL.md]
---
A problem no one can reproduce cannot be fixed or proved fixed. Before reporting:

1. Collect the facts from the ticket and the customer's history: what they did, what they expected, what happened, when, on which plan, app or browser version, device, language and region. Ask the customer only for what is missing, in one message, through a reply your head approves.
2. Reproduce it in a test account or sandbox your company gave you, never in the customer's real account unless your task names that access. Start from their exact steps, then simplify.
3. Find the shortest set of steps that shows the problem every time. Note what does not matter (browser, language) as well as what does.
4. If it does not reproduce, compare your setup with the customer's, one difference at a time: plan, data size, permissions, version, time zone, language. Do not guess a cause; record what you tried.
5. Keep the evidence: screenshots, the exact error text, times with time zone, request ids the product shows. Remove personal data from anything you attach.
6. Check whether it is already known: open bug reports, recent tickets, the status page.

Then write it up with sup-bug-report. A problem you could not reproduce is still reported, marked "not reproduced", with everything you tried.
