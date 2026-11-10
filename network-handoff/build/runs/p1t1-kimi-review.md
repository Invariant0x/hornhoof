Review complete. I read every untracked file, compared the copies against `~/.hornhoof-edge/droplet/` (right set, all byte-identical; nothing private copied), diffed the open-source files against Hornhoof's in the network worktree (LICENSE and sign-off.yml byte-identical, others correctly adapted with the project name, no idea form, no discussions link), verified the darwin sha256 values against the official `frp_sha256_checksums.txt` from the v0.71.1 release (both match), verified the checkout pin matches Hornhoof's `images.yml` pin, and confirmed no em dashes/Cyrillic anywhere.

## Findings

**Critical:** none.

**Important:** none. Specifically checked and found sound:
- `test_public.py` implements every interface check from the brief; per the build lead's ruling it uses `git ls-files --cached --others --exclude-standard`; `test_private_words` failure messages name only the tracked file and the private-words line number, never the value.
- `harness.py` matches the interface exactly (env vars, config rendering from `relay/frps.toml` with the four keys replaced, `@WEB_PASSWORD@`, `custom404Page` dropped, `RELAY_FRPS_STARTED` written on each frps start, all methods present with the specified signatures). Keys/passwords are redacted from logs via `private=`.
- `frp.sh` checksums verified against the release asset; no-op when both binaries exist; comment names the checksum file.
- All seven tests in `test_today.py`/`test_frp_facts.py` assert the log lines and states the brief names; retries are bounded by the frp-resend facts (30 s / heartbeat timeout) and the measured delays are printed.
- README's seven headings, storage list, and "What it sees" agree with `relay.py`'s actual tables and Hornhoof's `SECURITY.md:53`; no fact is ahead of this commit.
- No Python newer than 3.12 (suite ran on `/opt/homebrew/bin/python3.12`); relay.py is untouched; nothing private, no leftover processes or listeners after a normal run.

**Minor:**
1. `relay/test/harness.py:64` — `do_HEAD = do_GET` makes the echo server write a body on HEAD responses. Harmless for these tests, but technically invalid HTTP; a separate `do_HEAD` that sends headers only would be cleaner.
2. `relay/test/frp.sh:6` — the early exit checks only that both binaries are executable; a partially downloaded/corrupt binary from an interrupted earlier run is not re-verified. Very low risk (downloads go to a temp dir and `install` is atomic), but a size or checksum re-check would be more defensive.
3. Informational: `test_no_ip_address` scans IPv4 literals only. That is exactly what the brief specifies, and `test_private_words` covers the droplet's addresses, so no gap against the brief.

## Done when

Ran from `/Users/0x/Projects/hornhoof-edge`:
`sh relay/test/frp.sh && /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`

Result: **13 tests, 13 passed, 0 failed** (86.9 s; frp.sh a no-op on the second run). Printed measurements: client-id retry 6.44 s, proxy-name retry 28.05 s. After the run: no frps/frpc/relay processes and no listening ports left behind (I also confirmed a standalone run of `test_frp_facts.py` leaves nothing). Step 12 was not reviewed, per instructions.
