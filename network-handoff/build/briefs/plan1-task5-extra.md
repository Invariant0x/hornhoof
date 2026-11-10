- After Task 4: `write(sql, args)` is the one SQLite write helper (bounded by the plugin call's budget inside plugin
  calls, `relay error: busy` there, 503 `{error: 'busy'}` with `Retry-After: 1` on API paths). The sync post writes
  through it. "On disk before the answer" means the write has committed under `PRAGMA synchronous=FULL` before the
  200 is sent.
- The sync post's holder check reads frps (`route_of` under the per-name lock, Task 2): take the same lock for the
  check and the write, so a registration cannot slip between them, and guard the write by the generation read.
- Files holding a secret are written only through `write_private` (relay/private-file.sh), if this task writes any.
