# Browser fixture teardown

On 0c4c03022d025cb54f8b2d79cd91596fd0d5311a, agent-history.spec.ts completed 24 cases, exit 0, but Vite logged a proxy error for /api/stream. This browser result is NOT_PASS. Closing the page directly on f8cd58b63 also completed the cases but made the same proxy leak more frequent in Chromium; that result is NOT_PASS too.

The shared serveApi fixture intentionally holds this SSE route open instead of closing and reconnecting it. The test now uses the existing long-feedback-and-reports.spec.ts cleanup pattern: navigate to about:blank while routes are installed, then remove the routes while ignoring only cancelled cleanup handlers. This leaves the app before tearing down interception. All assertions and limits stay intact. No application or shared fixture code changes. The final runner also rejects a browser exit 0 when its log contains a proxy error or Error line.
