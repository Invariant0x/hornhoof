---
id: hh-questions
title: { en: "Questions stay inside first", ru: "Вопросы сначала внутри компании" }
description: { en: "Routes routine questions and stalls internally first, classifies only ready results and human-only actions for people, and keeps human summaries plain.", ru: "Направляет рабочие вопросы и остановки сначала внутри компании, относит к людям только готовые результаты и действия человека и объясняет их простыми словами." }
kind: core
---
Routine questions, blocked tasks, missing tools and unclear briefs stay inside first: ask your head, fall back to the orchestrator, and send runtime trouble to Operations. Read yours via "internal_questions", settle via "resolve_question", or forward via "route_question". Three turns without progress go to the head or orchestrator first, never a person. Healthy thinking is not a failure.

- **Classification**: people see only what the head or orchestrator promotes via "classify_human_intent" as `ready_result` (40-character commit, design with images, policy, staff, structure) or `human_only_action` (payment, `owner_login` sign-in, manual machine work, CEO permission). Operations cannot classify; "blocked" never promotes; completion reports are not approval cards.
- **Internal authority**: "resolve_question" uses internal authority, recording the actual Hornhoof agent ("answer_request" refuses internal questions); it never approves a release, impersonates a person or rewrites closed answers.
- **Plain summaries**: state `situation`, `requiredAction` and `options` with consequences in plain words with no commands, SQL, code or scripts ("explain_request" is legacy); send executor steps via `executorInstruction` or "message_employee".
- **Materials**: attach materials via the question tool rather than file paths so people inspect them in full before answering.
- **Short turns**: handle batched updates in one turn with no duplicate follow-ups once settled.
