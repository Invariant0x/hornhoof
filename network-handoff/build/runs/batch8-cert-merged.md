# Batch 8, certificate and screens slices: what the fix round does

Reports, read from the top: `network-build/runs/batch8-cert-agy.md` (Antigravity), `network-build/runs/batch8-cert-claude.md` (Claude), `network-build/runs/batch8-rest-claude.md` (Claude). Check each claim first; if one does not hold, say why and leave it. Each fix from a failing test.

## Important
1. `apps/server/src/modules/tls/manager.ts` (`tick`, `pass`, `order`, `checkCarried`): a `kick` during a running pass is dropped, and a pass writes `link_tls` from the link it read at its start, up to 80 s earlier. So a link set up during a pass waits 60 to 120 s, a removed link can get its certificate and key written back, and a rename during the probe blocks the new name for an hour. Record a pending kick, so one more pass runs at once when this one ends. Read the link again after `issue` and after the probe, before writing anything for a name that is no longer the link's.
2. `withoutLink` and `order` (when `row.name !== link.name`) reset the mode but keep `httpsBlockedUntil`: a new name stays on http for up to an hour with nothing wrong with it. `withAccount`, on a changed `ACME_DIRECTORY`, keeps the old CA's `nextTryAt`, `failure`, `failedAt`, so the new CA waits. Clear them.
3. `apps/server/src/main.ts:28` fires `void app.ctx.tls.serveOn(...)` with no catch: a passing Postgres error at start rejects unhandled and ends the app. It also races `start`'s pass over `this.given`, and an older handoff can drop an `https` link to `http`, blinking frpc. Catch and log through `loggable`, as `pass` does; let only the newest handoff count.
4. `ACME_DIRECTORY=off`: `view()` answers as if a certificate were on its way, so Settings says "moves on its own" and shows the Let's Encrypt agreement line, and Setup waits 90 s on "Getting the certificate". Say so in `TlsView`, and let Settings, Machines and LinkReady say the plain truth or nothing, with en and ru. Keep one test per screen at most. Likewise `failedAt` reaches the web and nothing reads it: `useCertificateStage` moves on when a try failed, instead of waiting 90 s. `SECURITY.md:55` says `docker compose up -d app`, but the keeper reads `ACME_DIRECTORY` too: say the command that restarts both.
5. One real test, in `npm run test:real`, of `new LinkTls(ctx)` with its default `AcmeAccount` against Pebble: a first certificate into `link_tls`, `mayRunHttps` true on Pebble's real chain, and a second order on the saved `account_url`. The readers differ; the lead rules for it, because a renewal that fails only against a real CA would show at day 60 as a link falling to http. `selfCheck: true` through the link stays for the rehearsal, if the harness cannot reach it: say which.
6. `apps/node/src/terminal/host.ts:1167-1169` (`interrupt`) and `:1178` (`end` with `reason === 'clear'`): a late hook falls on the next turn, as `stop` did. `stopTurn` waits `STOP_WAIT_MS`, answers `cancelled`, and the hook may come later: the next turn ends as stopped, and a person loses that turn. Kimi and Codex both register Interrupt. Gate them with the same lateness test as `stoppedHook`, and add a row to `stopIsLate`'s table. The reader reached this by reading: reproduce it first; if it proves unreachable, say why.

## Minor
7. `store.ts`'s `certificateIn` and `manager.ts`'s `certificateOf` decide the link's certificate in two places, and the first omits `notAfter !== null`. One rule.
8. `failureFields`: clamp a failure's `Retry-After`, as ARI's is clamped to a day, so that a CA's absurd answer cannot park renewal past the certificate's end.
9. `link-tls.test.ts:558-568`: "gives the listener the certificate before it switches" compares with the probe, not the mode's write. Compare with the write.
10. `link-tls.test.ts`: three asserts print a throwaway key on failure (Claude's Minor 5): compare with booleans, by the build's rule.
11. `client.ts`: check `LAST_LINES`'s own key too, or take the check through one table.
12. `apps/web/src/ui/LinkName.tsx`: a random name after a remount is described as a chosen one. Derive it from the shape.
13. `Machines.test.tsx`, "says nothing while the certificate has 15 days left": wait for the answer to be applied, not only for the request.

## Not yours
The real Kimi check stays open, in `QUESTIONS.md` item 16. The rest of the Minors go to the ledger.
