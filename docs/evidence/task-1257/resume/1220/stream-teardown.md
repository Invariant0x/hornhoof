# Browser fixture teardown

Historical task report. Raw files named here are preserved in `task-1364-source-evidence.tar.gz`, attached to task 1364, with per-file SHA-256 values in `archive-manifest.json`. [Original report and neighboring artifacts](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/evidence/task-1257/resume/1220/stream-teardown.md). These are historical results, not checks of the current release.

On 0c4c03022d025cb54f8b2d79cd91596fd0d5311a, agent-history.spec.ts completed 24 cases, exit 0, but Vite logged a proxy error for /api/stream. This browser result is NOT_PASS. Closing the page directly on f8cd58b63 also completed the cases but made the same proxy leak more frequent in Chromium; that result is NOT_PASS too.

The shared serveApi fixture intentionally holds this SSE route open instead of closing and reconnecting it. The test now uses the existing long-feedback-and-reports.spec.ts cleanup pattern: navigate to about:blank while routes are installed, then remove the routes while ignoring only cancelled cleanup handlers. This leaves the app before tearing down interception. All assertions and limits stay intact. No application or shared fixture code changes. The final runner also rejects a browser exit 0 when its log contains a proxy error or Error line.
