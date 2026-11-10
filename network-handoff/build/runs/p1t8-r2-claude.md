# Plan 1 Task 8, review round 2 (Claude fable, read only)

Package: `network-build/runs/p1t8-r2.diff`, checked equal to the lane `wt/p1t8` by its added and removed lines.
Temporary files under `network-build/tmp/p1t8-r2-claude/`, removed after the runs. All runs through `light.sh`.

## Important 1: the wrong-checksum test proves nothing. ADDRESSED

How checked:
- Copied `harness.py`, `caddy.sh`, `test_edge_today.py` to a folder of my own and ran `CaddyDownloadTests`: 3 tests OK.
- Cut the whole `if command -v sha512sum ... fi` block out of that copy's `caddy.sh` (no `sha512sum`, no `shasum` left)
  and ran again: `test_wrong_checksum_fails_and_installs_nothing` failed on all six subtests with `AssertionError: 0 == 0`,
  the script exited 0 and installed the fake. The other two tests still pass, so the failure is the check's and only the
  check's.
- A correct checksum installs, two ways: (a) a fake release whose SHA-512 I patched into the script copy: `sha512sum -c`
  says OK, exit 0, `.bin/caddy` is the archive's file; (b) the real release in a copy of the tree: download, `OK`, exit 0,
  `.bin/caddy version` says `v2.11.8`.
- `relay/test/test_edge_today.py:97-114`: asserts exit status, `FAILED` in the output, exactly one address asked for, and an
  empty `.bin`. The fake `curl` (lines 23-34) serves a real `.tar.gz` holding a `caddy` entry (lines 73-80), so `tar` no
  longer stops the script for the test.

## Minor: workflow step. ADDRESSED

`.github/workflows/tests.yml:16`: `- run: sh relay/test/caddy.sh` after the `frp.sh` step; the shellcheck line lists
`caddy.sh` too. By inspection.

## Minor: `_dns_names` shares one list. ADDRESSED

`relay/test/harness.py:106-114`: `_cached_dns_names` caches a tuple, `_dns_names` hands out `list(...)`. New test
`test_each_answer_owns_its_certificate_names` (`test_edge_today.py:304-307`) passes in the lane. Does it fail without the
fix: yes. In a full copy of the tree I put the old form back (`lru_cache` on `_dns_names` returning the `findall` list) and
ran that one test: `AssertionError: 'changed by one test' unexpectedly found in [..., 'changed by one test']`.

## Minor: recorder threads. ADDRESSED

`test_edge_today.py:231-237`: `daemon_threads = True`, serve thread `daemon=True`, cleanups registered as `server_close`,
`thread.join`, `shutdown`, which run in reverse: shutdown, join, close. The test passes in the lane. No test needed for
a hygiene fix. By inspection.

## New breakage in what the fix changed

None found. No em dash in the five changed files. No key or token in the test output. No Caddy, frps, frpc or relay process
left behind after my runs. `test_restart_burst` was not run here; it is the known finding, not this task's.
