---
department: finance
default: finance-records
pipelines:
  - key: finance-records
    name: "Finance requests"
    why: "For routine bookkeeping, bills and financial questions."
    stages:
      - { name: "Collect the papers", ownerRole: "FIN-PM" }
      - { name: "Record the figures", ownerRole: "FIN-BOOK", echelon: "development" }
      - { name: "Check the records", ownerRole: "FIN-AUDIT", echelon: "review" }
      - { name: "Share what is due", ownerRole: "FIN-HEAD" }
  - key: finance-monthly-close
    name: "Monthly close"
    why: "For closing the books and explaining differences at month end."
    stages:
      - { name: "Collect statements", ownerRole: "FIN-BOOK" }
      - { name: "Reconcile balances", ownerRole: "FIN-BOOK", echelon: "development" }
      - { name: "Review discrepancies", ownerRole: "FIN-AUDIT", echelon: "review", oneShot: {"fanOut": 3, "judge": "Compare totals by account and period and list unexplained balances."} }
      - { name: "Share the close report", ownerRole: "FIN-HEAD" }
  - key: finance-cash-plan
    name: "Cash planning"
    why: "For seeing what money is expected in and what bills are coming due."
    stages:
      - { name: "Collect balances and due dates", ownerRole: "FIN-BOOK" }
      - { name: "Forecast money in and out", ownerRole: "FIN-FPA", echelon: "development" }
      - { name: "Check assumptions", ownerRole: "FIN-AUDIT", echelon: "review" }
      - { name: "Explain choices to the person paying", ownerRole: "FIN-HEAD" }
---
