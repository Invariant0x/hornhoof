---
department: finance
stages:
  - { stage: development }
  - { stage: review, ability: hh-check-work, oneShot: { fanOut: 3, judge: "Compare independent recomputations and their source references. List material discrepancies and missing evidence, with the figure, period and currency for each." } }
---
