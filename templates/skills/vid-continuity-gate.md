---
id: vid-continuity-gate
title: { en: "Character and style continuity", ru: "Единство персонажей и стиля" }
description: { en: "Keeps a sheet for every character and one style sheet for each video, and lets a shot go to editing only when it matches them in every detail.", ru: "Ведет лист на каждого персонажа и один лист стиля на каждое видео и пускает кадр в монтаж, только когда он совпадает с ними во всем." }
kind: gate
sources: []
---
You can keep every character looking the same and every video in one style from shot to shot, and stop any shot that does not.

**The character sheet.** One for each character, kept in the department's git and used by every video the character appears in:
- reference frames from the front, the side and the back, on a plain background in even light;
- hair: colour, length, parting and how it is worn;
- head covering: what it is, its colour and pattern, how it is tied or worn and where its ends fall;
- clothes layer by layer, with colours, patterns, fit and how each is fastened;
- colours, named the same way every time, with a colour code where the picture gives one;
- accessories: what they are, where on the body and on which side;
- face: shape, eyes, brows, nose, mouth, skin and any marks;
- proportions: height next to the other characters, head to body and build;
- one fixed wording of the look, a short paragraph that every shot's prompt uses word for word.
Other clothes or another look is a new version of the sheet with its own frames, and the shot list names the version each shot uses.

**The style sheet.** One for each video: the kind of picture (drawn, filmed or rendered), the palette, the light, the lens and framing, the speed of motion and camera, texture and grain, the aspect ratio, the resolution of drafts and finals, and a fixed wording of its own for the prompts.

**Reference frames.** For each shot, approve the frame it starts from: the storyboard frame checked against the sheets, or a frame you make from them. Generation starts from that frame and no other.

**The gate.** Nothing goes to editing without your yes. Check every draft against its sheets at its start, its middle and its end, and wherever a character turns or moves: every item of each character's sheet, and the style. A shot that differs in any detail, a head covering tied another way, a colour shifted, an accessory on the other side, a face that changed, is rejected and generated again from its reference frame with the same wording. It is never fixed in the edit and never accepted as close enough. Record each verdict in git with the shot number, the version of each sheet and, for a rejection, the exact difference.

**Final shots.** Compare each final shot with its accepted draft. A final keeps the draft's look in every detail, or it is made again.

When you check a shot you made yourself, read it cold, as if another had made it; your own check replaces no stage of a route.
