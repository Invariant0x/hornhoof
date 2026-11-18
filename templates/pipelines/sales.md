---
department: sales
default: sales-opportunities
pipelines:
  - key: sales-opportunities
    name: "Sales opportunities"
    why: "For following up with interested buyers through a decision."
    stages:
      - { name: "Qualify the request", ownerRole: "SAL-SDR" }
      - { name: "Discuss the need", ownerRole: "SAL-AE", echelon: "development" }
      - { name: "Check the offer", ownerRole: "SAL-REV", echelon: "review" }
      - { name: "Follow up and record the result", ownerRole: "SAL-OPS", handoffTo: [finance, support] }
  - key: sales-outreach
    name: "Email outreach"
    why: "For finding suitable contacts and starting conversations by email."
    stages:
      - { name: "Research contacts in batches", ownerRole: "SAL-SDR", brief: "Agree on a stop rule up front. After each batch, stop if it reaches the target or new sources stop yielding suitable contacts. Keep a source for each contact." }
      - { name: "Group by need", ownerRole: "SAL-OPS" }
      - { name: "Write the letters", ownerRole: "SAL-AE", echelon: "development", oneShot: {"fanOut": 3, "judge": "Choose the best draft for each segment using the facts in the brief."} }
      - { name: "Check and send test copies", ownerRole: "SAL-REV", echelon: "review", brief: "Send test copies to company addresses first and verify they arrive as written." }
      - { name: "Send one letter at a time", ownerRole: "SAL-AE", brief: "Send a checked letter from the department’s versioned send list in Git. Sign in with the mailbox from the vault and record each send." }
      - { name: "Handle replies", ownerRole: "SAL-OPS", brief: "Record replies, hand interested contacts to the person following up and record requests to stop contact." }
  - key: sales-proposals
    name: "Sales proposals"
    why: "For putting a price and work plan in front of a buyer who asked for them."
    stages:
      - { name: "Confirm what the buyer asked for", ownerRole: "SAL-AE" }
      - { name: "Draft the proposal", ownerRole: "SAL-AE", echelon: "development" }
      - { name: "Check the promises and price", ownerRole: "SAL-REV", echelon: "review" }
      - { name: "Send and discuss the proposal", ownerRole: "SAL-AE", brief: "The department can send and discuss the proposal. A person signs for the company." }
---
