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
      - { name: "Hand over the files", ownerRole: "DSN-HEAD", handoffTo: [development, marketing] }
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
      - { name: "Sort footage", ownerRole: "DSN-PM", handoffTo: [video_production], brief: "Send original production to Video production when it exists. For the local edit, record the brief and assign the keeper and footage check." }
      - { name: "Prove the hardest edit", ownerRole: "DSN-HEAD", brief: "Assign the edit probe and record its acceptance and look reference with the keeper." }
      - { name: "Check shot continuity", ownerRole: "DSN-QA", brief: "The keeper checks the footage against the brief, style sheet and set. Get a new take for any drift before the clip goes to the editor." }
      - { name: "Edit a rough cut", ownerRole: "DSN-UI", echelon: "development", brief: "Cut only from clips the keeper accepted. Keep key events in view and compose for the platform." }
      - { name: "Add sound and captions", ownerRole: "DSN-UI", brief: "Carry through the sound planned from the first shots. Finish color, sound and titles across the whole cut against the probe's look reference under Law 10, with one owner for each. Check clarity under the agreed viewing conditions." }
      - { name: "Review the cut", ownerRole: "DSN-QA", echelon: "review", brief: "Check the export against the brief and style sheet. The head checks it at full size and frame by frame under Law 11 before delivery." }
      - { name: "Export the final video", ownerRole: "DSN-UI" }
---
