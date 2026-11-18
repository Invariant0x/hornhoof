---
department: support
default: support-requests
pipelines:
  - key: support-requests
    name: "Support requests"
    why: "For answering everyday questions and resolving customer problems."
    stages:
      - { name: "Read and group requests", ownerRole: "SUP-T1" }
      - { name: "Find the answer", ownerRole: "SUP-T2", echelon: "development" }
      - { name: "Check the answer", ownerRole: "SUP-QA", echelon: "review" }
      - { name: "Reply and close", ownerRole: "SUP-T1" }
  - key: support-triage
    name: "Ticket triage"
    why: "For a backlog or rush of tickets that need sorting and assignment."
    stages:
      - { name: "Read incoming tickets", ownerRole: "SUP-T1" }
      - { name: "Group and assess urgency", ownerRole: "SUP-T2", echelon: "development" }
      - { name: "Check disputed cases", ownerRole: "SUP-QA", echelon: "review" }
      - { name: "Assign and tell the customer", ownerRole: "SUP-HEAD", handoffTo: [development, operations] }
  - key: support-knowledge
    name: "Help articles"
    why: "For turning a recurring question into an answer others can reuse."
    stages:
      - { name: "Find a recurring question", ownerRole: "SUP-T1" }
      - { name: "Write the article", ownerRole: "SUP-KB", echelon: "development" }
      - { name: "Try the steps", ownerRole: "SUP-QA", echelon: "review", oneShot: {"fanOut": 3, "judge": "Keep verified steps and list gaps that would leave a reader stuck."} }
      - { name: "Publish and link the article", ownerRole: "SUP-KB" }
---
