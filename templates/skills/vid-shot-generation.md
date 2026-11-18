---
id: vid-shot-generation
title: { en: "Shot generation", ru: "Генерация кадров" }
description: { en: "Makes video shots image-to-video from the keeper's reference frames with the same wording of each look, drafts first and finals only for accepted shots, and records every call.", ru: "Делает видеокадры из изображения в видео по опорным кадрам хранителя с одинаковым описанием облика, сначала черновики, чистовые только для принятых кадров, и записывает каждый вызов." }
kind: procedure
sources: []
---
You can make the shots of a video with a video model through the department's API key, so that every character keeps the look on its sheet.

1. Start every shot from its reference frame, the one the keeper approved for it, image-to-video. Never make a shot from text alone: a model given only words draws the character anew each time.
2. Put the fixed wording of the sheet of every character in the shot, and of the style sheet, into the shot's prompt word for word, then add the shot's own action and camera. Do not reword a look from one shot to the next, and add no detail the sheets do not have.
3. Keep the model, its version and the settings the same within a video. A change of model or settings is the keeper's and the head's decision, and every shot made before it is checked again.
4. Make drafts first, at the lowest resolution and length that show the motion. Make final shots only for shots the keeper accepted, from the same reference frame, wording, seed where the model takes one, and settings, at the final resolution.
5. Record every call in the department's git as it is made: the shot number, the reference frame, the whole prompt, the model and its settings, the seed, the file or link of the result and its cost. Never put the key into a record, a prompt file or a command line that is logged; pass it through an environment variable or standard input.
6. Stop and tell the head before a shot would pass the budget or the key's spend limit. A refused call is reported, never retried around.
7. When the model cannot make the motion a shot needs, report it with the shot number. A still image with a pan or a zoom is not a video shot unless the shot list asks for one.

When this stage runs as several calls at once, give each call the same reference frame and wording, so that the drafts differ only where the model chose. The keeper's yes still decides which draft goes on.
