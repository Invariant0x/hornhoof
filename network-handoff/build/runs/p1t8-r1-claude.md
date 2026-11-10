# Review of Plan 1 Task 8, round 1 (Claude, read only)

Package: `network-build/runs/p1t8-r1.diff`, lane `wt/p1t8` (lane diff against `lanebase` matches the package: 3 modified,
2 new files). The lead's full-suite log `p1t8-final312.log` says 171 tests OK; gates log says every function under CRAP 10
and no duplicate pair. I ran four focused tests through `light.sh` (OK, 4.2 s) and checked afterwards that no
`hornhoof-edge-` or `hornhoof-caddy-sh-` process stayed behind: none did.

Counts: Critical 0, Important 1, Minor 6.

## What I reproduced

- Checksums. Fetched `caddy_2.11.8_checksums.txt` from the release (a plain GitHub read, nothing sent) and compared each of
  the four values in `relay/test/caddy.sh:90-93` by command: all four match the file's lines for
  `caddy_2.11.8_{linux,mac}_{amd64,arm64}.tar.gz`. GitHub's releases list shows v2.11.8 as the newest 2.11 tag, so the
  pinned version is the plan's "newest 2.11 release". The comment at `caddy.sh:73` names the checksum file, as the plan
  asks.
- The check itself. A mismatch makes `sha512sum -c` exit 1 under `set -eu`, so `tar` and `install` never run and the
  EXIT trap removes the download folder. Correct code.
- Rendering. Loaded `harness.py` from the lane and rendered the real `Caddyfile` with `_caddy_replacements()` (dummy
  ports and certificate paths): every one of the 12 anchors occurs exactly once in the file, so `str.replace` touches
  one place each, and the rendered text is the real Caddyfile with only the ports, paths, certificates, the global
  block and the one `X-Test-Peer` line changed. `header -Server` occurs once and only in the `*.hornhoof.org` block,
  so the test-only header lands where the plan says. The tests do run against the real file's structure, not against
  something the harness wrote in its place; the only stand-ins are what the plan lists plus `default_bind` and
  `auto_https disable_certs`, both ruled on in the report.
- Outside reach. The only network call in a test run is `caddy.sh`'s own download on a tree without `.bin/caddy`,
  which the download approval allows. `CaddyDownloadTests` put a fake `curl` and `uname` first on PATH, so no
  download test reaches GitHub. Caddy runs with `admin off`, `default_bind 127.0.0.1`, `auto_https disable_certs` and
  explicit test certificates without an OCSP URL, so it asks nobody for anything. frpc `via='caddy'` dials 127.0.0.1
  with `serverName = "hornhoof.org"` only. Nothing reaches hornhoof.org or the droplet.
- 301 and `127.0.0.1, 127.0.0.1`: both as the ledger's ruling (progress.md:118); `apps/server/src/auth/tunnel.ts:29`
  takes the first address, so the pin matches what Hornhoof reads.
- Interfaces against the plan: `Stack(tmp, dashboard=True, caddy=False)`, `Answer(status, headers, body, cert_names,
  local_port, error)`, `Stack.https(host, path='/', *, sni, keep, method, body)` (keyword-only, order differs from the
  plan's listing, callers unaffected), `keep=True` gives `(Answer, KeptConnection)` with `.again(path)`,
  `Stack.http`, `Stack.client(..., via='frps'|'caddy')`, `Stack.reload_caddy()`, echo gains `xff`. All present.
  `Stack.admin(*args)` is an addition the plan did not list; harmless and needed by `reload_caddy`.
- Python 3.12: nothing newer; the lead's 3.12 run passed. No em dash in any of the five files.

## Important

1. `relay/test/test_edge_today.py:671-687`, `test_wrong_checksum_fails_and_installs_nothing`: the test passes with the
   checksum check deleted. The fake `curl` writes `not the release`, which is not a gzip stream, so `tar -xzf` fails on
   its own with exit 2 and the EXIT trap leaves `.bin` empty, which is exactly what the test asserts. I reproduced it:
   copied `caddy.sh` to `network-build/tmp/p1t8-claude-review/nocheck/`, removed lines 104 to 108 (the `sha512sum` /
   `shasum` block) with sed, ran it under the test's fakes: exit 2, `.bin` empty, one address recorded, every
   assertion of the test satisfied. What a person would get: the one test that is supposed to guard "a mismatch fails
   with nothing run" does not notice the guard missing, so a later edit that drops or breaks the check (a typo in the
   `command -v` branch, a wrong flag to `shasum`) ships with a green suite, and a tampered archive would then be
   extracted and installed. The brief's top item for this task is this check. What would make it right: have the fake
   `curl` hand back a real `.tar.gz` holding a `caddy` entry (any bytes), so only the checksum can stop the script, and
   assert the failure is the checksum's: `sha512sum -c` prints `FAILED` on stdout and `WARNING: 1 computed checksum did
   NOT match` on stderr. Seen failing first on a copy of the script without the check.

## Minor

1. `relay/test/test_edge_today.py:784-790`, `test_reload_leaves_a_tunnel_alone`: the writer's report says the
   login-count assertion (line 790) was never seen failing; only the 200/404 assertion was. A reload that reconnected
   the tunnel would still be caught only if `frpc` logged a second `login to server success` within the reload's
   window, which the test does not wait for. Not wrong, but the assertion it exists for is unproven.
2. `relay/test/harness.py:224-228`, `_dns_names`: `lru_cache` returns the same `list` object to every `Answer` with that
   certificate, so `Answer` is frozen but `cert_names` is shared and mutable. The writer's ruling names this cost. A
   `tuple` would remove it at no cost; Task 10's burst would still hit the cache.
3. `relay/test/test_edge_today.py:603-605`: the test module imports `_Process`, `_dns_names`, `_ensure_binaries`, private
   names of the harness, and `StackFailureTests` tests them directly. These test the harness's implementation, not what
   a later task sees. Acceptable for a test harness; noted against "test behavior, not implementation".
4. `.github/workflows/tests.yml:24-25`: CI runs `sh relay/test/frp.sh` as its own step but not `caddy.sh`, which the
   README's "Run the tests" lists next to it. The harness downloads Caddy inside the test run, so a download failure
   there shows as a test error rather than a failed step. Adding the step would match frp.sh and the README.
5. `relay/test/caddy.sh` repeats `frp.sh` almost line for line (os/arch cases, mktemp, traps, curl, checksum branch,
   install). The plan says "as `frp.sh`" and no gate measures shell, so this is by design; two scripts to fix when the
   download shape changes.
6. Writer's ruling "RELAY_CADDYFILE stays the harness's one-line stub": on a Caddy stack the relay reserves only `www`
   while Caddy reserves the whole list, so `bind('admin')` succeeds at the API and Caddy still answers 404 for it. No
   test here trips on it; a later test that binds a reserved name on a Caddy stack will.

## Checked and found right

- The rendered Caddyfile (see above). `test_rendered_file_points_at_nothing_of_the_droplet` would catch a missed
  `/etc/caddy`, `/var/www` or droplet port; `render_caddyfile` raises on a missing anchor (`RenderTests` prove it).
- `_write_blocked` turns `admin banned-caddy` into the test's `blocked.caddy` with a plain replace of the pages folder;
  with nobody banned the output is a comment line only, which Caddy imports fine (`test_reload_leaves_a_tunnel_alone`
  and `test_blocked_410` cover both states).
- Processes and ports: `Stack.close` stops Caddy and closes kept connections through the same `ExitStack`; a second
  `close()` (explicit then tearDown) is idempotent, as `test_close_ends_caddy_and_kept_connections` exercises. Caddy's
  state and HOME point into the test folder (`test_caddy_state_stays_in_the_test_folder`). After my focused run no test
  process remained.
- Secrets: binding keys go into `private` and are redacted from every process log; `Stack.admin` output is never
  printed; no key or token appears in a test message.
- README lines are true at this commit (openssl needed, Caddy 2.11.8 with SHA-512, Caddy among the started processes).
- TDD: the report lists how every test failed first; for tests green at birth it names the break and the failure. The
  one exception is Minor 1.

Temporary files: `/home/altera/hornhoof-network/network-build/tmp/p1t8-claude-review/` (the fetched checksum file and the
script copy without the check). Nothing in either repository was changed.
