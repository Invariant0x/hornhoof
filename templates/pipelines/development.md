---
department: development
default: development-changes
pipelines:
  - key: development-changes
    name: "Software changes"
    why: "For building a feature or fixing a product problem."
    stages:
      - { name: "Build the change", ownerRole: "DEV-ENG", echelon: "development" }
      - { name: "Plan the change", ownerRole: "DEV-ARCH", echelon: "architecture", parent: "Build the change" }
      - { name: "Review the change", ownerRole: "DEV-REV", echelon: "review", parent: "Build the change" }
      - { name: "Tidy the change", ownerRole: "DEV-ENG", echelon: "cleanup", parent: "Review the change" }
      - { name: "Check security", ownerRole: "DEV-SEC", echelon: "security", parent: "Tidy the change" }
      - { name: "Run tests", ownerRole: "DEV-TEST", echelon: "tests", parent: "Check security" }
      - { name: "Release the turn", ownerRole: "DEV-OPS", parent: "Run tests" }
  - key: development-docs
    name: "Technical guides"
    why: "For writing instructions or updating examples that people use."
    stages:
      - { name: "Collect common questions", ownerRole: "DEV-PM" }
      - { name: "Write the guide", ownerRole: "DEV-DOCS", echelon: "development" }
      - { name: "Check examples", ownerRole: "DEV-REV", echelon: "review", oneShot: {"fanOut": 3, "judge": "Compare the examples against what the product actually does. List steps a reader cannot repeat."} }
      - { name: "Put the guide where people look", ownerRole: "DEV-DOCS" }
  - key: development-release
    name: "Release a product"
    why: "For taking a checked set of changes to the people who use it."
    stages:
      - { name: "Pick what ships", ownerRole: "DEV-PM", echelon: "architecture" }
      - { name: "Prepare the release", ownerRole: "DEV-OPS", echelon: "development" }
      - { name: "Review the release notes", ownerRole: "DEV-REV", echelon: "review" }
      - { name: "Check release evidence", ownerRole: "DEV-TEST", echelon: "tests" }
      - { name: "Roll out and watch", ownerRole: "DEV-OPS", handoffTo: [operations, support] }
---
