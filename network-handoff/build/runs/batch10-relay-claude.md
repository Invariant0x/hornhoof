# Review: batch 10, slice relay (Claude, read only)

Tree `/home/altera/hornhoof-network/hornhoof-edge`, branch `batch-10`, four commits: 092a989 (A1 chosen key), baf4576 (add waits
for the old tunnel), 3880b65 (retired-key wording), 1ab6550 (A2 traffic). Package `runs/batch10-relay.diff`, compared with plan 1
Task A1, plan 9c Task 12, plan 9 ruling 20 and Task 3, the build rulings and the ledger.

Critical: none. Important: none. Minor: 8.

## What I checked, and how

- Who may set a key: `Handler.key_answer` (relay.py:1803) calls `authorize_link` first, which compares the bearer with
  `bindings.key_hash` alone; retired `ping_keys` hashes never reach it (`ping_key_matches` is used only by `authenticate_call` for
  Ping and by `link_refusal`). `store_link_key` keeps its `WHERE key_hash = ?` guard, so an in-flight change with a stale key lands
  nowhere (404). Only the holder of the current key can set a key.
- An old key coming back: possible, only by the current holder's choice (`test_r6_1_a_retired_key_chosen_again_leaves_every_tunnel_its_heartbeat`);
  ledger line 389 rules it. The ping_keys rows stay consistent across the round trip, the test pins it.
- A lost answer: the caller holds K before asking; after a lost answer either K or the old key reads `route`, and nobody else
  holds either. A retry of `{key: K}` authenticated with K answers 400 `same_key`, which plan 9 ruling 20 never relies on: the
  client reads `route` with K first. Matches.
- Strength: only the form is checked (`CHOSEN_KEY` with `fullmatch`, so a trailing newline fails; `'a' * 43` passes). The plan asks
  for the form and nothing more; Hornhoof's client will send 32 random bytes.
- A chosen key in a log or an answer: `log_line(f'new {label} key for {name}')` carries no key; both refusal messages are fixed
  strings (`BAD_KEY_BODY`, 'The chosen key is the current key.'); `test_r6_1_chosen_key` reads the relay's log for the key and
  `test_r6_1_chosen_key_refused` reads each refusal for it. The visitor path reads the body and ignores it, tested.
- Seam to Hornhoof: `relay.ts:131` `changeKey(name, key)` still posts no body (`attempt` sends none when `opts.body` is undefined),
  `read_json` turns an empty body into `{}`, so today's client keeps getting a random key. `KeyAnswer` is a non-strict
  `z.object({ key })`, so the extra `message` on 400s and nothing else on 200 parse as before. Plan 9 Task 3's text (plan 9
  lines 396 to 408, 660 to 663, 703 to 704): 43 base64url else 400 `invalid`, the current key 400 `same_key`, 200 answers the
  chosen key. The relay answers exactly that.
- `hornhoof-relay add` when frps cannot answer: `admin_add` (relay.py, around line 1971) catches `FrpsUnknown` and prints
  `<name>: the relay cannot tell whether its old route is gone, nothing changed` on stderr, exit 1, no key printed; under `set -e`
  the `said=$(relay "$@")` assignment carries that exit and the script stops. `name_live` is reads only (`route_pending`,
  `frps_route`), no lock, no write. A dashboard answer slower than 0.5 s is also `FrpsUnknown` here (admin has no plugin budget,
  so `_dash_get` keeps `cap`).
- `runuser` and the environment: the script sources `/etc/hornhoof-relay.env` (written by `setup-relay.sh:44-52` as
  `KEY=value` lines, the password hex, so `sh` reads it as systemd does) under `set -a`, then `runuser -u hornhoof-relay --`.
  util-linux runuser without `-l` keeps the caller's environment (it resets only HOME, SHELL, USER, LOGNAME and PATH), and
  Debian's `/etc/pam.d/runuser` has no `pam_env`. If it did not pass the variables on, `FRPS_PASSWORD` would be '' and the
  dashboard would answer 401 on every read: every `hornhoof-relay add <name>` would end with the "cannot tell" line and exit 1,
  no binding made, no key printed, and `list`, `ban`, `unban`, `release`, `traffic` would go on unchanged. Fails closed; the
  deploy check (A1 Step 6, ledger 388) is where the real runuser is seen.
- A2 lock order: `count_traffic` (relay.py:1092) takes `transaction()` only, which queues for the one writer with
  `write_deadline()`; inside it a SELECT on the same connection and two `write` calls. No `create_lock`, no `route_lock`, no
  nesting. A busy writer past 0.8 s raises `WriteBusy`, which `safe_traffic_round` turns into one log line, and the next round
  runs. The thread's `call_deadline()` is None, so the budget is the plain 0.8 s.
- Month at a year's end: `utc_month` is `strftime('%Y-%m', gmtime(at))`, so 2026-12-31 23:59:30 is `2026-12` and 2027-01-01
  00:00:30 is `2027-01`; no arithmetic on month numbers anywhere. A counter reset (`sent < seen_sent`), a new boot or a new
  interface add the whole reading to the month of `at`, as the Interfaces say; bytes sent between the last read and the reset
  are lost, at most one minute's worth.
- Reads only `/proc` and `/sys`: `default_iface`, `sent_bytes`, `boot_id` build their paths from the `proc` and `sys` arguments
  and nothing else; `read_text` swallows `OSError` only.
- Python 3.12: nothing newer in relay.py or the tests (`str | None`, `os.environ | {...}`, `enterContext` are 3.11 or older).
- Em dashes, private values: none in the four commits' diff (`git diff HEAD~4 HEAD` grepped for U+2014); hosts are
  `127.0.0.1`, keys made at run time or fixed test strings.
- Trailers: none on the four commits; the one grep hit is the A1 body's ruling sentence about Signed-off-by, not a trailer.
- Suite: the lead's logs `runs/batch10-relay-run.log`, `batch10-py312.log`, `batch10-py314.log` and the two `remote-batch10*`
  logs end mid-run (eviction lines, no `Ran N tests` footer) at the time of this review, so I could not read a final result
  from them; the ledger (lines 388, 425) records the author checks green (250 and 54 tests, worst CRAP 7.0 and 6.0, no dryer
  pairs). The 3.14 log's `ConnectionResetError` tracebacks come from `handle_one_request` (relay.py:1672) when a test resets a
  connection; that code is not in this batch.

## Minor

1. relay.py `traffic_round` and `safe_traffic_round`: the warning and the failure line go out with `print(..., flush=True)`, not
   `log_line`, so they skip `_print_lock` and can interleave with another thread's line in the journal. One `log_line` call each.
2. relay.py `traffic_round`: the message hardcodes "past 300 GB" while `TRAFFIC_WARN_BYTES` defines the limit; a changed constant
   would make the line lie. Derive the number from the constant.
3. relay.py `sent_bytes`, `count_traffic`, `traffic_round`: the parameter `sys` shadows the `sys` module inside them (the plan's
   own signature does it). Harmless today since none of them uses the module; `sysfs` would say the same without the shadow.
4. relay.py `admin_add`: for a name never bound, "whether its old route is gone" reads oddly, and the line does not point the
   operator at `/etc/hornhoof-relay.env`, the one thing that makes frps unanswerable from this script. A word about where the
   relay's frps settings come from would save a search.
5. relay.py `new_link_key`: a JSON body `null` (no object) now answers 400 `invalid`; before A1 it got a random key. The plan
   names only "no body or `{}`" for the random path, and the Hornhoof client sends no body, so nobody is hit; worth a word in
   the docstring since it is a change outside the plan's two named forms.
6. test_keys.py `RetiredKeyWordingTests`: a test that greps README and relay.py for five phrases pins prose, not behaviour; it
   fails on an innocent rewording and passes with the comments wrong in any other words. The two behaviour tests it names
   already cover the promise. I would not keep it.
7. test_traffic.py `test_months_apart`: `utc_month` written with `localtime` instead of `gmtime` would still pass on a UTC
   machine (the test machine and a-host). A reading at a UTC boundary that falls inside one local day in a non-UTC zone, or a
   direct test of `utc_month`, would make the UTC promise fail for the right reason.
8. No test says `main` starts the `traffic-counter` thread; if the one line were lost, `hornhoof-relay traffic` would say "No
   traffic counted yet." forever and no warning would come. The deploy check (A2 Step 6, the month after two minutes) catches
   it, so no production harm reaches a person unseen; one line in the report, not a request.

## Rulings the writers made, and whether they hold

- A retired key may be chosen again: holds, only the current holder can do it, rows stay consistent (tested).
- `message` beside `error` on 400: holds, the client parses non-strict objects and the messages are fixed.
- No `Signed-off-by`: holds, ledger lines 41 and 376 already rule it, and CLAUDE.md binds over the plan.
- An add of any name refuses while frps cannot tell: holds, mirrors `POST /bindings` 503, fails closed.
- README sentence after the "For each address" paragraph; a first read writes no row: both hold, the second is pinned by
  `test_months_apart`.
