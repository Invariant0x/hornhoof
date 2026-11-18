---
department: sales
stages:
  - { stage: development }
  - { stage: review, ability: hh-check-work, oneShot: { fanOut: 3, judge: "Compare checks of prospect fit, contact roles and proposal claims against the supplied records. Flag unsupported claims or promises and say what still needs confirmation." } }
---
