# Task 1253: read machine check admission

Historical task report. Raw files named here are preserved in `task-1364-source-evidence.tar.gz`, attached to task 1364, with per-file SHA-256 values in `archive-manifest.json`. [Original report and neighboring artifacts](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/task-1253-check-slots.md). These are historical results, not checks of the current release.

Known behaviour, risk class none, small turnkey task. Initial base: cf8b05fed0a2c80cb8cd6794d579bc4abcc8397c. The head's later instruction requires rebasing only our task commits onto the released main / turn-32, without merging old turn-31 history. Integration uses fast-forward turn-32, never turn-31.

The read tools test_run and work_run add checkSlot and a one-line waiting explanation to an assigned part whose execution has not started. The existing queuePosition stays available. Example contract for a queued part:

```json
{
  "queuePosition": 2,
  "checkSlot": {
    "machine": "home-api",
    "state": "queued",
    "capacity": 1,
    "queued": 2,
    "position": 2,
    "holders": [{"kind": "work", "run": 7, "task": 12, "part": 1, "since": "2026-01-01T12:00:00.000Z", "position": 0, "releasing": false}],
    "ahead": [{"kind": "tests", "run": 8, "task": 12, "part": 1, "since": "2026-01-01T12:01:00.000Z", "position": 1, "releasing": false}]
  },
  "waiting": "Waiting for a machine check slot on home-api. Position 2. Capacity 1. Queued 2. Holders: Work run 7, task 12, part 1, since 2026-01-01T12:00:00.000Z. Ahead: 1: Test run 8, task 12, part 1, since 2026-01-01T12:01:00.000Z."
}
```

CheckCoordinator.inspect returns detached snapshots without refreshing, admitting, cancelling or retiring anything. Acquired and admitted times are recorded with its existing clock. Retired holders remain visible during their existing cleanup grace. Slots, FIFO admission, leases and wire messages keep their previous behaviour.

Details are resolved from the claim's Run part label or authenticated job, bound to the actual node. runState checks the reader before enrichment. Holder and predecessor details also require the same company and existing run/task read authority; otherwise only kind unavailable, since, position and releasing are shown. Raw unknown labels, node identities and job IDs are not returned. Labels and names in the explanation are collapsed to one line.

The response is built from current memory on every read. After release it shows the new holder and position; after tests.started it no longer adds waiting details. A missing claim is not inferred to be active from the last stored position: it is marked not_recorded with checkSlot.position null. Only the legacy queuePosition retains the last reported position when no live claim is recorded. Empty and unavailable coordinator state have explicit explanations. queued counts the whole observed machine queue; ahead names only requests before the caller's recorded claim, in FIFO order. An authenticated job is identified as an agent check even when its label happens to match a run part.

Requirement evidence: check-queue.test.ts covers detached, side-effect-free reads, FIFO order and empty state with controlled time. test-runs-slots.test.ts drives both real MCP read tools on isolated database records, checks holder and task attribution, ordered predecessors, release updates, empty/startup queues, and permission redaction. Original scheduler/watchdog tests and named testruns neighbours remain part of the local checks. Whole-suite validation belongs to the release owner.
