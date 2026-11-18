---
department: design
default: design-requests
pipelines:
  - key: design-requests
    name: "Design requests"
    why: "For new screens and other everyday design work."
    stages:
      - { name: "Write the brief", ownerRole: "DSN-PM" }
      - { name: "Explore directions", ownerRole: "DSN-UI", echelon: "development" }
      - { name: "Check the design", ownerRole: "DSN-QA", echelon: "review" }
      - { name: "Hand over the files", ownerRole: "DSN-HEAD" }
  - key: design-brand-assets
    name: "Brand assets"
    why: "For illustrations, presentation pieces or other reusable brand material."
    stages:
      - { name: "Read the style guide", ownerRole: "DSN-SYS" }
      - { name: "Make options", ownerRole: "DSN-UI", echelon: "development", oneShot: {"fanOut": 3, "judge": "Choose the option that fits the brief and brand and will be easiest to use consistently."} }
      - { name: "Check sizes and reuse", ownerRole: "DSN-QA", echelon: "review" }
      - { name: "Export the files", ownerRole: "DSN-SYS" }
  - key: design-video-editing
    name: "Video editing"
    why: "For turning existing footage into a finished video."
    stages:
      - { name: "Sort footage", ownerRole: "DSN-PM" }
      - { name: "Edit a rough cut", ownerRole: "DSN-UI", echelon: "development" }
      - { name: "Add sound and captions", ownerRole: "DSN-UI" }
      - { name: "Review the cut", ownerRole: "DSN-QA", echelon: "review" }
      - { name: "Export the final video", ownerRole: "DSN-UI" }
---
