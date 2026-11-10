# Plan 1 Task 8 report: the relay's real Caddy under test, today's edge pinned

Status: DONE_WITH_CONCERNS. The code, the tests and the three gates are done. The one concern left is at the end: the macOS
archives have never run, which the lead rules stays as it is.

Lane: `/home/altera/hornhoof-network/wt/p1t8`. Nothing staged, nothing committed.

Ivan's later ruling, through the lead: writers no longer run mutator, it runs once at the plan's review. The mutator numbers
below came from a run that had already finished before that ruling reached me; no mutator run of this task was stopped.

## Skills and rule files read

- `/home/altera/hornhoof-network/CLAUDE.md`
- `/home/altera/hornhoof-network/network-build/briefs/plan1-task8-writer.md`, with the plan's text in it from the top to
  the end of Review Focus, and the quality rules
- `/home/altera/hornhoof-network/network-build/briefs/plan1-task8-download-approval.md`
- Skills in `/home/altera/hornhoof-network/plugins/superpowers/skills/`: `test-driven-development` (with its
  `writing-good-tests.md`), `systematic-debugging`, `verification-before-completion`
- Not read: `hornhoof/AGENTS.md` and `hornhoof/templates/skills/dev-engineering-rules.md`. The brief names them for
  Hornhoof, and this lane is the relay repo.
- Read only, nothing changed, in the real Hornhoof tree: `apps/server/src/modules/link/client.ts:15-50` and one grep hit,
  `apps/server/src/auth/tunnel.ts:26-29`.

## Files changed

- Created: `relay/test/caddy.sh`, `relay/test/test_edge_today.py` (31 tests)
- Modified: `relay/test/harness.py`
- Modified, by the lead's ruling on my concerns, only these lines: `README.md`'s "Run the tests" (openssl, Caddy 2.11.8 with
  its SHA-512, `sh relay/test/caddy.sh`, Caddy among what the tests start) and `.github/workflows/tests.yml`'s shellcheck list
  (`relay/test/caddy.sh`).
- `relay/relay.py` and `Caddyfile` have no diff against `lanebase`.

## Final results, on the code as it stands now

All three ran through `remote.sh` from one final state of the lane, with `REMOTE_EDGE_TREE` set to the lane.

| Run | Command | Result | Log in `network-build/runs/` |
|---|---|---|---|
| Done when, Python 3.12 | `sh relay/test/caddy.sh && python3.12 -m unittest discover -s relay/test -v` | 171 tests, OK | `p1t8-final312.log` |
| Done when, Python 3.14 | the same with python3.14 | 171 tests, OK | `p1t8-final314.log` |
| Gates | `gates-relay.sh lanebase`, then `mutate-helper.sh ... relay/test/harness.py` | exit 0 | `p1t8-finalgates.log` |

These three came before the README and workflow lines. After those lines, `test_public.py` ran locally on Python 3.12: 6 tests,
OK; the whole suite did not run again, since neither file holds code. shellcheck 0.11.0 ran through `remote.sh` on
`relay/test/caddy.sh` and `relay/test/frp.sh`: exit 0, no findings, so nothing changed in the script
(`remote-p1t8-shellcheck-20261104-184127-341826.log`).

The gates' own coverage run of the whole suite also gave 171 tests, OK. An earlier round of the same runs (`p1t8-full312.log`,
`p1t8-full314.log`, `p1t8-gates.log`, 166 tests each, OK) came before the tests that killed the survivors.

## Gate numbers

- crapper: every function under 10. The highest is `Stack.close`, CC 9, coverage 100%, CRAP 9.0, which this task changed
  (two more cleanups). Then `Stack.client` 7.0. Everything else is under 7.
- dryer `--threshold 0.8`: "No duplicate candidates found."
- mutator on `relay/test/harness.py`, through `mutate-helper.sh` because the tool skips paths under `test/`, scoped to
  `test_edge_today.py`: 46 killed, 0 survived, 10 uncovered.
- The 10 uncovered are all on lines outside this task's diff, checked against `changed-lines.sh`: lines 274, 276, 282, 356,
  387, 537 are continuation lines of older multi-line statements, which coverage.py gives no record of, so the tool reads
  them as uncovered though they run. Line 352 is the older "did not become ready" raise, which the whole suite never
  reaches. I moved it into `_wait_ready` without changing it, so git shows it as context. Reaching it takes a 15 s wait.
- `caddy.sh` is shell, and no gate measures it. Its behavior is tested through `CaddyDownloadTests`.

## How each test failed first

| Tests | Failure before the code |
|---|---|
| `CaddyDownloadTests` (3) | `FileNotFoundError` on `relay/test/caddy.sh` in `setUp`: the script did not exist |
| `RenderTests` (2) | `ImportError: cannot import name 'render_caddyfile'` |
| `test_stub`, `test_api_through_caddy`, `test_reserved_and_unknown`, `test_http_mode_company`, `test_blocked_410` | `TypeError: Stack.__init__() got an unexpected keyword argument 'caddy'`. With the first harness, `ConnectionRefusedError` from `https` while Caddy was still starting, which led to the failed-answer contract |
| `test_server_name_is_what_the_handshake_carries` | `TypeError` on `sni` |
| `test_method_and_body_reach_the_company` | `TypeError` on `method`, then 415 from the relay, so the test moved to a small server of its own (see Failures) |
| `test_kept_connection_carries...`, `test_kept_connection_never_dials...`, `test_close_ends...`, `test_keep_on_a_refused...` | `TypeError` on `keep` |
| `test_refused_connections_read_as_failures` | `ConnectionRefusedError` raised from `http` |
| `test_reload_that_never_finishes_raises` | `TypeError` on `within`; also fails on `>=` in the reload wait: `RuntimeError not raised` |
| `test_unknown_way_in_is_refused` | `ValueError not raised` |

These tests passed at once, because the code came before them or because they pin what the edge already does. I broke a
copy of the tree for each, never the lane, and watched the test fail:

| Test | Break | Failure |
|---|---|---|
| `test_caddy_listens_on_loopback_only` | no `default_bind` | `OSError not raised`, both ports |
| `test_caddy_state_stays_in_the_test_folder` | no `XDG_DATA_HOME` (`HOME` stayed in the test folder) | `False is not true` |
| `test_rendered_file_points_at_nothing_of_the_droplet` | `:8080` left unreplaced | lists differ, naming the line |
| `test_every_site_shows_the_test_certificate` | `www` taken out of the certificate | lists differ, three hosts |
| `test_caddy_asks_for_no_certificate` | a `probe.invalid` site on `tls internal` with no guard, no outside network | `'tls.obtain' unexpectedly found`. This ran when the check still sat in one test with the certificate check; I split them afterwards |
| `test_reload_leaves_a_tunnel_alone` | reload by restarting Caddy | `404 != 200`. It fails at the status assertion, so its login count assertion has never been seen failing |
| `test_http_answer_names_its_own_port` | `_local_port = 0` | `0 not greater than 0` |

Survivors of the first mutator run, each killed by a new test that I watched fail on that mutant:

| Mutant | Test | Failure on the mutant |
|---|---|---|
| `_ensure_binaries` `check=True` to `False` | `test_failed_download_script_stops_the_run` | `CalledProcessError not raised` |
| `_openssl` `check=True` to `False` | `test_unreadable_certificate_raises_instead_of_naming_nothing` | `CalledProcessError not raised` |
| `_failed` default `local_port` 0 to 1 | `test_refused_connections_read_as_failures` (one more field) | tuples differ, both ports |
| `caddy` default `False` to `True` | `test_no_caddy_unless_asked` | `_Process object is not None` |
| uncovered: "exited during startup" raise, `+` to `-` | `test_process_that_exits_during_startup_raises_with_its_log` | `TypeError` in place of the `RuntimeError` |
| uncovered: `admin`'s `check=True` to `False` | `test_admin_command_that_fails_raises` | `CalledProcessError not raised` |

The last two uncovered sets, in `_start_caddy`, `admin` and `https`, were continuation lines. I split those statements, with no
change in behavior, so that the tool can measure them. The final run shows them killed.

## Failures met, and what they turned out to be

1. `test_stub`: 301, plan says 308. `test_http_mode_company`: `xff` is `127.0.0.1, 127.0.0.1`, plan says `127.0.0.1`. See
   Deviations 1 and 2. Neither is the harness. Traced hop by hop: direct to frps with no XFF gives `127.0.0.1`; with XFF
   `203.0.113.9` gives `203.0.113.9, 127.0.0.1`; through Caddy and frps gives `127.0.0.1, 127.0.0.1`.
2. `test_api_through_caddy` went 503 once, after passing before. Root cause: the relay's watcher probes frps every 0.5 s
   (`WATCH_INTERVAL_S`) and health says 503 until its first good probe, on purpose. Sampled right after a stack starts, it
   read 503 for about 0.3 s and more. It passed before only because Caddy took longer to start. The test now waits on the
   answer, up to 10 s, as `wait_health` does in `test_restart.py`.
3. `test_public` caught two lines of mine: `\nhornhoof.org` in the harness reads as the host `nhornhoof.org`, and a comment held
   an address of the 127 range. Both lines changed; `test_public.py` did not.
4. A run took 88 s against 14 s. I timed each step: a stack starts in about 1 s and a request takes about 50 ms. The load
   average was 45 at that moment, from the machine's other work. It was not the code.

## Deviations from the plan

1. `https('www.hornhoof.org')` is pinned at 301, not 308. The Caddyfile says `redir ... permanent`, which real Caddy 2.11.8
   answers with 301. Only its automatic http to https redirect is 308. The lead's ruling.
2. The echo's `xff` is pinned at exactly `127.0.0.1, 127.0.0.1`, not `127.0.0.1`, with a comment: the visitor stands first,
   which is what Hornhoof reads. The lead's ruling; it covers Task 9's plan line 731 too.
3. Two replacements more than the plan lists, both in the global block: `default_bind 127.0.0.1` and `auto_https
   disable_certs`. See the rulings below.
4. `Stack.reload_caddy()` sends SIGUSR1 and waits for Caddy's log line, because `admin off` leaves no endpoint for `caddy reload`.
   It has an optional `within`, which the raise test uses.
5. `Stack.admin(*args)` is new and not in the plan's interfaces. `reload_caddy` and `test_blocked_410` need it.
6. `keep=True` on a failed connection returns `(Answer, None)`, since there is no connection to give.
7. `https`'s keyword-only order is `sni, keep, method, body`, where the plan lists `sni, method, body, keep`. Callers are the
   same. `keep`'s default had to sit on the line coverage records for the mutator to measure it.
8. Tests beyond Step 1's five. Step 1's five, and `StackRequestTests` and `StackCaddyTests`, run on `Stack(tmp, caddy=True)`.
   `CaddyDownloadTests`, `RenderTests` and `StackFailureTests` test the script, the renderer and failure paths without one.
9. `_ensure_frp` became `_ensure_binaries(script)`, shared by both scripts. No other file called it.

## Rulings, for the ledger

Ruling: test Caddy gets `default_bind 127.0.0.1` - why: this machine belongs to a family and has no reason to show a test server on its network - cost if wrong: none found; `test_caddy_listens_on_loopback_only` proves it on Linux and passes without proving anything on macOS, where the other loopback address is not configured.

Ruling: test Caddy gets `auto_https disable_certs` - why: a site that the replacements miss then fails its handshake instead of asking for a real certificate for a real domain; checked with a `probe.invalid` site, nothing real: handshake failed, no `tls.obtain` or `acme` in the log - cost if wrong: the test edge differs from the droplet in this one setting, and only for sites with no certificate, of which it has none.

Ruling: the test `blocked.caddy` swaps the droplet's pages folder with a plain replace that does not raise - why: `admin banned-caddy` prints no such line while nothing is banned, and a wrong folder still shows, as 404 in place of 410 - cost if wrong: none found.

Ruling: `RELAY_CADDYFILE` stays the harness's one-line stub on a Caddy stack - why: smallest edit, no test here needs more - cost if wrong: on a Caddy stack the relay reserves only `www`, so a later test that binds a reserved name there must point it at the rendered file.

Ruling: `_dns_names` reads certificates with an openssl process, cached - why: `ssl` gives no parsed certificate for a connection it did not verify, and the cache keeps Task 10's burst of 200 connections from starting 200 processes - cost if wrong: small; a test must not change the shared list in `cert_names`.

Ruling: `Answer.headers` is a plain dict with the names as the server sends them - why: the plan's shape - cost if wrong: a repeated header keeps one value and a lookup is case-sensitive; no test here needs more.

## Downloads and the outside world

- From GitHub, plain requests only: the release's `caddy_2.11.<n>_checksums.txt` for n from 0 to 20, to find the newest
  (2.11.8; 2.11.9 to 2.11.20 answer 404), that file twice more, and `caddy_2.11.8_linux_amd64.tar.gz` once.
- The archive passed its SHA-512 check. `caddy version` says `v2.11.8`. All four values in `caddy.sh` compared equal to
  the release's file by command.
- Nothing touched the droplet, hornhoof.org, Docker on this machine or anything outside `~/hornhoof-network`. No certificate
  was requested from anyone. Caddy's state stays in each test's folder.

## Concerns

1. The macOS archives were never downloaded or run. Their checksums match the release's file, and the address each platform
   asks for is tested with a fake `curl` and `uname`. The lead ruled: leave as is, note it here.
2. `caddy.sh`, as `frp.sh`, keeps any `caddy` already in `.bin/`, so a later version bump will not replace a stale binary in a
   tree that has one.
3. The droplet's own reload is `systemctl reload caddy`, and the test's is SIGUSR1. Both reread the file, and I have not run the
   first. Task 13 compares `2.11.8` with the droplet's `caddy version`.

Settled by the lead: README and the workflow's shellcheck list got their lines (see Files changed), shellcheck ran with no
findings, and not reading `hornhoof/AGENTS.md` is fine for the relay repo.

## Log

1. Read the brief, the rules and the skills; read the harness, the Caddyfile, `frp.sh`, the relay's admin code and `client.ts`.
2. Found the newest 2.11 and its checksums. Cycle 1: `caddy.sh` tests red, script, green, real download.
3. Tried SIGUSR1 on the real binary with `admin off`, in a throwaway folder: it reloads and logs when done.
4. Cycle 2: renderer. Cycle 3: Step 1's five tests red, harness, green but for two plan facts. Traced them and told the lead.
5. Cycle 4: the harness's contract tests red, code, green. Moved the method and body test after the 415.
6. Debugged the 503, fixed the test. Broke copies to prove the early-green tests. Simplified the harness: dropped a `try` in
   `_tls_socket` that could never fire (`wrap_socket` detaches the socket first and closes its own on a failed handshake), the
   two `_ensure_*` wrappers and the doubled openssl call.
7. Fixed the two lines `test_public` flagged. Remote runs: 166 OK on both Pythons, gates with 4 survivors.
8. Lead's ruling on the two plan facts arrived. Killed the survivors, each seen failing on its mutant first, and split the
   statements coverage could not measure.
9. Final remote runs: 171 OK on both Pythons, gates exit 0. Removed my temporary files from `network-build/tmp`.
10. Lead's ruling on the concerns: added the README and workflow lines, reran `test_public.py`, ran shellcheck through `remote.sh`.

## Fix round 1 (round-1 review findings)

Skills read: test-driven-development, systematic-debugging, verification-before-completion; CLAUDE.md. Mutator not run.

1. Wrong-checksum test: the fake `curl` now serves a real `.tar.gz` holding a `caddy` entry, and the test asserts `FAILED` in the output as well as exit status and an empty `.bin`. Red: with both `sha512sum`/`shasum` checks cut out of a copy of `caddy.sh`, all six subtests failed (script exited 0 and installed the fake). Check restored, green.
2. `.github/workflows/tests.yml`: added `- run: sh relay/test/caddy.sh` after the frp.sh step.
3. `_dns_names` now wraps a cached tuple and hands each Answer its own list. New test `test_each_answer_owns_its_certificate_names` failed first with the old shared list (appended name leaked), green after.
4. `test_method_and_body_reach_the_company`: recorder threads are daemon, the serve thread is joined in cleanup.

Runs (REMOTE_EDGE_TREE=lane): python3.14 172 tests OK; python3.12 172 tests, 1 failure: test_restart_burst (plugin calls rejected after restart, 900 ms+, load related, the known finding); gates-relay.sh lanebase: crapper all 1.0, dryer no duplicate candidates.
