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
      - { name: "Write the script", ownerRole: "MKT-WRITE", echelon: "development", oneShot: {"fanOut": 3, "judge": "Pick the clearest short script that sticks to verified facts."} }
      - { name: "Record the voice", ownerRole: "MKT-WRITE" }
      - { name: "Render the video", ownerRole: "MKT-SOCIAL", brief: "Where the company has Video production, it makes the video. Otherwise make each shot image-to-video from a reference frame checked against the character and style sheets, with the same wording of each look in every prompt.", handoffTo: [video_production] }
      - { name: "Review the result", ownerRole: "MKT-EDIT", echelon: "review", brief: "Check rights to images and sound, facts, captions and playback, and that every character and the style match their sheets in every shot. A shot that differs is generated again." }
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
