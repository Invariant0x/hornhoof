# Node restart evidence

`jobs.interruption` records a node restart separately from `jobs.tail`, which is agent output. The `failures` MCP tool used by the Weak point collector (`OPS-BUGS`, skill `ops-failure-review`) returns this record as `interruption`.

The record retains the existing observed `cause`, timestamp, node identity, task number and version change. It also includes:

- `machine`: the authenticated machine's database id and name. The built-in node uses the installer's host id to find its machine. Missing mappings are null.
- `diagnosis`: `kind` (`planned`, `unplanned` or `unknown`), `reason`, the previous process's `startedAt`, stop time when known, and `log`.

The node keeps an atomic, private `node-runtime.json` in its persistent data directory. A completed stop records its reason; an absent stop marker on the next start reports `unplanned/unclean_exit`. A missing or damaged journal and old nodes report `unknown`. Connection loss in the same node process uses the current log and `unplanned/disconnected`, without replaying an older exit.

The installer writes a generation-bound stop intent before graceful container replacement: `node_update` for personal nodes and `hornhoof_update` during a server update. An intent alone is not a clean stop. Ordinary SIGTERM/SIGINT uses `stopped`. On a server restart, a first built-in hello distinguishes jobs older than the node process from jobs it could have run, so a stale preceding exit does not explain a newer job. Old nodes remain compatible without the new fields or installer command.

Program installation through `programs.update` changes the CLI in the running node. It does not restart the node or stop its agents. The protocol also accepts explicit `program_update`, `server_restart`, `killed` and `out_of_memory` reports, but it does not invent those reasons from a missing stop marker. An increased cgroup OOM kill counter is included as a fact in the log, since another process in the cgroup may have been killed.

Node diagnostics are sanitized before output, persistence and transmission. They exclude agent transcripts and retain at most 80 lines and 16384 UTF-8 bytes. Redaction covers known credentials and their encoded forms, credential labels, authorization/cookie headers, join commands, URL credentials and private keys. These bounds apply to optional protocol fields too.

The existing one-retry policy remains responsible for work recovery. Closed tasks still reject repeated execution wakes and add a `wake_skipped` task event.
