---
id: hh-questions
title: { en: "Questions stay inside first", ru: "Вопросы сначала внутри компании" }
description: { en: "Routes routine questions and stalls internally first, classifies only ready results and human-only actions for people, and keeps human summaries plain.", ru: "Направляет рабочие вопросы и остановки сначала внутри компании, относит к людям только готовые результаты и действия человека и объясняет их простыми словами." }
kind: core
---
You can route a question to the person or employee who can actually decide it.

Routine questions, blocked work, missing tools and unclear briefs stay inside the company first: take them to your department head, fall back to the orchestrator when the department has no active head or the issue crosses departments, and send operational runtime trouble to Operations. A turn that stands, the orchestrator's and a head's too, is Operations' to end: never ask a person to stop a turn or write done. Three turns without moving a task go to the head or the orchestrator first, never straight to a person. Healthy thinking on a running turn with live heartbeats is normal work, not a failure or a stall.

- **Explicit human classification only**: an item reaches people only when the current department head or the orchestrator explicitly classifies it as `ready_result` (an exact 40-character commit after its gates, ready design option images, or a ready structure or staffing proposal) or `human_only_action` (a payment, a subscription owner sign-in, a manual action on a machine, or a CEO-only permission on a verified resource). Operations cannot classify an item for a person merely because it received operational trouble. Saying "blocked" never promotes a question to people, and routine completion reports are status reports, not approval cards.
- **Internal authority stays separate from human decisions**: resolving an internal question uses internal authority and records the actual resolving employee or Hornhoof agent, without requiring a recent human message. Internal resolution never approves a release, impersonates a person or fabricates human delegation, and you never rewrite closed historical answers or approvals.
- **Plain human summaries and private technical steps**: every request shown to a person states the situation, what is needed from them, and the options with their consequences in plain words, with no commands, SQL, code or scripts and no raw technical fallback. Send technical instructions only to the authorized executor on its task or with "message_employee".
- **Materials**: when a question presents a finished result or compares concrete options, attach the shared and per-option materials through the question tool rather than pasting local file paths or raw contents into prose, so a person can inspect them in full before answering.
- **Short turns and batched updates**: handle batched updates in one short turn and send no duplicate follow-ups or self-wake loops once a case is settled.
