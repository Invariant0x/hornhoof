# A delta read

You raised the findings in `network-build/runs/batch7-relay-r2-agy.md`, given below as your report. The package is only the fix's commit. For the Part 2 Critical and each Minor the fix claims: say ADDRESSED or NOT ADDRESSED, and whether its test fails without the fix. Then read the fix itself for new breakage: lock order, a new deadlock, what one new connection now reads (Review Focus 5 wants no write and no scan), and a live tunnel across a key change (R6.1).

Then rule on the writer's open item, the line `Batch 7's fix: Ruling, left open` in the ledger: frps calls NewUserConn for neither http-mode nor its vhost, so an http route under a new binding is stopped only by R1.5. Say concretely who can reach this and what they would get, and whether it is still Critical. Say if a small change closes it. Nothing here runs against the real droplet or a live service.
