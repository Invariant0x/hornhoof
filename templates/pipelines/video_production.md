---
department: video_production
default: video-production
pipelines:
  - key: video-production
    name: "Video production"
    why: "For a video from a brief to delivery, with every character keeping one look from shot to shot."
    stages:
      - { name: "Take the brief", ownerRole: "VID-HEAD", brief: "Write down the goal, audience, length, format, language, budget and the spend limit of the video generation key." }
      - { name: "Write the script and shot list", ownerRole: "VID-SCRIPT" }
      - { name: "Draw the storyboard", ownerRole: "VID-BOARD", brief: "One frame for each shot of the shot list, drawn from the character and style sheets." }
      - { name: "Make the character and style sheets", ownerRole: "VID-KEEP", brief: "A sheet for every character with reference frames from the front, the side and the back, and one style sheet for this video." }
      - { name: "Generate draft shots", ownerRole: "VID-GEN", echelon: "development", brief: "Image-to-video from the keeper's reference frame, never from text alone, with the same wording of each look in every prompt. Low resolution." }
      - { name: "Check continuity", ownerRole: "VID-KEEP", echelon: "review", brief: "Nothing goes to editing without the keeper's yes. A shot that differs from its sheets in any detail is generated again." }
      - { name: "Edit the cut", ownerRole: "VID-EDIT" }
      - { name: "Check quality", ownerRole: "VID-QA", echelon: "tests", brief: "Check the cut against the brief and the style sheet before delivery." }
      - { name: "Make final shots", ownerRole: "VID-GEN", brief: "Only shots the keeper accepted, from the same reference frame, wording and settings. The keeper compares each final with its draft." }
      - { name: "Deliver the video", ownerRole: "VID-HEAD", brief: "A video file, never a slideshow of still images. Prompts, reference frames and the cost of the video are in git.", handoffTo: [marketing] }
  - key: video-short-clip
    name: "Short clip"
    why: "For one short clip with characters whose sheets are already made."
    stages:
      - { name: "Take the brief", ownerRole: "VID-HEAD" }
      - { name: "Write the shot list", ownerRole: "VID-SCRIPT" }
      - { name: "Generate draft shots", ownerRole: "VID-GEN", echelon: "development", oneShot: {"fanOut": 3, "judge": "Name the draft of each shot that matches its reference frame and sheets in every detail, and list each difference in the others."} }
      - { name: "Check continuity", ownerRole: "VID-KEEP", echelon: "review" }
      - { name: "Edit the clip", ownerRole: "VID-EDIT" }
      - { name: "Check quality", ownerRole: "VID-QA", echelon: "tests" }
      - { name: "Deliver the clip", ownerRole: "VID-HEAD" }
  - key: video-character-sheet
    name: "Character sheet"
    why: "For setting up a new character or a new look before it appears in any shot."
    stages:
      - { name: "Describe the look", ownerRole: "VID-KEEP", brief: "Hair, head covering and how it is worn, clothes, colours, accessories, face, proportions and one fixed wording of the look." }
      - { name: "Draw reference frames", ownerRole: "VID-BOARD", echelon: "development", oneShot: {"fanOut": 3, "judge": "Choose the front, side and back frames that match the written look in every detail and match each other."} }
      - { name: "Make test shots", ownerRole: "VID-GEN" }
      - { name: "Check the sheet", ownerRole: "VID-QA", echelon: "tests", brief: "The test shots keep the look of the reference frames in every detail." }
      - { name: "Accept the sheet", ownerRole: "VID-HEAD" }
  - key: video-reshoot
    name: "Shot fix"
    why: "For a shot whose character or style differs from its sheets, found before or after delivery."
    stages:
      - { name: "Name the difference", ownerRole: "VID-KEEP" }
      - { name: "Generate the shot again", ownerRole: "VID-GEN", echelon: "development", oneShot: {"fanOut": 3, "judge": "Name the new draft that matches the reference frame and sheets in every detail, and list each difference in the others."} }
      - { name: "Check the new shot", ownerRole: "VID-KEEP", echelon: "review" }
      - { name: "Swap it into the cut", ownerRole: "VID-EDIT" }
      - { name: "Check the cut again", ownerRole: "VID-QA", echelon: "tests" }
---
