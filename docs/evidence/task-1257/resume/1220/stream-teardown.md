# Browser fixture teardown

On 0c4c03022d025cb54f8b2d79cd91596fd0d5311a, agent-history.spec.ts completed 24 cases, exit 0, but Vite logged a proxy error for /api/stream. This browser result is NOT_PASS.

The shared serveApi fixture intentionally holds this SSE route open instead of closing and reconnecting it. This test now closes each page in afterEach while interception is still installed, before the fixture removes its routes. Its assertions and limits are unchanged. No application or shared fixture code changes. The clean final run is retained separately from the noisy execution.
