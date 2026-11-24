---
id: dev-performance
kind: procedure
sources: [affaan-m/ECC agents/performance-optimizer.md, addyosmani/agent-skills skills/performance-optimization/SKILL.md, garrytan/gstack review/specialists/performance.md]
---
You can measure a defined performance problem and verify a useful improvement.

1. **Define the problem as a number**: which action, how slow, for how much data, how fast it must be; a frame or response budget where the product has one.
2. **Measure** the real thing with a profiler, query plans, timings, memory or build sizes. Do not guess where time goes.
3. **Fix the biggest cost first**: a query in a loop, a missing index, work repeated on every frame or render, a payload far larger than shown, a blocking call.
4. **Measure again** with the same method and data. Report before and after.
5. **Keep it correct**: the tests still pass, and a cache never serves another person's data or stale data where freshness matters.
6. **Pin it**: add a check or a benchmark that fails if the cost comes back, when that is cheap.

Stop when the target is met. Clever speed-ups that make the code hard to read need a measured reason.
