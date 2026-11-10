# Batch 7 and Plan 1's end: what the fix round does

Reports: `network-build/runs/batch7-relay-r2-agy.md` (Antigravity, with the code) and `network-build/runs/batch7-relay-claude.md` (Claude). Read both from the top.

## Critical, verified by the lead in the code
A freed name can be rebound while the old owner's route is still pending, and visitors of the new owner then reach the old owner's machine. `name_live` asks only the frps dashboard, so a route in the 10 s `pending` window reads as free; `create_binding` checks and inserts under `create_lock` without `route_lock(name)`; `upsert_route` writes `pending` without checking that the binding it authorized is still there and unblocked; `link_refusal` looks only at the name. Antigravity's report has the sequence. Failing test first, at the level of the plugin and the HTTP calls, without a timing window: A binds, NewProxy passes, A frees, B asks. B must not get the name while A's route is pending or held, and a NewProxy racing a DELETE or a ban must be refused. The route of the old owner must not stay reachable under the new owner's binding. Its suggested fix is a starting point; check it against R1.5, R7.4 and the existing lock order (`create_lock`, `route_lock`) so no new deadlock comes in, and say what lock order you end with.

## Minor worth doing here, each from a failing test
1. `hornhoof-relay ban --cut acme` exits 0 and bans the literal name `--cut`, leaving `acme` live. Strip the option first and check the name.
2. `RelayServer` leaves one SQLite connection open per short-lived thread until the garbage collector runs. Close it when the thread ends.
3. `relay/hornhoof-relay:5`'s `ban` help line says it answers 410 at once; match the README.

Read Claude's Minors too; fix those that cost a line or two in code you are already in, and name the rest for the ledger. Do not reword the README beyond what is wrong.

## Not yours
- `relay/setup-relay.sh` does not yet install the edge's frpc nor give relay.py `RELAY_EDGE_TOKEN` and `RELAY_FRPS_HTTPS`. Plan 1 puts that in Task 13, David's and Ivan's. The lead carries it.
- `apps/server/test/fake-relay.ts`: it lives in the other repository; the lead gives it to another writer.
