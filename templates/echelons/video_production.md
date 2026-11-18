---
department: video_production
stages:
  - { stage: development, oneShot: { fanOut: 2, judge: "Compare written proposals against the brief and supplied evidence. A text answer cannot verify footage. If no proposal meets the brief, identify the missing changes or evidence. The operator takes the draft clips to a keeper who can play them." } }
  - { stage: review, ability: vid-continuity }
---
