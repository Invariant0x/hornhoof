---
department: video_production
default: video-production
pipelines:
  - key: video-production
    name: "Video production"
    why: "For making an original video from a brief."
    stages:
      - { name: "Write the brief", ownerRole: "VID-HEAD", brief: "Name the look, platform, audience, purpose and budget. Plan sound from the first shot. Use vid-work-pipeline to set up video service access where needed." }
      - { name: "Write the script and shot list", ownerRole: "VID-WRITE", brief: "Show each key event in motion within a shot." }
      - { name: "Draw the storyboard", ownerRole: "VID-BOARD", brief: "Use one sketch per planned shot to explain action and camera under Law 2." }
      - { name: "Make character and style sheets", ownerRole: "VID-KEEP", brief: "Record the chosen look and the details, measurements and views that must hold." }
      - { name: "Build the set and markers", ownerRole: "VID-BOARD", brief: "Measure every place and mark paths, camera positions and key events. Give the keeper marked views for the shot reference frames." }
      - { name: "Prove the hardest shot", ownerRole: "VID-HEAD", brief: "Have the operator make a 5 to 8 second probe from text or from a first frame in the brief's look that the keeper accepted. Accept it with the keeper, set the look reference, and record the result, tool and cost before making draft shots." }
      - { name: "Generate draft shots", ownerRole: "VID-GEN", echelon: "development", brief: "Start from text or from first frames in the brief's look that the keeper accepted, never from a sketch or a set render. Repeat the same wording for the look and use low resolution. Use independent calls to prepare shot prompts or compare takes, then run the video tools yourself." }
      - { name: "Check shot continuity", ownerRole: "VID-KEEP", echelon: "review", brief: "Check motion, sheets and markers. Return any drift for another take. Release only accepted clips to the editor." }
      - { name: "Edit the draft cut", ownerRole: "VID-EDIT", brief: "Cut the accepted shots and add sound, music, exact geometry, titles and the end card to fit the platform." }
      - { name: "Check the cut", ownerRole: "VID-QA", brief: "Check the draft against the brief and style sheet before final generation. Return problems to their owners." }
      - { name: "Generate final shots", ownerRole: "VID-GEN", brief: "Render only accepted shots. Get the keeper's yes on every new clip before the editor replaces the drafts." }
      - { name: "Accept and deliver the video", ownerRole: "VID-HEAD", brief: "Have the assigned owners finish color, sound and titles across the cut under Law 10. Get the finished cut checked by the quality reviewer, then watch it at full size and check the cuts and key events frame by frame under Law 11. Commit prompts, reference frames and total cost to git and deliver the accepted video." }
  - key: video-long-work
    name: "Long video production"
    why: "For a film, a series or a work with many scenes or places."
    stages:
      - { name: "Write the brief", ownerRole: "VID-HEAD", brief: "Set the purpose, audience, look, platform and budget once for the whole work. Name one lead keeper for its shared sheets and sets." }
      - { name: "Write the story and make a production guide", ownerRole: "VID-KEEP", brief: "Keep one production bible for the whole work. Bring together the writer's story and character sheets, every place as a measured set with markers, the look book and color script from the colorist, and the sound palette from the sound designer." }
      - { name: "Break down sequences and scenes", ownerRole: "VID-PM", brief: "Break the story into sequences and scenes. Note which characters, sets, markers and references each scene uses." }
      - { name: "Prove the hardest moment", ownerRole: "VID-HEAD", brief: "Make one probe of the hardest moment for the whole work under Law 8. Accept it with the lead keeper and set the look reference with the colorist: reference frames for each scene and the color script for planned changes." }
      - { name: "Make the scenes", ownerRole: "VID-PM", brief: "Run each scene as its own task, in parallel with the other scenes. Use video-production from the scene script through the keeper's gate and the scene edit. Use only the bible's sheets, sets and look reference. A scene never changes the bible. Send a proposed change to the lead keeper and the head, then give the agreed change to every scene it touches." }
      - { name: "Assemble the cut", ownerRole: "VID-EDIT", brief: "Put the accepted scene edits together in story order. Check how the sequences and scenes play together." }
      - { name: "Finish color, sound and titles", ownerRole: "VID-COLOR", brief: "Finish the whole assembled work together against the look reference under Law 10. The colorist grades color, contrast and grain against the color script, the sound designer makes the final mix, and the editor finishes titles." }
      - { name: "Check the whole work", ownerRole: "VID-QA", brief: "Check the whole work against the brief, bible and look reference. The head watches it at full size and checks every cut and key event frame by frame under Law 11. Return any failure to its owner before mastering." }
      - { name: "Prepare and deliver the final version", ownerRole: "VID-HEAD", brief: "Make the master from the accepted cut and deliver it in the agreed formats. Keep the master and the work record in the department's repository." }
  - key: video-footage-editing
    name: "Edit existing footage"
    why: "For making a finished video from footage you already have."
    stages:
      - { name: "Plan the edit", ownerRole: "VID-HEAD", brief: "Set the look and platform. Identify the hardest moment to prove with the keeper before editing the whole piece." }
      - { name: "Map the set and markers", ownerRole: "VID-BOARD", brief: "Record the measured layout and markers seen in the footage. Use them to plan the cut and any new shots." }
      - { name: "Prove the hardest edit", ownerRole: "VID-HEAD", brief: "Test the hardest edit with keeper-approved clips. The head and keeper accept the probe and set the look reference before the full edit." }
      - { name: "Check the footage", ownerRole: "VID-KEEP", brief: "Build the style and character sheets as needed. Check the footage against them and the set before editing. Get a new take or regenerate any shot that drifts." }
      - { name: "Edit the video", ownerRole: "VID-EDIT", brief: "Use the keeper's accepted clips. Compose and mix for the platform." }
      - { name: "Check the cut", ownerRole: "VID-QA", brief: "Check the cut against the brief and style sheet." }
      - { name: "Accept and deliver the video", ownerRole: "VID-HEAD", brief: "Have the assigned owners finish color, sound and titles across the cut under Law 10, then accept it under Law 11 and deliver it. Keep the probe and video record in git." }
  - key: video-screen-recording
    name: "Screen recording"
    why: "For showing how something works on a screen."
    stages:
      - { name: "Plan what to show", ownerRole: "VID-WRITE", brief: "Use the head's brief for the look and platform. List the actions that need to be visible and plan narration or captions." }
      - { name: "Map the set and markers", ownerRole: "VID-BOARD", brief: "Map the visible screen areas, overlay positions and points where key actions happen." }
      - { name: "Prove the hardest shot", ownerRole: "VID-HEAD", brief: "Accept the hardest moment with the keeper and set the look reference before making the rest." }
      - { name: "Record the screen", ownerRole: "VID-GEN", brief: "Capture the real action at the marked positions. Keep the layout, scale and wording consistent." }
      - { name: "Check shot continuity", ownerRole: "VID-KEEP", brief: "Check the shots against the style sheet and screen markers before sending them to the editor." }
      - { name: "Edit the video", ownerRole: "VID-EDIT", brief: "Use the keeper's accepted clips. Check that the story is clear with the sound off." }
      - { name: "Check the cut", ownerRole: "VID-QA", brief: "Check the cut against the brief and style sheet." }
      - { name: "Accept and deliver the video", ownerRole: "VID-HEAD", brief: "Have the assigned owners finish color, sound and titles across the cut under Law 10, then accept it under Law 11 and deliver it. Keep the probe and video record in git." }
---
