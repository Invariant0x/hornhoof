---
department: marketing
default: marketing-campaigns
pipelines:
  - key: marketing-campaigns
    name: "Marketing work"
    why: "For a campaign, announcement or a piece of content."
    stages:
      - { name: "Choose the audience and goal", ownerRole: "MKT-HEAD" }
      - { name: "Draft the message", ownerRole: "MKT-WRITE", echelon: "development" }
      - { name: "Check voice and facts", ownerRole: "MKT-EDIT", echelon: "review" }
      - { name: "Publish and measure", ownerRole: "MKT-SOCIAL" }
  - key: marketing-daily-series
    name: "Daily signed content"
    why: "For a daily series published in a person’s name with their agreement."
    stages:
      - { name: "Research the next topic", ownerRole: "MKT-SEO", brief: "Keep source links and use only figures you can verify." }
      - { name: "Draft several versions", ownerRole: "MKT-WRITE", echelon: "development", oneShot: {"fanOut": 3, "judge": "Choose a draft in the author’s voice that serves the series and uses supported facts."} }
      - { name: "Review voice and facts", ownerRole: "MKT-EDIT", echelon: "review", brief: "Read the draft in the author’s voice and check every factual claim against its source." }
      - { name: "Publish from the phone", ownerRole: "MKT-SOCIAL", brief: "Use the channel’s own app on a company phone. Sign in from the vault. Read before acting and space actions out at a human pace." }
      - { name: "Measure the series", ownerRole: "MKT-PM", handoffTo: [sales] }
  - key: marketing-news-videos
    name: "Short news videos"
    why: "For making short videos from verified news or product updates."
    stages:
      - { name: "Plan the video", ownerRole: "MKT-HEAD", handoffTo: [video_production], brief: "Follow vid-laws. Give Video production the verified facts, look, platform and brief when the company has that department. Marketing owns publication. Otherwise name one keeper and run the following production stages in Marketing." }
      - { name: "Write the script", ownerRole: "MKT-WRITE", echelon: "development", oneShot: {"fanOut": 3, "judge": "Pick the clearest short script that sticks to verified facts."} }
      - { name: "Record the voice", ownerRole: "MKT-WRITE", brief: "Plan sound with the first shots and record the narration." }
      - { name: "Prepare the shots", ownerRole: "MKT-SOCIAL", brief: "Prepare the storyboard and style and character sheets with the keeper. Build the measured set and markers before making the probe. Get the head and keeper to accept the probe and set the look reference, then make low-resolution drafts from the keeper's reference frames for any generated shots." }
      - { name: "Check shot continuity", ownerRole: "MKT-EDIT", echelon: "review", brief: "The keeper checks every shot against the brief, sheets and measured set before editing. Remake any shot that drifts or plays as a still." }
      - { name: "Render the video", ownerRole: "MKT-SOCIAL", brief: "Edit and check the accepted drafts before generating any final shots. Get the keeper to accept new clips before using them in the edit. Finish color, sound and titles across the whole cut against the probe's look reference under Law 10, with one owner for each. Keep prompts, reference frames and costs in git." }
      - { name: "Review the result", ownerRole: "MKT-EDIT", brief: "Check the brief and style sheet, rights to images and sound, facts, captions and playback. The head accepts the finished cut under Law 11 before publication." }
      - { name: "Publish the video", ownerRole: "MKT-SOCIAL" }
  - key: marketing-press-pool
    name: "Press outreach"
    why: "For building a press list and pitching one story to relevant outlets."
    stages:
      - { name: "Build the media list", ownerRole: "MKT-SEO", brief: "Keep sources and each outlet’s published contact channel." }
      - { name: "Write the pitch", ownerRole: "MKT-WRITE", echelon: "development" }
      - { name: "Check the pitch and facts", ownerRole: "MKT-EDIT", echelon: "review" }
      - { name: "Send and follow up", ownerRole: "MKT-SOCIAL" }
---
