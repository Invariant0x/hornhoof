# This slice

Plan 2 Task 3: the app runs in the mode the keeper gives it. One reader. Plan 2 Task 5, the keeper that writes this state, is being written on top of it and is not in this package.

Read for: what a request can still change in each mode; what happens on a stale, missing or unreadable state file; what runs and stops as the mode changes, in `app.ts` and the timers; whether a mode change can leave a socket or a timer behind.
