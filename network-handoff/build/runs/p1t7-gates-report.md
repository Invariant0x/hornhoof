# Plan 1 Task 7, the last two gates: writer's report

Status: DONE_WITH_CONCERNS. Both gates are met. The concerns are in "Concerns" below. Nothing is staged or committed; the
tree sits on bd24cc1 as before.

## Ivan's ruling on the mutator

After this report was first handed in, the lead passed on Ivan's ruling, which overrides the brief: writers no longer run
mutator, it runs once at the plan's review, and survivors come back then as findings. Task 7 hands in with its tests, crapper
and dryer. The mutator results below were already finished when the ruling came, so they stay here as a record and are no
longer what this task hands in on. The harness fix stays, because the plan-level run needs it.

## Skills and rule files read

- `plugins/superpowers/skills/test-driven-development/SKILL.md` and its `writing-good-tests.md`
- `plugins/superpowers/skills/systematic-debugging/SKILL.md`
- `plugins/superpowers/skills/verification-before-completion/SKILL.md`
- `CLAUDE.md`, `network-build/briefs/plan1-task7-gates.md` (with the plan's top through Review Focus and its quality rules)
- `hornhoof/AGENTS.md`, `hornhoof/templates/skills/dev-engineering-rules.md`
- `network-build/runs/p1t7-codex-detail.md`, `network-build/progress.md`

## Results

| Gate | Result |
|---|---|
| Mutator can see the relay | Line 385 (`name_live`): before the fix 0 killed, 2 survived, exit 3; after it 2 killed, 0 survived |
| CRAP | `create_binding` 16.6 -> 4.0. Worst among functions this task added or changed: `binding_body` 8.0 |
| Dryer at 0.8 | `No duplicate candidates found.` (`{:candidates []}`) |
| Mutator, `mutate.sh` on the changed lines | 31 killed, 0 survived, exit 0. 13 uncovered in the file, none on a changed line |
| Mutator, `binding_body`'s 8 sites (see Concern 2) | 8 killed, 0 survived, exit 0 |
| Suite on 3.12 under coverage, second gate run | 152 tests, OK |
| Suite on 3.14 | 152 tests, OK |

## Gate 1: the mutator's view of the relay

Reproduced first, as the brief asks, with the fix not yet made. Then the same line after it.

| Run | Where | Test command | Result | Log |
|---|---|---|---|---|
| Before | this machine, 2 workers | `python3.12 -m unittest relay.test.test_keys` | `SURVIVED 385 0 -> 1`, `SURVIVED 385 == -> !=`, exit 3 | `runs/p1t7-gates-mutator-before-fix.log` |
| After | home-api, `MUTATOR_WORKERS` | the same | `KILLED 385 0 -> 1`, `KILLED 385 == -> !=`, exit 0 | `runs/remote-p1t7-line385-20261104-161931-12598.log` |

The fix turns `.resolve()` into `.absolute()` in `harness.py`'s `ROOT` and `BIN`, and in `ROOT` of `test_route.py` and
`test_peers.py`, because both load relay.py themselves. `test_setup.py` and `test_public.py` keep `.resolve()`: neither
loads relay.py. A one-line comment says why at each changed `ROOT`. Nothing else in the harness changed.

## Gate 2: `create_binding`

Pinned first, then split, then the same tests again. `create_binding` keeps its name and its order of checks.

| Function | Where | Holds | CC | CRAP |
|---|---|---|---|---|
| `binding_body` | `relay/relay.py:1289` | the 415 and the three 400s, in their old order | 8 | 8.0 |
| `name_to_bind` | `relay/relay.py:1308` | random or requested name, the 400 and the 409 | 4 | 4.0 |
| `create_binding` | `relay/relay.py:1323` | the lock, the 429, the store, the 201 | 4 | 4.0 |
| `creation_wait` | `relay/relay.py:862` | pruning and both hourly limits; returns 0 or seconds, as `Window.allow` does | 3 | 3.0 |
| `random_free_name` | `relay/relay.py:873` | the random-name loop, which still never calls `name_live` | 3 | 3.0 |
| `store_new_binding` | `relay/relay.py:881` | the key and the two inserts | 1 | 1.0 |

Status codes, error bodies and `Retry-After` values are as they were. Refusals are still sent inside the lock, as before.
One internal difference with no visible effect: the count of all creations is no longer read when the per-address limit
has already answered.

The other functions this task changed, from the second gate run, all at 100% coverage: `plugin_decide` 6.0, `do_POST` 6.0,
`authenticate_call` 4.0, `key_answer` 4.0, `requested_name_reason` 3.0, `ping_key_matches` 3.0, `handle_one_request` 3.0,
`name_answer` 3.0, `store_link_key` 2.0, `name_live` 1.0, `retain_ping_keys` 1.0, `visitor_key_answer` 1.0, `init_db` 1.0.
`admin` stays at 17.3, not changed by this task, as the brief says.

## Mutator details

Second gate run, `runs/remote-p1t7-gates2-20261104-171927-151496.log`: 31 killed, 0 survived. Per function: `creation_wait`
8, `store_link_key` 5, `ping_key_matches` 4, `authenticate_call` 3, `do_POST` 3, `key_answer` 2, `name_live` 2,
`name_to_bind` 1, `random_free_name` 1, `requested_name_reason` 1, `visitor_key_answer` 1. All ran on
`relay.test.test_keys`; no site needed another test module.

The 13 uncovered sites are at lines 350, 404 (5), 582, 779 (3), 1254, 1386 and 1421. I compared them with
`changed-lines.sh` and none is on a changed line. They are older code, left alone.

The one survivor found, in the first gate run:

- `relay/relay.py:994`, `or -> and` in `ping_key_matches`, reached with a key that is truthy and not a string. The mutant
  calls `key_hash` on it and raises instead of refusing cleanly.
- Killed by adding `5` and `['wrong']` to the invalid keys in `test_r6_1_retired_ping_cannot_bypass_ban_release_or_rebind`.
- Seen first as `SURVIVED` (`runs/p1t7-gates-survivor994-before.log`), then `KILLED` (`runs/p1t7-gates-survivor994-after.log`),
  and `KILLED` again in the second gate run. Those two local logs also list other lines. I read those as results carried
  over from the earlier snapshot, because `--lines 994` selected only that line; I did not confirm it from the tool's source.

No mutant is claimed equivalent, so there is nothing for the lead to rule on there.

## Tests added

All in `relay/test/test_keys.py`, which now has 29 tests. `setUp`, `bind` and `api` moved up into a base class,
`RelayInProcess`, so that the new class can share them. `KeyAuthorizationTests` keeps its tests.

New class `BindingRequestTests`, 11 tests. They pin the refactoring, so they passed on the old `create_binding` by design;
21 focused tests passed before the split and the same 21 after it. Their failing side is the mutator: `creation_wait`'s 8
and `binding_body`'s 8 sites are all killed.

- `test_binding_wants_a_json_content_type`
- `test_binding_refuses_a_body_it_cannot_use`
- `test_binding_name_must_be_a_non_empty_string`
- `test_binding_refuses_a_name_it_may_not_give`
- `test_binding_without_a_name_gets_a_random_one`
- `test_binding_answers_and_stores_the_name_it_gave`
- `test_binding_limit_per_address_waits_for_its_oldest`
- `test_binding_limit_forgets_what_is_older_than_an_hour`
- `test_binding_limit_keeps_what_is_exactly_an_hour_old`
- `test_binding_limit_for_all_addresses`
- `test_binding_limit_per_address_goes_before_the_one_for_all`

New in `KeyAuthorizationTests`: `test_r6_1_key_is_answered_only_on_its_own_path`. It passed when written, since the code was
already right; `do_POST`'s three sites on changed lines are killed.

The new tests compare keys only through booleans and fixed messages, and check the status before reading a body, so a
failure cannot print a generated key. They do assert exact error messages, which `writing-good-tests.md` warns against as a
change detector; here the brief requires error bodies to stay exact.

## Files changed in this round

- `relay/relay.py`: the split above. No other change.
- `relay/test/harness.py`, `relay/test/test_route.py`, `relay/test/test_peers.py`: the `ROOT` and `BIN` fix.
- `relay/test/test_keys.py`: the tests above.

The earlier writer's work in `relay/relay.py`, `relay/hornhoof-relay`, `relay/test/test_route.py` and
`relay/test/test_sync.py` is kept as it was.

## Commands run and results

| What | Command | Result |
|---|---|---|
| Pins on the old code, then on the split | `light.sh python3.12 -m unittest relay.test.test_keys.BindingRequestTests relay.test.test_keys.KeyAuthorizationTests` | 21 passed, both times |
| First gate run | `remote.sh run p1t7-gates`: `gates-relay.sh bd24cc1`, then `mutate.sh` | 152 ran, `test_restart_burst` failed; 16 killed, 1 survived, 69 uncovered on stale coverage. Superseded |
| Second gate run | `remote.sh run p1t7-gates2`: coverage steps, `gates-relay.sh bd24cc1 --no-tests`, `mutate.sh` | 152 passed, gates exit 0, mutator exit 0 |
| `binding_body`'s sites | `light.sh mutator --use-existing-coverage --mutate-all --lines 1291,1299,1303`, test command `relay.test.test_keys.BindingRequestTests` | 8 killed, exit 0. `runs/p1t7-gates-binding-body-mutants.log` |
| 3.14, whole suite | `remote.sh run p1t7-suite314`: `heavy.sh python3.14 -m unittest discover -s relay/test -v` | 152 passed in 493 s |
| Final test text, both Pythons | `light.sh <python> -m unittest relay.test.test_keys.BindingRequestTests relay.test.test_keys.KeyAuthorizationTests relay.test.test_public` | 27 passed on 3.12, 27 on 3.14 |
| Tidiness | `git diff --check`; em dash count on the changed Python files; `git diff --cached` | clean; 0; nothing staged |

The logs of this round hold no 43-character key-shaped string (counted with grep, without printing a match). No frps, frpc or
relay process of mine is left on this machine.

## Concerns

1. **`test_restart_burst` failed once.** In the first gate run on home-api, under coverage: `NewProxy` calls were rejected
   after the restart, one of them at 951.3 ms. It passed in the second gate run and on 3.14, so 1 failure in 3 whole-suite runs
   there. The lead says test-infra is on it and that it also fails on committed code. I did not touch it or look for its cause.
2. **`changed-lines.sh` misses moved code.** Git aligned `binding_body`'s lines with the old `create_binding`, so they read as
   unchanged and `mutate.sh` selected none of its 8 sites. I ran those separately on `BindingRequestTests`, on this machine
   since it is a few fast tests. A later refactoring can hide the same way, and the lead may want to know that.
3. **The last test edit came after both whole-suite snapshots.** Four expected values in `BindingRequestTests` went from
   `self.relay.DOMAIN` and `MAX_BODY` to literals, as `writing-good-tests.md` asks. The whole suites did not run on that text;
   the 27 focused tests above did, on both Pythons. relay.py did not change after the second gate run began.
4. **The before and after runs of Gate 1 ran on different machines,** because the lead moved heavy runs in between. The command
   and the tree were the same apart from the fix, and `.resolve()` versus `.absolute()` explains the difference.
5. **A small duplication stays.** `sync_answer` keeps its own copy of the Content-Type check that `binding_body` has. Dryer finds
   no pair at 0.8 and the brief says to close the two gates and nothing else, so I left it.

## Deviations from the brief

- **The coverage step of the second gate run is not `gates-relay.sh` itself.** The lead said to use the coverage a failed run
  wrote, but the script exits before writing any when a test fails. So I ran its same coverage commands inline without stopping
  on a failure, then `gates-relay.sh bd24cc1 --no-tests`. The suite passed, so in the end the two would have given the same
  result. The script itself is not changed.
- **`relay/test/test_peers.py` is outside the files the brief lists,** but the brief's grep for `resolve()` leads to it.
- **Heavy runs went to home-api through `remote.sh`,** on the lead's later instruction, except the first reproduction, which
  ran here through `heavy.sh` before that instruction.
- **I wrote nothing into `progress.md`.** The rulings below are for the lead to copy, as the writers' reports do.

## Rulings for the ledger

- Plan 1 Task 7: Ruling: `ROOT` in test_route.py and test_peers.py also stops resolving symlinks, and test_setup.py and test_public.py keep it - why: the first two load relay.py themselves and the other two do not - cost if wrong: none outside tests.
- Plan 1 Task 7: Ruling: `binding_body`'s 8 mutants ran apart from `mutate.sh`, on BindingRequestTests - why: git reads moved lines as unchanged, so changed-lines.sh skips them - cost if wrong: none, it only adds checks.
- Plan 1 Task 7: Ruling: the coverage step ran as gates-relay.sh's own commands without stopping on a failed test - why: the script writes no coverage after a failure, which the lead's fallback needed - cost if wrong: a coverage figure from a failing suite, which did not happen here since the suite passed.

## Action log

1. Read the brief, the skills, the ledger and the earlier writer's report and diff.
2. Ran the mutator on line 385 unfixed: 2 survived. This reproduced the false survival.
3. Waited for that run by ending my turn; the lead later found me idle. From then on I used `remote-wait.sh`.
4. Applied the `.absolute()` fix and ran line 385 again on home-api: 2 killed.
5. Wrote the pins and the path test; 21 passed on the old code.
6. Split `create_binding`; the same 21 passed.
7. First gate run: `test_restart_burst` failed, so no fresh coverage was written and the mutator read a stale file. 1 survivor.
8. Showed the survivor alive in a focused run, added the non-string keys, showed it killed.
9. Second gate run and the 3.14 suite: all passed, 31 killed, 0 survived.
10. Found that `binding_body`'s sites had not been selected, ran them: 8 killed.
11. Read `writing-good-tests.md` and the rule files late, after writing the pins, and changed four expected values to literals
    as a result; re-ran the focused tests on both Pythons.
12. Checked the tree, removed my temporary files and wrote this report.

# Fix round after review round 1

Status: DONE_WITH_CONCERNS. The Critical, all four Important and the Minor from `runs/p1t7-r1-merged.md` are fixed, each with
a test seen failing first, except where a line below says otherwise. No mutator, as Ivan ruled. Nothing is staged or committed.
Skills followed: `systematic-debugging`, `test-driven-development` with `writing-good-tests.md`, `verification-before-completion`.

## Command results

| What | Result | Log |
|---|---|---|
| `remote.sh run p1t7-r1-gates`: `gates-relay.sh bd24cc1`, whole suite under coverage on 3.12 | 166 tests, OK, gates exit 0 | `runs/remote-p1t7-r1-gates-20261104-190318-388048.log` |
| `remote.sh run p1t7-r1-suite314`: whole suite on 3.14 | 166 tests, OK, exit 0 | `runs/remote-p1t7-r1-suite314-20261104-190321-388170.log` |
| crapper | Worst among changed functions 8.0 (`binding_body`, `sync_answer`). `create_binding` 4.0, `send_json` 6.0, `read_json` 5.0, `release_binding` 4.0, `declared_body_length` 4.0, `set_sync` 4.0, `request_bytes_may_remain` 3.0, `store_sync` 1.0 | same gates log |
| dryer at 0.8 | `No duplicate candidates found.` | same gates log |

`test_restart_burst` passed in both runs. Both snapshots were taken after my last edit. `admin` reads 17.0 now only because the
new `admin add` test covers one more line; its code is not changed.

## C1: request smuggling through unread bodies

**Reproduced first,** in process against the relay as it stood.

**The fix is one rule in one place.** Every route answers through `send_json`, so that is where the rule sits.
`Handler.request_bytes_may_remain` is true when a request carries Transfer-Encoding, or when its body was not read and its
declared length is not 0. `send_json` then sends `Connection: close`, which also makes the server end the connection, and tells
Caddy not to reuse it. No route has to remember anything. `read_json` is the one reader of a body and records that it read it.

`declared_body_length` is the one parse of Content-Length. It takes digits only, and one header only; anything else reads as
"cannot be trusted", so `read_json` refuses it and the connection closes. A clean request keeps its connection.

**Tests,** in the new `ConnectionTests` in `relay/test/test_keys.py`, with how each failed on the unfixed relay. A list is the
statuses that came back on one connection; a second number means the unread bytes ran as a request.

| Test | How it failed first |
|---|---|
| `test_unread_body_never_runs_as_a_request`: 14 route shapes (key, visitor-key, sync, DELETE, the bindings' 415, the plugin's 403, unknown paths, GET with a body) | Smuggled binding ran on each, for example `[401, 201]`, `[415, 201]`, `[404, 201]`; later cases `[401, 429]`, because the smuggled requests used up 127.0.0.1's limit |
| `test_a_plugin_call_in_a_body_never_reaches_the_plugin` | `[401, 200]`: the plugin answered |
| `test_transfer_encoding_closes_the_connection` | Request right after the headers `[401, 201]`; any coding `[401, 201]`; a route that reads its body `[400, 201]`; the plugin `[200, 201]`; real chunks: no `Connection: close` |
| `test_a_length_that_cannot_be_trusted_reads_nothing` | `abc` and `-5` `[400, 501]`; `+2`, `0_2`, two differing and two equal headers `[201, 201]` |
| `test_a_body_over_the_limit_closes_the_connection`, `test_a_big_unread_body_still_gets_its_answer` | Connection stayed open |
| `test_a_new_key_survives_a_body_and_a_good_request_behind_it` | `[200, 501]`: the good request was read as `{}GET` |
| `test_clean_requests_keep_their_connection`: plugin calls twice, no body, an empty body, a body read in full | Passed before and after by design; it fails if the rule closes too much |

With real chunks the smuggled request did not run even before the fix, because the size line breaks the next parse and the
relay closes. The direct cases above are what run.

**My first red run failed for the wrong reason.** The helper looked for a status only at the start of a line, and a second answer
follows the first one's JSON with no line break, so it hid the very bug and most cases failed on "must close" instead. I saw that
in the failures, fixed the helper, added a comment saying why, and the table above is from the run after that.

**What `POST /key` with a `{}` body did after this round:** 200 with the key, then the connection closed. The lead then ruled that
the route reads its body first; see "One more fix" below, which replaces this.

## Important and Minor

| Finding | Test | How it failed first | Fix |
|---|---|---|---|
| I1, a freed name's sync record | `KeyTests.test_r2_4_a_freed_names_sync_record_goes_with_it`, through real frps: rebind, empty record, a post with epoch 1 is taken | The new owner saw `{'state': 'on', 'copy': 'bbbbbbbb', 'epoch': 900, ...}` | `sync` is in `BINDING_LIFETIME_TABLES`, deleted in `release_binding`'s transaction, under its guard |
| I1, the same promise across a race (see Concern 1) | `test_r2_4_a_sync_post_authorized_before_a_release_cannot_reach_the_next_owner` | `200 != 409`: the old owner's post was stored after the release | `store_sync` also requires the binding with the authorizing hash; a miss answers `not_holder` |
| I2, retired hashes after release | `test_release_takes_what_belongs_to_the_binding`, `test_admin_release_takes_what_belongs_to_the_binding` | `{'visitor_keys': 0, 'ping_keys': 2, 'sync': 1}` left behind | `ping_keys` is in the same list. README says what is kept and what a release deletes |
| I2, the guard | `test_refused_release_leaves_what_belongs_to_the_binding`: stale hash, then banned | Passed before and after: nothing was deleted before either. It fails if the new deletes lose their guard | Same list, same `EXISTS` guard |
| I3, trailing newline | `test_binding_refuses_a_name_it_may_not_give` with `globex\n`, `www\n`, `acme\n`; `test_admin_add_refuses_a_name_with_a_trailing_newline` | `503 != 400` for the three; `0 != 1` for `admin add`, which made the binding | `LABEL.fullmatch` |
| I4, the dead assertion | `test_route.py:190` is the test | See below | `started(name, within=2)` |
| Minor, the docstring | None: prose earns no test | Not applicable | `list\|add\|ban\|...` |

**I4 cannot fail first on a correct relay, so I proved it can fail.** In a temporary copy, since removed, I made the relay let the
proxy in when the dashboard cannot tell. The fixed assertion fails on its own line 190 with `True is not false`; the old one passes
line 190 and only line 191 catches it. Log: `runs/p1t7-r1-i4-can-fail.log`.

## Concerns

1. **One fix goes past the list's wording.** The ruling for I1 names `DELETE FROM sync`. That alone leaves a post in flight across
   the release able to store the record after the delete, which I reproduced. I closed it the way the ledger's Task 6 ruling closed
   the visitor key ("an issuance authorized against an old binding cannot restore it for the new owner"), with a third argument to
   `set_sync` and `store_sync`. If you would rather not have it, it comes out as one test and those few lines.
2. **A generated key reached a log, from a new test of mine, and I have dealt with it.** `test_admin_add_refuses_...` ran `admin add`
   in process, and on the unfixed relay it succeeded and printed `{name, key}`. The key was a throwaway for that test's temporary
   database, never a real one, and I never printed it to the terminal. I found it with the key-shape scan: one log was masked in
   place, and the earlier one had already been overwritten by my next run. The test now keeps stdout out of its output and did not
   print on its next failing run. The scan finds nothing in this round's logs but the run's own 43-character name, in
   `runs/p1t7-r1-gates.log`.
3. **Closing with bytes still unread can make the kernel send a reset,** which could in principle cost a client its answer. For the
   answers that carry a key, "One more fix" below closes this. For the rest, the two unread-body tests passed 20 of 20 times on each
   Python on Linux loopback; they did not run on macOS. C1 is proven in process: the lead has ruled that there is no separate proof
   through Caddy.
4. **A chunked body read as empty.** Closed in "One more fix" below.
5. **The deployed relay is not touched,** so QUESTIONS.md item 7 still stands for David AI and Ivan. These tests run in process
   against the code in this tree; nothing was tried on hornhoof.org.

## Rulings for the ledger

- Plan 1 Task 7: Ruling: the connection rule sits in `send_json`, the one way every route answers - why: the lead's "one rule in one place" - cost if wrong: a client reconnects after a request that left bytes unread.
- Plan 1 Task 7: Ruling: Content-Length is digits only and one header only, else it cannot be trusted: 400 and close - why: `int()` took `+2` and `0_2`, and only the first of two headers counted, each of which ran a smuggled request in the test - cost if wrong: none found; a proxy sends plain digits.
- Plan 1 Task 7: Ruling: a sync post must still find the binding that authorized it when it stores - why: a post in flight across a release otherwise reaches the next owner, reproduced; same rule as Task 6's visitor key - cost if wrong: that post answers 409 `not_holder`.

# One more fix: `key_answer` reads its body first

Status: DONE_WITH_CONCERNS (see "For the re-review" at the end). The lead accepted the `store_sync` guard and ruled this fix, from Concern 3
above. C1 and this fix are proven in process, against the relay in this tree; there is no proof through Caddy, by the lead's ruling.

## Command results

Final tree, `remote.sh run p1t7-r1c`, log `runs/remote-p1t7-r1c-20261104-203537-563806.log`. No edit came after its snapshot.

| What | Result |
|---|---|
| `gates-relay.sh bd24cc1`, whole suite under coverage on 3.12 | 169 tests, OK, gates exit 0 |
| Whole suite on 3.14 | 169 tests, OK, exit 0 |
| crapper | Worst among changed functions 8.0 (`binding_body`, `sync_answer`); `read_json` 6.0, `send_json` 6.0, `key_answer` 5.0, `create_binding` 4.0 |
| dryer at 0.8 | `No duplicate candidates found.` |

No mutator, as Ivan ruled. An earlier run of the same command, `p1t7-r1b`, failed one test under coverage; see "A flaky test" below.

## The fix

- `key_answer`, which also answers the visitor key, calls `read_json` after it authorizes and before it commits. A body it cannot read
  answers 400 `invalid`, and nothing changes. So an answer holding a key never closes over unread bytes of its own request.
- `read_json` now also refuses Transfer-Encoding. This goes one step past your wording, for the same reason: a chunked body cannot be
  read, so the key route had to refuse it before committing, and one rule in `read_json` does that for every route. It also closes
  Concern 4: a chunked `POST /bindings` no longer makes a binding and hands out a key on an answer that closes over the chunks.
  Hornhoof's `relay.ts` sends a string body, so `fetch` gives it a Content-Length and this does not reach it.
- A body that is not JSON is refused too, as on the routes that use `read_json`.
- A refused or unauthorized request still closes over its unread bytes, under the C1 rule. Those answers carry no key.

## Tests, and how each failed first

All in `ConnectionTests`. Log of the red run: `runs/p1t7-r1b-red.log`.

| Test | How it failed first |
|---|---|
| `test_a_new_link_key_comes_with_its_body_read`, `test_a_new_visitor_key_comes_with_its_body_read`: the largest allowed body, then a good request on the same connection | `[200] != [200, 200]`: the connection closed over the unread body |
| `test_a_key_is_not_changed_by_a_body_it_cannot_read`, on both key routes: one byte over the limit, not JSON, not text, chunked, a length that cannot be trusted | `[200] != [400]` in all ten cases: a key was handed out on a body nobody read |
| `test_a_chunked_binding_makes_nothing` | `[201] != [400]` |

These replace `test_a_new_key_survives_a_body_and_a_good_request_behind_it`, which expected the close.

My first red run of the ten cases was partly wrong: only the first failed for its own reason, and the rest showed `[401]` because that
first case had really changed the key. Each case now starts from the old key, and the table is from the run after that.

## A flaky test, found by the gates

`test_r6_1_change_key` failed in the coverage run of `p1t7-r1b`: `relayStarted` differed by one second between two reads of the route.
It passed on 3.14 in the same run. It compared the whole route body, and `relayStarted` moves whenever the watcher sees frps answer
after a start or a failure, whatever the key does. The test came with Task 7's earlier code; this round's fix did not cause it.

- **Reproduction:** in a temporary copy, since removed, with the watcher slowed and a pause between the two reads, the old comparison
  failed on `relayStarted` alone, two runs of two. With only the slow watcher it passed, so the window is narrow. I forced the
  mechanism; I did not reproduce the failure at natural timing, and the log cannot say whether a first answer or a recovery moved it.
  Log: `runs/p1t7-r1b-flake.log`.
- **Fix:** the test compares all of the route but `relayStarted`, so it no longer checks that field. A key change does not touch it, and
  `test_restart.py` covers it. My first attempt waited for `/health` first, and I took it out: it would still race a later recovery.

## For the re-review

1. **`read_json`'s refusal of Transfer-Encoding goes past the wording of the fix,** and it reaches every route that reads a body,
   the plugin too: a plugin call sent chunked now reads as `relay error: ValueError` and is refused. The suite's calls from real frps
   0.71.1 all still pass, so those carry no Transfer-Encoding. I did not read frp's source for this.
2. **`test_r6_1_change_key` no longer compares `relayStarted`.** That changes an assertion in a test already reviewed, for the reason above.

## Rulings for the ledger

- Plan 1 Task 7: Ruling: `read_json` refuses a request with Transfer-Encoding on every route - why: it cannot read that body, and the key routes must refuse it before they commit; one rule rather than one per route - cost if wrong: a client that sends chunked gets 400 where it got a reading of an empty body.
- Plan 1 Task 7: Ruling: `test_r6_1_change_key` leaves `relayStarted` out of its comparison - why: that field moves with the watcher, whatever the key does, which made the test flaky - cost if wrong: none found; test_restart.py covers the field.

# Round 3: a body cut short must not change a key

Status: DONE. This closes Antigravity's one Important from review round 2 (`runs/p1t7-r2-agy.md`). Proven in process, as before. Nothing
is staged or committed.

**The bug.** `self.rfile.read(length)` returns fewer bytes at end of stream without raising, and `read_json` took that as the whole
body. So a client that declared a length and hung up still got a key rotated, or a binding made, on a request that never arrived.

**Tests,** in `ConnectionTests`, sending less than a declared 20 bytes and then ending the sending side. The four bodies are no bytes,
only whitespace, a whole value (`{}`), and part of a value. Red run: `runs/p1t7-r3-red.log`.

| Test | How it failed first |
|---|---|
| `test_a_key_is_not_changed_by_a_body_cut_short`, on `/key` and `/visitor-key`; also checks that the old key still works on a new connection | `[200] != [400]` for no bytes, whitespace and a whole value; part of a value answered 400 but without `Connection: close` |
| `test_a_binding_is_not_made_from_a_body_cut_short`, on `/bindings` | `[201] != [400]` for the same three; part of a value likewise had no `Connection: close` |

Each now answers 400 with `Connection: close`, the connection closes, and nothing changes: no new key, no binding, no used creation.

**The fix.** `read_json` raises its `ValueError` when `len(raw) < length`, before it sets `body_read`. Every route that reads a body gets
this from that one place.

**Results**

| What | Result |
|---|---|
| `light.sh`, `relay.test.test_keys`, `test_sync`, `test_public`, on 3.12 and on 3.14 | 67 tests, OK, on each (`runs/p1t7-r3-task-tests.log`) |
| `remote.sh run p1t7-r3`: `gates-relay.sh bd24cc1`, whole suite under coverage on 3.12 | 171 tests, OK, gates exit 0 (`runs/remote-p1t7-r3-20261104-213237-672274.log`) |
| crapper | Worst among changed functions 8.0 (`binding_body`, `sync_answer`); `read_json` 7.0 |
| dryer at 0.8 | `No duplicate candidates found.` |

After the task-test run I wrapped four long lines in `test_keys.py`, text only, and re-ran `ConnectionTests` and `test_r6_1_change_key` on
3.12 (14 tests, OK); the gate run's snapshot has them. The whole suite did not run on 3.14 in this round, as the fix list asks only for
the task tests and the gates; 3.14 ran the task tests above before those line wraps. No mutator, as Ivan ruled.
