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
      - { name: "Prove the hardest shot", ownerRole: "VID-HEAD", brief: "Have the operator make a 5 to 8 second probe from the keeper's approved shot frame. Accept it with the keeper and record the result, tool and cost before making draft shots." }
      - { name: "Generate draft shots", ownerRole: "VID-GEN", echelon: "development", brief: "Start from the keeper's approved frames, repeat the same wording for the look, and use low resolution. Use independent calls to prepare shot prompts or compare takes, then run the video tools yourself." }
      - { name: "Check shot continuity", ownerRole: "VID-KEEP", echelon: "review", brief: "Check motion, sheets and markers. Return any drift for another take. Release only accepted clips to the editor." }
      - { name: "Edit the draft cut", ownerRole: "VID-EDIT", brief: "Cut the accepted shots and add sound, music, exact geometry, titles and the end card to fit the platform." }
      - { name: "Check the cut", ownerRole: "VID-QA", brief: "Check the draft against the brief and style sheet before final generation. Return problems to their owners." }
      - { name: "Generate final shots", ownerRole: "VID-GEN", brief: "Render only accepted shots. Get the keeper's yes on every new clip before the editor replaces the drafts." }
      - { name: "Accept and deliver the video", ownerRole: "VID-HEAD", brief: "Get the finished export checked by the quality reviewer, watch it at full size and check the cuts and key events frame by frame under Law 10. Commit prompts, reference frames and total cost to git and deliver the accepted video." }
  - key: video-footage-editing
    name: "Edit existing footage"
    why: "For making a finished video from footage you already have."
    stages:
      - { name: "Plan the edit", ownerRole: "VID-HEAD", brief: "Set the look and platform. Identify the hardest moment to prove with the keeper before editing the whole piece." }
      - { name: "Map the set and markers", ownerRole: "VID-BOARD", brief: "Record the measured layout and markers seen in the footage. Use them to plan the cut and any new shots." }
      - { name: "Prove the hardest edit", ownerRole: "VID-HEAD", brief: "Test the hardest edit with keeper-approved clips. The head and keeper accept the probe before the full edit." }
      - { name: "Check the footage", ownerRole: "VID-KEEP", brief: "Build the style and character sheets as needed. Check the footage against them and the set before editing. Get a new take or regenerate any shot that drifts." }
      - { name: "Edit the video", ownerRole: "VID-EDIT", brief: "Use the keeper's accepted clips. Compose and mix for the platform." }
      - { name: "Check the cut", ownerRole: "VID-QA", brief: "Check the cut against the brief and style sheet." }
      - { name: "Accept and deliver the video", ownerRole: "VID-HEAD", brief: "Accept the export under Law 10. Keep the probe and video record in git." }
  - key: video-screen-recording
    name: "Screen recording"
    why: "For showing how something works on a screen."
    stages:
      - { name: "Plan what to show", ownerRole: "VID-WRITE", brief: "Use the head's brief for the look and platform. List the actions that need to be visible and plan narration or captions." }
      - { name: "Map the set and markers", ownerRole: "VID-BOARD", brief: "Map the visible screen areas, overlay positions and points where key actions happen." }
      - { name: "Prove the hardest shot", ownerRole: "VID-HEAD", brief: "Accept the hardest moment with the keeper before making the rest." }
      - { name: "Record the screen", ownerRole: "VID-GEN", brief: "Capture the real action at the marked positions. Keep the layout, scale and wording consistent." }
      - { name: "Check shot continuity", ownerRole: "VID-KEEP", brief: "Check the shots against the style sheet and screen markers before sending them to the editor." }
      - { name: "Edit the video", ownerRole: "VID-EDIT", brief: "Use the keeper's accepted clips. Check that the story is clear with the sound off." }
      - { name: "Check the cut", ownerRole: "VID-QA", brief: "Check the cut against the brief and style sheet." }
      - { name: "Accept and deliver the video", ownerRole: "VID-HEAD", brief: "Accept the export under Law 10. Keep the probe and video record in git." }
---
