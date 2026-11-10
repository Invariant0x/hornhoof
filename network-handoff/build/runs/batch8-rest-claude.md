# Batch 8, slice rest: review (Claude)

Read: the package, the tree on batch-8, the ledger lines. No file changed, no test run (a focused run was not needed to settle any doubt).
Em dashes: none in the added lines. "ё": none. "компьютер"/"узел": none in ru.ts. Russian strings read right ("е", "машина", no English words except the names Hornhoof, Let's Encrypt, hornhoof.org).

Count: Critical 0, Important 2, Minor 4.

## Critical

None.

## Important

1. Important, `apps/server/src/modules/tls/manager.ts:185-192` with `apps/web/src/ui/LinkReady.tsx:17-30` and `apps/web/src/screens/Settings.tsx` (`Encryption`, 433d7504): the UI says things that are false for a company that turned certificates off, which SECURITY.md and the README tell people to do.
   - `view()` answers a non-null `TlsView` whenever there is a link, also when `ACME_DIRECTORY=off` (`row` is null, `certificate:false`, `mode:'http'`).
   - Settings then shows "Encrypted to hornhoof.org for now. Hornhoof moves the encryption to this machine on its own." and the Let's Encrypt agreement line ("Getting it accepts the ... Agreement for your company"). With certificates off, nothing will ever move and nothing is accepted.
   - Setup: a new company with `ACME_DIRECTORY=off` in `.env` waits the full 90 s on "Getting the certificate for your link. This takes under a minute." (nothing polls to a result), then reads "Its own certificate comes on its own". Also false.
   - Checked by reading: `config.acmeDirectory === null` makes `manager.start()` return at once (manager.ts:149), so no certificate is ever ordered, while `view()` still returns the object.
   - Right: let `view()` say that certificates are off (return `null` for that case, or add a field such as `off: true`), and have Settings, Machines and LinkReady say the plain truth or nothing: no agreement line, no wait, no "moves on its own". One test per screen at most.

2. Important, `apps/node/src/terminal/host.ts:1167-1169` (`case 'interrupt'`, and the same shape in `case 'end'` with `reason === 'clear'`, :1178): the late-hook gap the fix closes for `stop` is still open for the interrupt hook. This is the ledger's open item (2); it stands, and it is reachable, not only theoretical.
   - Path, from named lines: `stopTurn` (:607-612) sends Escape, waits `STOP_WAIT_MS`, then sets `busy=false` and answers `cancelled`. On a loaded machine the program's Interrupt hook can come after that wait. If Hornhoof's next turn has already taken its prompt (`stoppable` true), `interrupted(a)` calls `endTurn` with no id, and `TurnEnds.end` accepts it on the new turn's record (no id to tell it apart, `stoppable` true, no status yet). The next turn ends as stopped/cancelled; a person's agent turn is lost.
   - Kimi and Codex both register Interrupt (programs.ts:89, :162); neither gives a turn id.
   - Not reproduced. Right: gate `interrupt` (and the `clear` branch of `end`) with the same lateness test as `stoppedHook` (prompt not yet in, or session left), and add one pure case to `stopIsLate`'s table. The window is narrow, so if the lead defers it, it should go to QUESTIONS.md or the ledger as a known gap rather than stay only a line in progress.md.

## Minor

3. Minor, `apps/web/src/ui/LinkName.tsx:~136` (`useRandomName`): `random` is local state, so when the field remounts with a random name already in it (Setup: Next then Back; Settings: reopen the editor), the safety line says "A name you pick shows in public certificate logs..." about a random name. Conservative, but wrong text. Fix: derive "random" from the name's shape (`/^[a-z0-9]{24}$/`) or lift `random` to the parent.
4. Minor, `apps/web/src/screens/Machines.tsx` (`useLinkTls`): one `GET /api/link` when the tab opens, so a renewed certificate keeps the warning until the person leaves and returns. The writer ruled it; the cost is a stale alert. Fine to leave.
5. Minor, `apps/web/test/Machines.test.tsx` "says nothing while the certificate has 15 days left": it waits for the request to be made, then one `setTimeout(0)`, not for the answer to be applied. It would also pass if the answer were handled a tick later with the warning wrongly shown. Waiting on the table plus a second `findBy` of something that appears after the answer (or flushing with `vi.waitFor` on the call count after the mock resolved) would pin it. No harm to a person, so not Important.
6. Minor, ledger open item (1), real Kimi: stands. The second ruling (a same-session stop after the next prompt still counts) rests on the fakes, which wait for the stop's answer. If real Kimi takes a prompt while its last Stop is unanswered, the new turn ends early as `done` after `SETTLE_MS` with a partial answer. 2504f426 says this honestly. Needs one look at real Kimi when a machine with it is at hand; until then it is a named, recorded risk.

## What I checked and found right

- Plan 1b Task 9 texts: all nine strings in en and ru match the brief word for word; `letsEncrypt` is `{before, agreement, after}` with `href` `https://letsencrypt.org/repository/`, `target="_blank"`, `rel="noreferrer"`. `guessable` and `hardToGuess` changed as written.
- SECURITY.md lines 36, 37, 53 and the two new lines match the brief. The facts hold at this commit: sign-in limits 10/15 min and 50/h (`auth/sign-in-limit.ts`), `__Host-hh_session` (`auth/session.ts:14`), `x-robots-tag: noindex, nofollow` and `robots.txt` (`web.ts:30`, `app.ts:107`), `ACME_DIRECTORY` passed by `compose.yaml:22` and `off` accepted by `config.ts`, fallback to http when certificates are off or the certificate has under a day left (`store.ts`), and the app's `sync()` on lead start rewrites the tunnel to http, so the README's "opens again within a minute" is plausible. "Tries again every hour": failed orders wait at least `HOUR_MS` (`manager.ts:18,81`). A healthy certificate renews at two thirds of its life or by ARI, long before 14 days left, so the Machines warning does mean a renewal failed.
- `grep "ends at hornhoof.org" SECURITY.md` prints nothing. No stale "hard to guess" or "opens each request" text is left in the repo docs.
- Setup/Settings/Machines/LinkName splits (433d7504): I read the diff against the old bodies. The flows are the same: the editor starts from the link's name for a change, from empty with `startRandom` for no link, a removal remounts the editor so a new random name starts, refusals go back to step 0 with the same problems, the command and link cards come in the same order. The ruling that Settings shows no certificate line after a change is sound (the old certificate was for the old name).
- `host.ts` fix: `stopIsLate` is pure and its table covers the cases; both integration tests fail on the old code (the first by following the old session, the second by `agent.sessionId === first.sessionId`), use no sleeps, and the spy lives on a tmux made per `setUp`, so it does not leak. A real stop is not lost in the paths I traced: the prompt hook sets `took` before it awaits (:1203-1207), `busy` is not cleared between a prompt and its stop, and `from === session` after a resume keeps the same-session stop counting. `lateStop` still diagnoses a channel disagreement once. The 2504f426 split of `endTurn` keeps `typedEndError`'s order (stopped, then no failure, then auth/not-logged-in, then failed) the same as the old one-liner.
- The join: `configFor`'s `Object.hasOwn(local, settings.mode)` check, `writeTunnelSettings(db, config, log?)` with `settingsWith`, and `passes`, `readLinkMode`, `linkMode` in `tls/store.ts` are all present and consistent; `link.ts:132` passes the log. Nothing from batch 6's fixes was lost that I can see.
- Web wait limit: `configure({ asyncUtilTimeout: 10000 })` in `test/setup.ts` is picked up by `screen` queries; the new test needs it (an element at 1.1 s). No test in the slice expects a wait to fail.
- Not run by me (author checks cover them): crapper and dryer on the split screens. The new components are small; I saw no duplicate pair.
