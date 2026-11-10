Continue SAME Task6 fix2 session afd4c067-6645-4ed8-a49d-190dc63ba141 in /Users/0x/Projects/hornhoof-edge, base75e8a3d. This completes already-accepted I8 before final review3, no new review round. Change ONLY relay/test/test_peers.py, no production/staging/commit or Minor fixes.

Lead audited the final test-only changes and found remaining generated-key-bearing assertions. Lead first-failing safe probe L/runs/p1t6-lead-rotation-diagnostics-probe.py ran on stable testsource: initial three cases produced1failure/0errors, credential leakedTrue. No captured output or key printed. Run it first, see the safe failure, then fix:
- test_r5_1_peer_limits: second visitor issuance status assertion includes raw second body. Use a fixed message.
- Same test: assertNotEqual(second[visitorKey], visitor_key) prints the generated key on unsafe reuse. Preserve exact inequality with boolean assertion and fixed message.
- test_r6_2_visitor_key_dies_with_the_binding_api: assertNotEqual(rebound[key], self.key) prints the generated binding key on unsafe reuse. Preserve inequality via boolean assertion and fixed message.
Audit all new generated-secret comparisons and body-bearing issuance assertions once more. Do not weaken any check. Test fixture constants such as k1/v1 need no changes. No production change requested.

After the fix, require the lead probe observes all four injected failures with0errors and credential leakedFalse; run the two normal test methods on Python3.12 and3.14. Prior final test-only full suite is valid for all other code; the lead will now independently run full Donewhen on both Pythons and fresh actual coverage gates. For these three assertion-only changes, focused verification is sufficient for your report. Report the exact first failure, focused/probe results and unchanged production hash. Do not repeat full suites or gates, do not print any raw captured output/credential.

L=/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network/.superpowers/network-build.

The same probe also covers issuance-auth-bypass: a wrong-key issuance that unexpectedly succeeds carries a generated visitor key; the expected-401 assertion currently renders its raw body. Make ALL visitor-key endpoint status assertion messages fixed, including expected 401/404, not only expected200. No raw response bodies in issuance status messages anywhere. This preserves auth-regression detection while preventing credential output. The final probe now has4cases, each must fail internally without key leakage.
