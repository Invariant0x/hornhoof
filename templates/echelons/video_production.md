---
department: video_production
stages:
  - { stage: development, oneShot: { fanOut: 2, judge: "Compare the proposed shot prompts or draft takes against the brief, the keeper's reference frames and the measured set. Report which options best hold motion and continuity. The operator checks the answers and sends the draft clips to the keeper for the decision." } }
  - { stage: review, ability: vid-continuity }
---
