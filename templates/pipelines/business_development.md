---
department: business_development
default: business-development-opportunities
pipelines:
  - key: business-development-opportunities
    name: "Business opportunities"
    why: "For testing whether a new opportunity is worth pursuing."
    stages:
      - { name: "Set the question", ownerRole: "BIZ-HEAD" }
      - { name: "Find options", ownerRole: "BIZ-ANALYST", echelon: "development" }
      - { name: "Check the evidence", ownerRole: "BIZ-REV", echelon: "review" }
      - { name: "Recommend a next step", ownerRole: "BIZ-PM" }
  - key: business-development-market-scan
    name: "Market scan"
    why: "For comparing demand, competing offers and gaps in a market."
    stages:
      - { name: "Define the market", ownerRole: "BIZ-PM" }
      - { name: "Research demand and alternatives", ownerRole: "BIZ-ANALYST", echelon: "development", oneShot: {"fanOut": 5, "judge": "Group independent sources by finding and flag claims a source does not support."} }
      - { name: "Verify key claims", ownerRole: "BIZ-REV", echelon: "review" }
      - { name: "Share the findings", ownerRole: "BIZ-HEAD" }
  - key: business-development-partners
    name: "Partner search"
    why: "For finding organizations that could work with the company."
    stages:
      - { name: "Define a good partner", ownerRole: "BIZ-PARTNER" }
      - { name: "Draw up a shortlist", ownerRole: "BIZ-ANALYST", echelon: "development" }
      - { name: "Check fit and contacts", ownerRole: "BIZ-REV", echelon: "review" }
      - { name: "Start conversations", ownerRole: "BIZ-PARTNER" }
---
