---
department: support
stages:
  - { stage: development }
  - { stage: review, ability: hh-check-work, oneShot: { fanOut: 3, judge: "Combine checks of the answer or article against the supplied facts, policy and glossary. Keep errors that would mislead a reader and flag any missing evidence." } }
---
