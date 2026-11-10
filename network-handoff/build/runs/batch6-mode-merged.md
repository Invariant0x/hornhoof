# Batch 6, mode slice (Plan 2 Task 3): what the fix round does

Report: `network-build/runs/batch6-mode-r2-agy.md` (Antigravity, with the code). Read it from the top; numbers below are its Important items. Each fix from a failing test. Check each claim first; if one does not hold, say why and leave it.

1. `modeGate` lets every GET through in `read` and `maintenance`, and five read routes write through `expireStaleNodes` (`GET /api/org`, `/api/subscriptions`, `/api/agents/:id`, `/api/machines`, `/api/pool`). Under Plan 3's fence those screens would answer 500 outside `lead`. Only the leading app writes; a read must not.
2. `POST /api/updates` with `whenIdle` keeps its 30 s timer, bus subscription, `holdTurns` and timeout across a step-down, and can start an updater on a machine that no longer leads. Stop them on leaving `lead`.
3. A socket that passed `modeGate` during a step-down stays open. Close or refuse on `connection` whenever the app is not leading, on all three socket routes.
4. `enter` hooks keep running after the app left `lead`, and sockets wait behind `links.sync()`. A turn that ended stops its remaining hooks, `leave` runs only for hooks that entered, sockets close at once.
5. `timers.ts`: the three entry sweeps are not tracked, an overrun `minuteRound` overwrites `round`, and `leave` waits only for `round`. Track them and wait for them, and let no two copies overlap.
6. `whenLead` after `start` runs at once instead of after what is pending. Chain it.
7. `freshState` takes a future `at` as fresh. Check both bounds. A little skew is allowed only if you can say why; the safe answer is null.
8. No test runs `AppMode.start` with `fromKeeper: true`, and the socket test's 4000 ms would pass a slower poll. Show the 2 s promise without a wall clock on a loaded machine: an injected clock or a direct check on the interval, not a tighter sleep.

Minors in your way: `run`'s log line should go through `loggable` as `app.ts:130` does; `start` twice and a late `check` after `stop` should do nothing.

Keep `AppMode`'s public shape (`whenLead`, `current`, `settled`, `start`, `stop`, `whileLeading`): Plan 2 Task 5 and Plan 1b Task 8 are being written against it. If you must change a name, stop and tell the lead.
