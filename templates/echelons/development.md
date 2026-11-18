---
department: development
stages:
  - { stage: architecture }
  - { stage: development }
  - { stage: review, ability: dev-review-diff, oneShot: { fanOut: 3, judge: "Combine duplicate findings from the candidate review. Keep defects and test gaps supported by the cited code, and say which block the candidate or what evidence is missing." } }
  - { stage: cleanup, ability: dev-cleanup }
  - { stage: security, ability: dev-security-review, oneShot: { fanOut: 3, judge: "Combine findings about access, data and secret protections. Keep only findings supported by code references, distinguish required fixes from hardening and flag checks without enough evidence." } }
  - { stage: tests, ability: dev-test-environment }
---
