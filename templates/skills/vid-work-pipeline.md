---
id: vid-work-pipeline
title: { en: "Video production pipeline", ru: "Конвейер видеопроизводства" }
description: { en: "How a video goes from its brief to delivery through the continuity and quality gates, with its records in git; read it when laying out work or changing a check.", ru: "Как видео идет от задания до сдачи через проверку единства облика и проверку качества, с записями в git; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
Use this ability to lay out an assigned video and choose how each of its results is checked. Inputs are the brief, its audience, length, format and language, the characters and the style it needs, the budget, the spend limit of the video generation key and the check evidence there is. The task determines the assigned owners and gates.

1. Lay the work out in this order: the brief, the script and shot list, a storyboard with one frame per shot, a character sheet for every character and one style sheet for the video, draft shots, the continuity gate, the edit, the quality gate, final shots and delivery. Record a missing input as a gap rather than inventing it.
2. The continuity gate is the keeper's. Nothing goes to editing without the keeper's yes. A shot whose character or style differs from its sheets in any detail, such as hair, a head covering and how it is tied, clothes, colours, accessories, face or proportions, is generated again from its reference frame. It is never patched in the edit or let through as close enough.
3. Shots are made image-to-video from the keeper's reference frame, never from text alone, with the same wording of each look in every shot's prompt. Drafts come first at low resolution. Finals are made only for shots the keeper accepted, from the same frame, wording and settings, and the keeper compares each final with its draft.
4. Before generation starts, set the shot count, the drafts per shot and the price per second against the budget and the key's spend limit. Generation stops before it would pass either, and the head decides what to cut. A person pays, and only the person who set a limit raises it.
5. Every shot's prompt, reference frame, model, settings, the files or links of its drafts and final, the keeper's verdict and its cost go into the department's git with the video and are committed at once. Any shot can then be made again, and the cost of each video adds up from its records.
6. The quality reviewer checks the cut against the brief and the style sheet before it goes out. A slideshow of still images is never delivered as video: when the model cannot make the motion a shot needs, say so and stop that shot.
7. Group reversible drafts where shared evidence makes comparison useful. A batch is a way to inspect shots, not a pass for each of them.
8. For model checks of continuity or quality, require a versioned set of examples with known answers labelled by someone other than their author, an owner-set threshold, separate false-accept and false-reject counts, and new examples from real misses. Revalidate when the check, its prompt or the model changes. Until a set has run for a check, that check proves nothing, and the keeper's own look at every shot stays the gate.

Return the stages, their owners, the checks, the evidence, the gaps and the budget of this video. This plan does not assign role duties beyond the task or grant spending rights.
