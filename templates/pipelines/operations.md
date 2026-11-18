---
department: operations
default: operations-requests
pipelines:
  - key: operations-requests
    name: "Operations requests"
    why: "For everyday requests to set up tools, accounts or access."
    stages:
      - { name: "Sort requests", ownerRole: "OPS-HEAD" }
      - { name: "Set up access", ownerRole: "OPS-PROGRAM", echelon: "development", brief: "Use the vault to sign in and test access from the requester’s working context." }
      - { name: "Check it works", ownerRole: "OPS-FIX", echelon: "review" }
      - { name: "Record the result", ownerRole: "OPS-PM" }
  - key: operations-incidents
    name: "Service recovery"
    why: "For a stopped service, stuck program or failed delivery."
    stages:
      - { name: "Check the signal", ownerRole: "OPS-WATCH", brief: "Compare the activity and events from the current run. Ask the program operator to inspect the screen when needed. Check recent updates and reconnects before treating a quiet machine as stalled." }
      - { name: "Restore service", ownerRole: "OPS-PROGRAM", echelon: "development", brief: "Handle routine prompts and finish interrupted delivery. Restart only when the screen and recent activity show that the run has stopped." }
      - { name: "Confirm recovery", ownerRole: "OPS-FIX", echelon: "review", oneShot: {"fanOut": 3, "judge": "Compare recovery evidence and keep gaps that could leave work stuck."} }
      - { name: "Record the cause", ownerRole: "OPS-BUGS", handoffTo: [development, support, home_devices] }
  - key: operations-integrations
    name: "Connect a tool"
    why: "For connecting a shared tool, mailbox or outside service."
    stages:
      - { name: "Map the access needed", ownerRole: "OPS-HEAD" }
      - { name: "Connect the service", ownerRole: "OPS-INTEG", echelon: "development", brief: "Sign in with the account from the vault. Keep passwords and tokens out of reports." }
      - { name: "Try it from the user’s place", ownerRole: "OPS-FIX", echelon: "review", brief: "Check the real operation in each working context that needs it. For mail, prove both delivery and receipt." }
      - { name: "Leave a short guide", ownerRole: "OPS-PM" }
  - key: operations-phone-handoff
    name: "Company phone setup"
    why: "For getting a company phone ready for work in its apps."
    stages:
      - { name: "Find the registered phone", ownerRole: "OPS-FIX" }
      - { name: "Check settings and access", ownerRole: "OPS-ACCT", echelon: "development" }
      - { name: "Try the app on the phone", ownerRole: "OPS-PROGRAM", echelon: "review" }
      - { name: "Hand the phone back", ownerRole: "OPS-PM" }
---
