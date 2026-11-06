# Task 378 author integration

The CEO's 2026-11-06 decision moves comparative performance, full-suite and advanced quality acceptance to testers. No new full replay is requested or executed here. Historical runs 103, 0049 and 106 retain their failed/invalid outcomes; no speedup percentage is claimed.

The temporary comparison branch remains at 746fec3a3901b7c468b657c4be98e09cdcda217d. CONTROL 6d0c79b0ced4ab2fc4f771a46479680664d6b663 and OPT b98035e6d1b6b75715a5839ff0a4ea243878e65a are unchanged. Neither the archive nor the comparison driver is part of this integration branch.

The author branch task-378-integration starts at turn-8 e3b1c2b130d21acd3db53abb5b910428ecadd07e. It transfers the prior clock/test-file optimizations. Conflicts in terminal-host-waits, decisions and test-runs were resolved against the current source. Current decision visibility/status assertions and all newer product, resource and wait tests are retained. The terminal assertions still inspect the current raw report stream; controlled clock advancement waits for accepted work before advancing the end windows.

A read-only TypeScript AST comparison confirms identical normalized assertion-call multisets before and after splitting: test-runs 794/794, decisions 218/218, install-script 812/812. These are static assertion-expression counts, not executed test counts or performance evidence. Parameter matrices and complete test bodies come from the current turn branch. The prior intentional-fault evidence remains in 2026-11-05-linux-test-runtime.md with its original source and limits.

Only affected tests run through run_tests for this author candidate. Their new run number, exact SHA and actual result will be recorded after completion. No local test fallback, deadline increase, retry flag or new skip is introduced. Comparison with turn 7 and the separate PGlite change remain tester acceptance.
