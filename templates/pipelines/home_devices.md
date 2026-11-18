---
department: home_devices
default: devices-requests
pipelines:
  - key: devices-requests
    name: "Home device help"
    why: "For checking or fixing a device already in the home."
    stages:
      - { name: "Identify the device", ownerRole: "HOM-PM" }
      - { name: "Check what is wrong", ownerRole: "HOM-SMART" }
      - { name: "Fix and verify", ownerRole: "HOM-SMART", echelon: "development" }
      - { name: "Tell the household", ownerRole: "HOM-HEAD", handoffTo: [household] }
  - key: devices-cleanup
    name: "Device cleanup"
    why: "For freeing space and clearing junk on a TV or other home device."
    stages:
      - { name: "Find what takes space", ownerRole: "HOM-SMART" }
      - { name: "Move recoverable junk aside", ownerRole: "HOM-SMART", echelon: "development", brief: "Move junk somewhere it can be recovered. Only irreversible deletion needs the CEO’s yes." }
      - { name: "Check the device still works", ownerRole: "HOM-HEAD" }
  - key: devices-network
    name: "Home network check"
    why: "For slow Wi-Fi or devices dropping off the home network."
    stages:
      - { name: "List affected devices", ownerRole: "HOM-PM" }
      - { name: "Check connections and settings", ownerRole: "HOM-NET", echelon: "development", oneShot: {fanOut: 3, judge: "Compare likely causes from the connection notes and suggest checks that leave settings as they are."} }
      - { name: "Try the fix from each room", ownerRole: "HOM-NET" }
      - { name: "Record what changed", ownerRole: "HOM-HEAD" }
---
