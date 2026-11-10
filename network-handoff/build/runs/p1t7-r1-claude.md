# Plan 1 Task 7, review round 1 (Claude, read only)

Package: `network-build/runs/p1t7-r1.diff` (working tree of `hornhoof-edge` against dce89a9, so bd24cc1 included).
Read in full: the brief, the plan's top through Review Focus, the task, the two writers' reports, the fixture approval and
its proposal diff, the ledger's Task 6 and Task 7 lines, spec section 10, and `relay/relay.py` as it stands. Nothing was
changed; one probe script ran in process under `network-build/tmp/p1t7-r1-claude/probe.py` through `light.sh`.

Counts: Critical 0, Important 1, Minor 7.

## The lead's questions, answered

- **Can an old key do anything but keep a heartbeat?** No. `authenticate_call` (relay.py:1084-1089) consults `ping_keys`
  only when `op == 'Ping'` and the normal check refused; Login and NewProxy go through `authenticate` alone, and the public
  API uses `authorize_link`, which reads `bindings.key_hash` only. `ping_key_matches` (992-1000) joins the retired hash to
  the binding whose current hash it chains to and requires `banned_at IS NULL`, so a ban refuses it, a release leaves it
  with no binding to join, a rebind gives the next owner a hash no chain points to, and repeated rotation re-points every
  retired hash to the newest one in the same transaction (`retain_ping_keys`, 979-989). Reproduced with the probe: after
  k0 -> k1 -> k2 all three Ping; after release, rebind as n0 and n0 -> n1, k0, k1, k2 are all refused and n0 still Pings.
  `test_r6_1_retired_ping_cannot_bypass_ban_release_or_rebind` pins the same sequence.
- **Can a new company be handed a name another machine still serves?** Not through the API: `requested_name_reason`
  (388-393) runs `check_name` first and then `name_live` for both `GET /names` and `POST /bindings` with a name; `online`
  gives `taken`/409, `FrpsUnknown` gives 503 via `handle_one_request` (1114-1121). The random name path never reads the
  dashboard (`random_free_name`, 873-878). An https route counts (`frps_route` reads both types); both types at once is
  unknown. Tests: `test_r1_5_freed_name_waits_for_its_tunnel`, `test_r1_5_cannot_tell`,
  `test_r1_5_https_route_is_taken_and_ambiguous_routes_are_unknown`.
- **Does a rotation racing a release or rebind harm the next owner?** No. `store_link_key` (962-976) updates only
  `WHERE key_hash = <authorizing hash> AND banned_at IS NULL`, inside one `BEGIN IMMEDIATE`; zero rows means 404 and no
  write. A DELETE authorized with the old hash after a rotation also finds no row (`release_binding`, 933). Tests:
  `test_r6_1_authorized_before_release_cannot_overwrite_next_owner`, `..._before_ban_cannot_replace_key`.
- **Does a failed write leave a company with no working key?** No: the UPDATE and both `ping_keys` writes are one
  transaction, a `WriteBusy` anywhere rolls back and answers 503 busy with the old key intact
  (`test_r6_1_rotation_rolls_back_if_heartbeat_retention_fails`, `test_r6_1_busy_write_preserves_authorizing_key`).
  See Minor 5 for the one case no relay can cover.
- **Did the create_binding split keep every check's order, status and body?** Yes. `binding_body` keeps 415, then the
  three 400s in the old order; `creation_wait` returns the same `Retry-After` (`max(oldest + 3600 - t, 1)` for the
  per-address limit, 600 for the global one, per-address first); `name_to_bind` lowercases, then 400 invalid, then 409
  with the same message; the refusals are still sent inside `create_lock`; the 201 body is unchanged.
  `BindingRequestTests` pins each of these with literal messages and Retry-After values.

## Important

**I1. `release_binding` leaves the name's `sync` record for the next owner.** relay.py:911-935 deletes `visitor_keys` and
`bindings` only; `sync` and `routes` stay. Reproduced with the probe: after the old owner stored
`{off, copy: 'old-owner-copy-name', epoch: 900}` and released, the name rebound to a new key and `sync_of('acme')` returned
that record unchanged. What a person gets: the new company's `GET /route` shows the previous company's `copy` text and
epoch, and every `POST /sync` it makes with an epoch at or below 900 is refused `stale_epoch` (`set_sync`, 529), so its
sync state cannot be set until its own epoch passes a stranger's. This predates Task 7 (release and rebind existed since
Task 2), but Task 7 is the task that makes the freed-name path a contract (R1.5), and the Task 6 ruling "a credential
belongs to one binding lifetime" argues the record does too. What would make it right: `DELETE FROM sync WHERE name = ?`
inside `release_binding`'s transaction, for both the guarded and the admin path, with a test that rebinds and reads the
R2.4 default. Whether the `routes` row (generation) should survive an owner change is a separate question for the lead;
R2.2 only asks that it grow and survive restarts.

## Minor

**M1. `ping_keys` rows are never deleted.** relay.py has no `DELETE FROM ping_keys`. After release the probe shows 2 rows
left for `acme`, 3 after the next owner's first rotation; every rotation adds one row per name forever. They are dead
(no binding hash chains to them), so there is no access, but the table grows without bound and a released lifetime's
hashes sit beside the new owner's. Right: delete the name's `ping_keys` in `release_binding`, next to `visitor_keys`.

**M2. The fixture change in `test_route.py:602` made one assertion vacuous.** The client is now started as `name` (random),
but the check stayed `client.started('acme', within=2)`: the pattern `[acme] start proxy success` can never match, so
`assertFalse` passes whatever the relay does (and waits 2 s for nothing). The following `assertIn('relay error: frps does
not answer', ...)` still catches a fail-open relay, so the test is not blind, only half of it is. The approved proposal
diff has the same literal, so this needs a fixture ruling, not a writer's liberty. Right: `client.started(name, within=2)`.

**M3. Rotation on a blocked binding answers 404 "There is no binding acme."** `authorize_link` does not look at
`banned_at`, `store_link_key` refuses on it, and `key_answer` (1237-1238) turns that into the not-found message. The
probe confirms `store_link_key` returns False on a banned row. DELETE says 403 blocked for the same state (1354-1355). A
person whose name was banned is told their binding does not exist. Closed, so Minor; consistent with the Task 6 ruling
that a changed authorization may answer 404, but here the state is not a race. Right: check `banned_at` in `key_answer`
and answer 403 as DELETE does, or say so in the docstring.

**M4. Dashboard reads now run under `create_lock`.** `name_to_bind` calls `requested_name_reason` inside the lock
(1332-1337); `frps_route` makes up to two reads at 0.5 s each with no plugin budget, so a slow dashboard serializes every
`POST /bindings` at up to 1 s. Bounded and fail-closed, so Minor. Right: read the dashboard before taking the lock and
recheck `check_name` inside it, or accept and note it.

**M5. A lost answer after the commit leaves the company with no key it knows.** `key_answer` commits the new hash, then
sends it; if the connection dies between the two, the old key is already refused and the new one never arrived. No relay
design avoids this without an idempotent token; the plan did not ask for one. Right: plan 1b's `changeKey` should treat a
timeout as "the key may have changed" and tell the person, and the README or the contract should say the answer is the
only copy. Noted for the lead, not against the writer.

**M6. TDD was partial on the pins.** The writers say so themselves: `BindingRequestTests` passed on the old
`create_binding` by design (refactoring pins; the mutator later killed their sites), the three ban and Caddy tests passed
on the base as regression pins, and `test_r6_1_key_is_answered_only_on_its_own_path` passed when written. The six plan
tests and the race, rollback and heartbeat tests were seen red first (`initial-red.log`, `heartbeat-red.log`,
`authorization-red.log` in the writer's evidence). Acceptable for pins; recorded so the ledger is honest.

**M7. Design consequence of the retained heartbeat, for the lead to weigh.** The brief (plan1-task7.md line 79) asked that
a live today's tunnel survive a key change, and the code does exactly that and no more. The consequence: for the spec's
section 10 "stolen machine", a stolen machine running a today's client keeps serving `<name>.hornhoof.org` after the
owner changes the key for as long as it heartbeats, where before Task 7 its next refused Ping would have cut it within
90 s. A stolen network client lingers the same way either way (it sends no Ping), so the two client kinds now behave
alike and only `ban --cut` ends either. That matches R6.1 "live tunnels stay"; it is a plan-level trade, not a Task 7
fault. If the lead wants a key change to also cut a today's tunnel, that is a contract change, not a fix.

## Checked and found right

- Old key refused by every public endpoint and at Login, new key works, tunnel stayed, generation and since unchanged
  (`test_r6_1_change_key`, `test_r6_1_old_key_refused_by_every_public_endpoint`, `..._legacy_survives_rotation_and_relay_restart_through_ping`).
- Ban without a restart: frps pid and `RELAY_FRPS_STARTED` unchanged, the retry's log says blocked, a today's client goes at
  its refused Ping within 40 s (`test_ban_without_a_restart`, `test_ban_today_client_cut_by_ping`).
- Caddyfile order: `import blocked.caddy` at line 67 comes before `reverse_proxy 127.0.0.1:8080` at line 74 inside the
  `*.hornhoof.org` block that opens at line 51.
- bd24cc1: `shutdown(SHUT_RDWR)` under `try/except OSError`, then `close()`, on a socket the constructor always creates
  (test_peers.py:754); `.resolve()` to `.absolute()` is a no-op without symlinks and lets the mutator run its own copy.
  Both are test-only.
- No key reaches a log, a test message or admin output: generated keys go into `Stack.private` and are compared with
  booleans or fixed messages; `test_r6_1_old_key_refused_by_every_public_endpoint` checks the relay log and admin output
  for both the new key and the visitor key with `all(... not in text ...)`.
- No em dash in any of the seven changed files (byte count 0 each). Python used: `X | None`, `removeprefix`,
  `enterContext`; nothing newer than 3.12. The module docstring and `hornhoof-relay` help say what the code does; the
  README does not describe these commands or endpoints, so nothing there became false.
- Two no-dashboard fixtures changed exactly as the approval allows (apart from M2, which the approval itself carries).
- Gates: the lead's own run reports `binding_body` 8.0 as the worst changed function and no dryer pair at 0.8; the
  writer's duplication note about `sync_answer`'s Content-Type check is below the threshold and outside the task.
