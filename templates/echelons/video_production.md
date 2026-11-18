---
department: video_production
stages:
  - { stage: development, oneShot: { fanOut: 3, judge: "Compare the drafts of each shot with its reference frame, the character sheets and the style sheet. Name the draft that matches them in every detail, list each difference in the others, and leave the keeper's yes to the keeper." } }
  - { stage: review, ability: vid-continuity-gate }
  - { stage: tests, ability: vid-quality-review }
---
