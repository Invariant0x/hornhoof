---
department: household
default: household-requests
pipelines:
  - key: household-requests
    name: "Household requests"
    why: "For organizing everyday requests and following through on them."
    stages:
      - { name: "Sort household requests", ownerRole: "HHD-PM" }
      - { name: "Plan and do the work", ownerRole: "HHD-HEAD", echelon: "development" }
      - { name: "Record what is done", ownerRole: "HHD-PM" }
  - key: household-bills
    name: "Household bills"
    why: "For gathering bills and telling the person paying what is due."
    stages:
      - { name: "Collect bills", ownerRole: "HHD-BILLS" }
      - { name: "Check amounts and due dates", ownerRole: "HHD-BILLS", echelon: "development" }
      - { name: "Remind the person paying", ownerRole: "HHD-CAL", brief: "The person pays. Record the result once they confirm it." }
  - key: household-supplies
    name: "Household supplies"
    why: "For finding what the household needs and arranging a restock."
    stages:
      - { name: "Check what is missing", ownerRole: "HHD-SUPPLY" }
      - { name: "Compare what is available", ownerRole: "HHD-SUPPLY", echelon: "development", oneShot: {fanOut: 3, judge: "Compare the options against the household list and flag any price or availability that was not checked."} }
      - { name: "Share the list for purchase", ownerRole: "HHD-PM", brief: "The person pays for the order." }
      - { name: "Record what arrived", ownerRole: "HHD-SUPPLY" }
---
