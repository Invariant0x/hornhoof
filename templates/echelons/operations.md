---
department: operations
stages:
  - { stage: development }
  - { stage: review, ability: hh-check-work, oneShot: { fanOut: 3, judge: "Combine findings on the change plan, runbook or incident evidence in the brief. Keep supported gaps in the checks or recovery steps and flag missing records." } }
  - { stage: tests, ability: dev-test-environment }
---
