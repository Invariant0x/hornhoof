# Task 1221: keep test addresses owned

Bug, risk class none. Base: da719b0e7094ce0b78e35a48c13085f9f7521e5b.

The worker keeper fixture selected five leader ports and one worker port by probing and closing them. Another Vitest process can claim each port before the keeper binds it. A failed peer listener leaves the fixture waiting for a leader that cannot answer. The fix uses the same atomic port 0 binding as task 1177, retains the actual addresses returned by start/peerPorts, and registers keeper cleanup before start. Fastify and the intercept door retain the existing listenAt/listenIn helpers.

The other server testPort callers described unavailable addresses. They now share closed-port.ts, which holds its address until test cleanup and resets connections immediately. The two duplicate closedPort helpers are removed. The lab's generated raw TCP probe receives recorded refused/connected results, with exact target assertions; a TCP connection can succeed before a bound reset receiver rejects its traffic. All previous verdict assertions remain. The protocol relay still runs through our real code. No production keeper code, deadlines, test limits, access assertions or scenarios change.

The shared testPort export remains necessary for listenAt and for callers in apps/node and apps/web, outside this server task. Only the deliberate stolen-probe regression mock still names it under apps/server/test.

## Requirement evidence

- Leader and worker startup after a probe address was stolen: worker-keeper-fixture.test.ts, both cases. A held listener supplies the old fixture's probed address. Before the fix both cases fail with EADDRINUSE (ports 24000 and 24008); after the fix they join and serve /api/health. Existing worker-keeper.test.ts preserves all 29 scenarios.
- An unavailable address cannot become another test's service: closed-port.test.ts. Before the fix a second bind succeeds unexpectedly; after the fix it is refused and repeated clients receive a reset. Existing SMTP, webhook, refs, ACME, ARI, TLS and lab tests retain their outcome assertions.
- Initial checks: 31 keeper cases and 222 caller cases passed. Logs in task-1221-proof record these development checks, before final candidate verification. The first type check caught a Socket return in a test cleanup callback; that callback now returns void. These are development results, not final candidate receipts.
- Final verification: ten sequential isolated runs of the two explicitly named worker-keeper test files, with candidate SHA, exact test counts and load samples; server build, server types including tests with a 2048 MB heap, eslint and check:author. No whole suite or run_tests.

The separate rare stall inside a keeper round remains Oracle's investigation. Port-race tests do not claim to resolve it.
