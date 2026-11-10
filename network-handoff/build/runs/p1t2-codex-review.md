- **Critical**, `relay/relay.py:203`: The offline exception clears a young pending registration while frps may still show the previous registration’s offline record. Reproduced two accepted registrations and generation 2. Preserve the 10-second pending hold; adjust the earlier fact test’s setup instead. Deviation 1 is unsafe.
- **Critical**, `relay/relay.py:229`: An online route with no local row returns `empty`, allowing another registration. Log the name and raise `FrpsUnknown`, producing 503 and refusing registration.
- **Critical**, `relay/relay.py:177`: `frps_route` returns after finding HTTP without checking HTTPS. An offline HTTP record can hide a live HTTPS route. Read both endpoints and raise `FrpsUnknown` when both exist.
- **Critical**, `relay/relay.py:172`: A missing `clientID` is accepted as `None`; an incomplete offline answer can clear a held route. Validate required dashboard fields and treat incomplete answers as unknown.
- **Critical**, `relay/relay.py:205`: GET updates bypass the registration lock, and the update guard compares only second-resolution `since`. Reproduced a stale GET clearing a newer pending generation created in the same second. Serialize these operations and guard updates by generation.
- **Important**, `relay/relay.py:318`: Concurrent trace prints concatenate records onto one line, reproduced during review. The parser drops those records. Emit each complete JSON line atomically.
- **Important**, `relay/test/test_route.py:76`: The race test stops at the first success before checking every contender. It passed with only 6–9 parsed `NewProxy` calls. Wait for all ten distinct outcomes before asserting the winner, generation and timings.

Minor: none. Deviation 2’s refusal-message assertion is justified by R1.1.

Done when ran from the relay root:

`PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`

**19 passed, 1 failed**: the race test counted zero accepted trace records.

Gates ran using a temporary script copy with only `REPO` redirected to a `$TMPDIR` snapshot: **20 passed, 0 failed** under coverage; **CRAP passed** under the stated exceptions, highest new score **9.2**; **dryer passed**, no duplicate candidates.

Repository files remained unchanged.