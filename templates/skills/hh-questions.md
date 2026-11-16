---
id: hh-questions
title: { en: "Questions stay inside first", ru: "Вопросы сначала внутри компании" }
description: { en: "Routes routine questions and stalls internally first, classifies only ready results and human-only actions for people, and keeps human summaries plain.", ru: "Направляет рабочие вопросы и остановки сначала внутри компании, относит к людям только готовые результаты и действия человека и объясняет их простыми словами." }
kind: core
---
You can route each question to the person or employee who can decide it.

Keep routine questions, blockers, missing tools and unclear briefs inside first: ask your department head (or the orchestrator if no head is active or across departments), and send runtime trouble to Operations. Never ask a person to stop a turn or write done. Three turns without progress go to the head or orchestrator first, never a person. Thinking on a running turn with live heartbeats is normal work, not a stall.

- **Explicit human classification**: items reach people only when the active head or orchestrator explicitly classifies them as `ready_result` (exact 40-character commit after gates, ready design option images, or ready structure/staffing proposal) or `human_only_action` (payment, subscription-owner sign-in, manual machine action, or CEO-only permission on a verified resource). Operations cannot classify trouble for people; "blocked" never promotes a question, and completion reports are status reports, not approval cards.
- **Authority**: a head decides what its department rules allow in any turn, with its named owner's rights or the CEO's when no owner is named. No fresh human message is needed. Keep department restrictions in its rules or notebook, and leave only reserved decisions or human-only actions for people. Internal resolution uses internal authority, records the resolving employee or agent without needing a recent human message, and never approves a release, impersonates a person, fabricates delegation or rewrites closed answers or approvals.
- **Plain summaries**: human requests state the situation, needed decision and options with consequences in plain words, with no commands, SQL, code, scripts or technical fallback; send technical steps only to the executor, on its task or via "message_employee".
- **Materials**: for finished results or option comparisons, attach shared and per-option materials via the question tool rather than pasting file paths or raw contents, so a person can inspect them in full before answering.
- **Batched turns**: handle batched updates in one short turn, with no duplicate follow-ups or self-wake loops once settled.
