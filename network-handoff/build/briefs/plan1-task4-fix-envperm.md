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
