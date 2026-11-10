# Batch 10 (relay): what the fix round does

Reports: `network-build/runs/batch10-relay-agy.md` (Antigravity) and `network-build/runs/batch10-relay-claude.md` (Claude). Read both from the top. Each fix from a failing test. Check each claim first; if one does not hold, say why and leave it.

## Important
1. `relay/test/test_traffic.py:97-102`: the boot-id and interface cases also drop `sent` below `seen_sent`, so `sent if sent < seen_sent else sent - seen_sent` passes all 15 tests. Test a new boot and a new interface with `sent >= seen_sent`, so that both reset conditions fail when broken. A person would get an undercount and a late or missing resize warning.

## Minor
2. `traffic_round` and `safe_traffic_round`: use `log_line`, not `print`.
3. `traffic_round`'s message: derive the number from `TRAFFIC_WARN_BYTES`.
4. Rename the parameter `sys` to `sysfs`, in `sent_bytes`, `count_traffic`, `traffic_round`.
5. `admin_add`'s refusal: reads oddly for a name never bound, and does not point at `/etc/hornhoof-relay.env`. Keep it one line and fixed; no name of a setting's value.
6. `new_link_key`'s docstring: say that a `null` body answers 400 `invalid`.
7. `test_keys.py`'s `RetiredKeyWordingTests` pins prose, so it goes: the two behaviour tests it names carry the promise.
8. `test_months_apart`: `localtime` in place of `gmtime` passes on a UTC machine. Make the UTC promise fail for the right reason with a direct test of `utc_month` under another `TZ` (set it and call `time.tzset()`, restore it after).
9. One test that `main` starts the traffic thread, the way the file tests other threads. If that costs more than a few lines, say so and leave it: A2's deploy check catches it.
