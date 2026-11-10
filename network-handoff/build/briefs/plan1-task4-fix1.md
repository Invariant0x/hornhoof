Review of your Plan 1 Task 4 (Codex, judged by the build lead; the team lead asked for Fix A). Deviations 1, 2, 4,
5 and 6 are accepted; deviation 3 (the watcher's 0.5 s probe) is not, see item 5. Fix every item. For each: first a
test that fails on the code as it is now (run it, see it fail for the expected reason), then the fix. No commit, no
`git add`. Report each item with its test name and how it failed.

Fix A (from the team lead, must fix now): a file holding a secret is created world-readable for a moment.
`setup-relay.sh` writes `/etc/hornhoof-relay.env.new` with `cat > ... <<EOF` under root's default umask (0644 in
`/etc`, which every user can enter) and only then `install -m 640`; `/etc/frp/frps.toml.new` holds the frps password
the same way. A file holding the password must never exist with 0644, not even for a moment.
- Put one helper in a new file `relay/private-file.sh` (sourced by `setup-relay.sh` from its own folder, with a
  `# shellcheck source=private-file.sh` line): `write_private <dest> <mode> [group]` takes the content on stdin and
  ends with `<dest>` holding it at `<mode>` (and `root:<group>` when a group is given). The temp file beside `<dest>`
  is created already private: remove a stale one first, then `(umask 077 && : > "$tmp")` or
  `install -m 600 /dev/null "$tmp"`, then write into it, then `chgrp`/`chmod` to the final mode, then rename it over
  `<dest>` (`mv -f`, which keeps the mode). It tells its caller whether the content changed (frps restarts only
  when `frps.toml` changed, as today), for example by exit status or by leaving the old file untouched when equal.
- `setup-relay.sh` uses it for both `/etc/frp/frps.toml` (640, group frps) and `/etc/hornhoof-relay.env` (640, group
  hornhoof-relay). Nothing else in what the script does changes.
- Test first, in a new `relay/test/test_setup.py`: run `write_private` from `private-file.sh` (no root needed: leave
  the group out, a temp dir as the destination) with its stdin a pipe the test controls: write half the content,
  and while the helper waits for the rest, find the temp file beside the destination and check its mode is 0600 or
  tighter; then send the rest, close, and check the destination's content and mode. First write the helper the naive
  way the script does today (`cat > "$dest.new"` then `chmod`), run the test and see it fail with mode 0644, then fix
  the helper. Also check: an unchanged content reports "unchanged" and keeps the destination as it was; and
  `sh -n relay/setup-relay.sh relay/private-file.sh` passes.
- Add `relay/private-file.sh` to the `shellcheck` line of `.github/workflows/tests.yml`.

Codex's other findings (all accepted):
2. Important, relay.py:303: an expired budget sets `busy_timeout=0` but still runs the SQL; the reviewer reproduced
   an expired upsert creating generation 1. `write` refuses before executing when no time is left.
3. Important, relay.py:591: `touch()` swallows `WriteBusy`; a Login was accepted after 0.84 s on a locked database
   without updating `last_seen`. A busy write in a plugin call refuses the op with `relay error: busy`, as the plan
   says.
4. Important, relay.py:759: API write paths let `WriteBusy` escape; a contended `POST /bindings` dropped the
   connection (`RemoteDisconnected`). Answer it with a structured error (503 `{error: 'busy'}` with `Retry-After: 1`
   is the build lead's choice) on every API write path.
5. Important, relay.py:170: the watcher's dashboard probe uses 0.5 s; the plan says 1 s for each of its two probes.
   A good answer at 0.7 s was taken as frps down. Give the watcher its 1 s, through the same read helper with a
   timeout parameter rather than a second helper.
6. Important, test_restart.py:99: the relay-restart test samples the route API, not company traffic. Sample
   `stack.get('acme.hornhoof.org')` every 0.2 s throughout the restart and require every answer to be 200.
7. Important, test_restart.py:142: the busy assertion cannot see busy refusals, since the trace omits refusal reasons
   (the reviewer reproduced a busy refusal with no matching text). Assert the restart's expected plugin calls exist
   and none was rejected.
8. Important, test_restart.py:74: the health test allows 3 s where the brief says 503 within 2 s after `stop_frps()`.
   Enforce the brief's bounds (2 s down, 3 s back up).

Then the whole suite twice with `/opt/homebrew/bin/python3.12` and once with `python3`, `sh -n` on the shell files,
and the gates (`.../gates-relay.sh d6a50bc`); report all.
