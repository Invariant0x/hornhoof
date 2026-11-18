---
department: video_production
default: video-production
pipelines:
  - key: video-production
    name: "Video production"
    why: "For making an original video from a brief."
    stages:
      - { name: "Write the brief", ownerRole: "VID-HEAD", brief: "Set purpose, audience, medium, look, required capture, destination and order spending limit. Name the photography and production design leads where needed, involve sound early and assign checks. Check tool access, included credits, terms and costs on the day." }
      - { name: "Write the story and script", ownerRole: "VID-WRITE", brief: "Draft one story line or viewer task, beats, scene objectives and linked setups and payoffs. Get the director's acceptance of the story and script." }
      - { name: "Plan the shots and draw the storyboard", ownerRole: "VID-BOARD", brief: "Work with photography, the operator and editor on the shot list and coverage. Show blocking, framing, lenses, camera moves and intended cuts. Play timed boards with scratch sound where timing matters. Get the director's acceptance." }
      - { name: "Make character and style sheets", ownerRole: "VID-KEEP", brief: "Keep the director's approved look book, character sheets and shot references from design and photography. Record their versions and the details that must hold." }
      - { name: "Build the set and markers", ownerRole: "VID-BOARD", brief: "Map paths, viewpoints, camera sides and light sources. Give the keeper the set plan with eyelines and action states to match." }
      - { name: "Prove the hardest shot", ownerRole: "VID-HEAD", brief: "Assign the probe and keeper's check. Play the join with sound when a cut is the risk. Compare methods on the same evidence within budget when uncertain. Record the accepted probe, look reference, route, model, settings, cost and fallback." }
      - { name: "Make or capture draft shots", ownerRole: "VID-GEN", echelon: "development", brief: "Use the approved method and route with the selected settings and spending limit. For generation, read the model's prompt guide and use approved references or accepted frames as needed. Give the keeper exact takes and the director the usable choices." }
      - { name: "Check shot continuity", ownerRole: "VID-KEEP", echelon: "review", brief: "Record the exact take decision on the continuity sheet with any reason for a director-approved break. Assign repairs to the production owner and give the editor the accepted clips and usable ranges." }
      - { name: "Edit the draft cut", ownerRole: "VID-EDIT", brief: "Assemble the accepted shots and make a rough cut. Label temporary sound. Use music, exact geometry, titles and an end card only where the brief needs them. Leave versioned review notes with the director's choices and any missing coverage." }
      - { name: "Check the cut", ownerRole: "VID-QA", brief: "Watch the rough cut at normal speed and check it against the brief and approved references. Return specific problems to their owners. The director agrees the rough-cut direction and decides what the edit still needs." }
      - { name: "Prepare final shots and required pickups", ownerRole: "VID-GEN", brief: "Keep accepted drafts and recordings that meet delivery needs. Prepare only the finals or pickups the checked edit still needs, using the quality mode for accepted shots that need a full render. Assign acceptance of each replacement to the keeper before it enters the cut." }
      - { name: "Accept and deliver the video", ownerRole: "VID-HEAD", brief: "Review the fine cut with notes and lock picture. Assign finishing across the cut under Law 10 and have the editor export the master. With the quality reviewer, play the exact exported master at normal speed under Law 11. Recheck any corrected export. Record the accepted version, prompts, references and cost in git and deliver the accepted master." }
  - key: video-long-work
    name: "Long video production"
    why: "For a film, a series or a work with many scenes or places."
    stages:
      - { name: "Write the brief", ownerRole: "VID-HEAD", brief: "Set purpose, audience, medium, look, required capture, destination and order spending limit for the whole work. Name the lead keeper and crew leads, including sound. Check tool access, included credits, terms and costs on the day." }
      - { name: "Write the story", ownerRole: "VID-WRITE", brief: "Draft and revise the premise, beats, scene objectives and linked setups and payoffs. The director approves the story line and script that each scene will use." }
      - { name: "Keep the production guide", ownerRole: "VID-KEEP", brief: "Keep one versioned production bible with the approved story, character sheets, sets with markers, look book, color script and sound palette. Publish agreed revisions for the scene keepers." }
      - { name: "Break down sequences and scenes", ownerRole: "VID-PM", brief: "Record the production owners, story links and dependencies. Give each scene its objective and the relevant characters, sets, markers and references." }
      - { name: "Prove the hardest moment", ownerRole: "VID-HEAD", brief: "Accept the probe with the lead keeper and set the shared baseline with the colorist. Record the references, authorized routes, models, settings, cost and fallback. Prove any materially different risk before making that sequence." }
      - { name: "Make the scenes", ownerRole: "VID-PM", brief: "Run each scene as its own task, in parallel with the other scenes. Use video-production from the scene script through the keeper's gate and the scene edit. Use the bible's approved story, sheets, sets and look references. Send proposed story and performance changes and other departures to the lead keeper and the director. Give the agreed revision to every affected scene, including any linked setup or payoff." }
      - { name: "Assemble and lock the cut", ownerRole: "VID-EDIT", brief: "Assemble accepted scene edits and review story and performance in the rough cut. Order only the finals or pickups the edit needs, with the keeper's check. Review the fine cut for timing and joins, leave notes on each pass and get the director's picture lock." }
      - { name: "Finish and export the master", ownerRole: "VID-COLOR", brief: "Finish the whole work under Law 10. The colorist grades against the color script, the sound designer makes the final mix and the editor finishes picture and any titles and captions. The editor exports the master in the agreed formats after the specialists confirm their work on that version." }
      - { name: "Check the whole work", ownerRole: "VID-QA", brief: "With the director, play the exact exported master at normal speed in the intended conditions under Law 11. Check framing, sound, sync, captions where used and the ending against the brief, bible and look references. Use frame stepping for specific defects. Return any failure to its owner and recheck the corrected export." }
      - { name: "Deliver the accepted master", ownerRole: "VID-HEAD", brief: "Record the quality verdict and the director's acceptance for the exact master. Deliver it in the agreed formats and keep the master and work record in the department's repository." }
  - key: video-footage-editing
    name: "Edit existing footage"
    why: "For making a finished video from footage you already have."
    stages:
      - { name: "Plan the edit", ownerRole: "VID-HEAD", brief: "Set the look and platform. Identify the hardest moment to prove with the keeper before editing the whole piece." }
      - { name: "Map the set and markers", ownerRole: "VID-BOARD", brief: "Map the space and markers that affect continuity in the footage." }
      - { name: "Check the footage", ownerRole: "VID-KEEP", brief: "Prepare relevant references and record the keeper's decisions on the clips needed for the probe and cut. Assign replacement work where needed." }
      - { name: "Prove the hardest edit", ownerRole: "VID-HEAD", brief: "Assign a probe using the checked source clips. Record the head and keeper's acceptance and the look reference." }
      - { name: "Edit the video", ownerRole: "VID-EDIT", brief: "Use the keeper's accepted clips. Compose and mix for the platform." }
      - { name: "Check the cut", ownerRole: "VID-QA", brief: "Check the cut against the brief and style sheet." }
      - { name: "Accept and deliver the video", ownerRole: "VID-HEAD", brief: "Lock the cut and have the assigned owners finish it under Law 10. Have the editor export it. With the quality reviewer, play the exact exported master at normal speed under Law 11. Recheck any corrected export and deliver the accepted master. Keep the probe and video record in git." }
  - key: video-screen-recording
    name: "Screen recording"
    why: "For showing how something works on a screen."
    stages:
      - { name: "Plan what to show", ownerRole: "VID-WRITE", brief: "Use the head's brief for the look and platform. List the actions that need to be visible and plan narration or captions." }
      - { name: "Map the set and markers", ownerRole: "VID-BOARD", brief: "Map the visible screen areas, overlay positions and points where key actions happen." }
      - { name: "Prove the hardest shot", ownerRole: "VID-HEAD", brief: "Accept the hardest moment with the keeper and set the look reference before making the rest." }
      - { name: "Record the screen", ownerRole: "VID-GEN", brief: "Capture the real action at the marked positions. Keep the layout, scale and wording consistent." }
      - { name: "Check shot continuity", ownerRole: "VID-KEEP", brief: "Check the shots against the style sheet and screen markers before sending them to the editor." }
      - { name: "Edit the video", ownerRole: "VID-EDIT", brief: "Use the keeper's accepted clips. Check that the actions are clear in the agreed playback conditions." }
      - { name: "Check the cut", ownerRole: "VID-QA", brief: "Check the cut against the brief and style sheet." }
      - { name: "Accept and deliver the video", ownerRole: "VID-HEAD", brief: "Lock the cut and have the assigned owners finish it under Law 10. Have the editor export it. With the quality reviewer, play the exact exported master at normal speed under Law 11. Recheck any corrected export and deliver the accepted master. Keep the probe and video record in git." }
---
