# Codex lead stop report: Plan 1 Tasks 6 to 12

Stopped under Ivan's explicit rule after Task 6 review round 3 leaves a Critical. No task was committed in this continuation. Relay remains at 75e8a3d; Hornhoof network remains at 07928d7e. All four Task 6 pending files and their staged/unstaged state are preserved. No writer or source work for Tasks 7-12 began.

## Per-task state

| Task | Commit | Writer | Reviewers | Review rounds | Done when | Gates |
|---|---|---|---|---|---|---|
| 6 | None; base 75e8a3d | Kimi | Codex + Antigravity | 3 complete | Lead: 117 passed on 3.12 (379.528s) and 3.14 (377.617s); reviewers 117 passed each (384.429s /383.865s) | Fresh 117 coverage passed; highest changed CRAP 9.1; admin 29.4 improved; create_binding 26.2 unchanged; dryer 0 pairs at 0.8 |
| 7 | None | Not run (Codex planned) | Not run (Kimi + Antigravity planned) | 0 | Not run | Not run |
| 8 | None | Not run (Kimi planned) | Not run (Codex + Antigravity planned) | 0 | Not run | Not run |
| 9 | None | Not run (Codex planned) | Not run (Kimi + Antigravity planned) | 0 | Not run | Not run |
| 10 | None | Not run (Kimi planned) | Not run (Codex + Antigravity planned) | 0 | Not run | Not run |
| 11 | None | Not run (Codex planned) | Not run (Kimi + Antigravity planned) | 0 | Not run | Not run |
| 12 | None | Not run (Kimi planned) | Not run (Codex + Antigravity planned) | 0 | Not run | Not run |

Task 6 Done when commands, separately for each interpreter:

`nice -n 10 /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`

`nice -n 10 python3 -m unittest discover -s relay/test -v`

Actual gates: `L/gates-relay.sh 75e8a3d`, fresh coverage plus crapper and dryer. Gate coverage 117 passed in 424.709 s. The command passed but does not prove the new offline identity-squatting case safe.

## Open findings and stop reason

Critical C3: an offline legacy identity can reserve a client ID from another binding's namespace and block that binding's legitimate client startup. Antigravity's local native-frps result and the inspected online-only guard establish the gap. The lead grades its availability/identity-isolation impact Critical, above the reviewer's Important grade. Existing online takeover protections remain correct. The earlier absent/offline reconnect ruling was followed literally but now has a confirmed unsafe case; revising it needs an explicit follow-up decision. No fix or fourth review was launched after the three-round Critical stop.

Important residual I8: two `assertIsNone(visitor_key_hash())` checks at relay/test/test_peers.py637/660 can render a generated test key under a plaintext observation fault. Codex's extra cases detect this; Antigravity's I8 closure covers earlier probes but not those two. Preserved unfixed at the stop.

The third round closed old C1 online takeovers, C2 credential lifecycle/issuance/release/rebind/ban races and rollback, I1-I7, G1. Both final repository status/diff/hash snapshots are unchanged. No reviewer mutation. No matching relay/frp process remained in the final lead audit.

## Minors retained, not fixed

- M1: blocked-before-key error ordering, still a closed refusal.
- M2: second-login test may miss an eviction log event and falsely fail under unusual load.
- M3: README event list omits visitor-key rotation, whose log contains a name only.
- M4: delayed fake dashboard can emit socket-close stderr noise.
- M5: native Login helper constructor timeout leaves its socket until bounded Stack teardown.
- M6: DELETE docstring's 404 wording omits that it is an in-flight stale-authorization race; ordinary obsolete keys receive 401. Both deny the request.

## Every recorded Codex-lead ruling since the authorized resumption

- Plan 1 Tasks 6-12: Ruling: commits have an English subject and short body with no trailers, including no Signed-off-by - why: Ivan's current explicit commit instruction overrides the plan's older DCO instruction - cost if wrong: the sign-off CI policy may require a later policy decision before any push; no push is authorized here.

- Plan 1 Task 6: Ruling: fixture-only client-id substitutions in test_route.py are accepted, with a fixture-only adjustment of its synthetic busy-Login run_id allowed for the fix - why: the old synthetic ids do not meet CLIENT, and assertions must keep reaching their original paths - cost if wrong: none, assertions and scenarios stay intact.

- Plan 1 Task 6: Ruling: the R1.3 ownership check applies to every nonempty run_id, including legacy Login, accounting for frps using runID as the legacy clientID - why: both reviewers reproduced cross-company takeover through the empty-client-id path - cost if wrong: a legacy reconnect is refused when the dashboard cannot tell.

- Plan 1 Task 6: Ruling: a visitor credential belongs to one binding lifetime, invalidated atomically on release/recreation; an issuance authorized against an old binding cannot restore it for the new owner - why: both reviewers reproduced the old visitor key logging into a rebound name - cost if wrong: visitors need a newly issued key after a name changes owner.

- Plan 1 Task 6: Ruling: AGY Important 3's cap=1.0 change is not accepted; Login dashboard reads keep min(0.5 s, time left) - why: the binding Task 2 ruling explicitly caps each plugin dashboard read, unlike the watcher's later exception - cost if wrong: a good dashboard answer arriving at 0.7 s refuses the login until frpc retries.

- Plan 1 Task 6: Ruling: review minors M1-M3 kept, not fixed: auth reports blocked before validating a key (closed refusal; name availability public); second-login log offset can miss an eviction under unusual load (false test failure); README logging summary omits visitor-key rotation (name only, no key) - why: Minor by user-visible effect - cost if wrong: a less specific auth error, a test retry, or an incomplete event list.

- Plan 1 Task 6: Ruling: a live legacy run-id takeover needs a same-binding routes record with client legacy and the exact run_id, plus frps's matching fallback identity; absent/offline sessions reconnect as before, ambiguous online ownership refuses - why: Antigravity reproduced takeover of a foreign legacy session that had no route row, and the lead independently confirmed the plugin accepts it - cost if wrong: an unrecorded legacy control session reconnecting during a blip waits for eviction and frpc retry; it holds no recorded company route.

- Plan 1 Task 6: Ruling: new review Minor M4 kept, not fixed: the delayed fake dashboard may print BrokenPipeError/ConnectionResetError after the test client times out - why: test-only stderr noise, no unsafe answer or failed assertion - cost if wrong: noisier test logs.

- Plan 1 Task 6: Ruling: an online legacy takeover also refuses a run_id matching CLIENT, even with a historical legacy route row - why: an explicit-ID peer or visitor can use its client id as run_id, so equality with the dashboard clientID is ambiguous - cost if wrong: a non-stock legacy client that chose a network-id-shaped run_id must wait for eviction before reconnecting; stock legacy run ids do not have that shape.

- Plan 1 Task 6: Ruling: HTTP DELETE rechecks the authorizing binding hash inside atomic release, refusing a stale lifetime with 404; admin release stays operator-authorized - why: lead's synchronized HTTP probe reproduced an old DELETE deleting the rebound owner's binding - cost if wrong: an obsolete DELETE sees 404 and the new owner's binding and visitor key survive.

- Plan 1 Task 6: Ruling: guarded HTTP release also requires the binding to remain unblocked inside its transaction before either delete; a changed authorization may answer 404, while initial blocked auth keeps 403 and admin release stays operator-authorized - why: lead's synchronized HTTP probe reproduced a DELETE in flight erasing a later operator ban - cost if wrong: the request refuses and the blocked binding and visitor key remain.

- Plan 1 Task 6: Ruling: Antigravity round3 Important1 is Critical by user-visible effect: an offline legacy identity can reserve another binding client ID and prevent its legitimate login; stop after the third review, with no fix writer or commit - why: this violates client-ID ownership and R1.4 despite satisfying the earlier online-only proof ruling - cost if wrong: the local build waits for a follow-up decision. Evidence: runs/p1t6-review3-agy.md and source relay.py307-346/663-681.

- Plan 1 Task 6: Ruling: residual I8 at test_peers.py637/660 remains Important and unfixed at the mandatory stop; Codex supplied two additional safely captured plaintext-observation counterexamples, so Antigravity I8 closure does not close them - why: both assertIsNone calls render the observed generated credential on failure, against accepted I8 - cost if wrong: a generated test key may appear in future failure diagnostics.

- Plan 1 Task 6: Ruling: new Minors M5 and M6 kept, not fixed: native Login helper socket cleanup waits for Stack teardown on constructor timeout; DELETE API docstring404 wording omits the in-flight authorization race (ordinary obsolete key is401) - why: bounded test-only resource lifetime and imprecise refusal documentation, no production permission granted - cost if wrong: a temporary test socket or confusing status documentation.

## Artifacts and remaining work

- Full merged final judgment: `runs/p1t6-review3-merged.md`.
- Final reviewer reports: `runs/p1t6-review3-codex.md`, `runs/p1t6-review3-agy.md`.
- Final writer reports: `runs/p1t6-kimi-fix2-resume2.md`, `runs/p1t6-kimi-fix2-resume3.md`, `runs/p1t6-kimi-fix2-final-assertions.md`.
- Lead logs: `runs/p1t6-lead-final-done312.log`, `-done314.log`, `-gates.log`, `-probes.log`.
- Snapshot prefixes: `runs/p1t6-review3-before`, `runs/p1t6-review3-network-before`; final comparisons unchanged.
- Full action record: `runs/codex-lead-journal.md`; binding rulings and status: `progress.md`.

Tasks 7-12 remain undone because Task 6 is not safe to accept or commit under the review cap. The Task 8 public GitHub Caddy-download exception remains an unanswered clarification, not permission. Task 13 and A1 were not started because they are outside scope. No deployment, SSH, real company, GitHub contact, push, merge, amend or history rewrite occurred. Private SSH/key files were not read and generated credentials were not printed.

