# Review: batch 2, slice signin (Plan 1b Task 2), reader Claude fable

Package: `network-build/runs/batch2-signin.diff`, commit fb8ff224 on branch batch-2 of `hornhoof`. Read only; no test rerun
was needed, every point below is reasoned from named lines.

## Counts

- Critical: 0
- Important: 0
- Minor: 4

## What was checked

- Interfaces against the code: `Deps.onRoute` (app.ts:39-45) is wired with `app.addHook('onRoute', ...)` right after
  `Fastify()` and before any plugin or route (app.ts:78), so plugin routes (`@fastify/static`'s `/*`) are seen too; the
  sweep saw them (`GET /*` is in PUBLIC and `/x` gets index.html through `webAppRoutes`, web.ts:51-56). `/api/health`
  answers `{ ok: true }` when `req.overLink`, else with `version` and `commit` (app.ts:67). `/api/version` calls
  `requirePerson` only over the link (app.ts:68-71), so localhost keeps today's answer and the one-machine constraint
  holds. `/robots.txt` body and type match the plan (app.ts:72). `x-robots-tag` sits in `SECURITY_HEADERS` (web.ts:121).
- The person's question, routes the sweep cannot reach: WebSocket upgrades on `/api/nodes/socket`,
  `/api/agents/:id/terminal`, `/api/subscriptions/:id/signin/terminal` all gate in `preValidation` (node key, session) before
  the socket opens, so a stranger gets 401 and no frame. `POST /api/auth/login` answers one fixed message for an unknown
  email and a wrong password and rate-limits per email whether or not the person exists (auth/routes.ts:22-41), so it is
  not an oracle for a guessed address. `GET /api/invites/:token` names the company and the person only for the holder of
  the invite token, which is the invite's purpose. `GET /api/setup` gives `needed` and the relay's domain, not the company
  (setup/routes.ts:64). `GET /install.sh` substitutes the public URL, which a link visitor already has (nodes/routes.ts:257-263).
  Error bodies carry a fixed message, code and reason; Zod errors echo the field path, not values (errors.ts). The web
  index is static with the title "Hornhoof". No route outside the sweep's reach names the company before sign-in.
- The sweep as a guard: a dead `onRoute` fails on the 30-route floor; a public route that is new fails until listed; names
  are checked in the body and every header value; `:id` is tried with a real row of every table. The PUBLIC list is what
  the plan describes, plus `GET/HEAD /install.sh` and `POST /api/auth/logout`, both answering without a session today and
  both harmless (the script and a 204 that clears a cookie); the ruling is in the commit message.
- Gates (writer's log p1bt2-gates3): every changed function CRAP 1 to 6, dryer no pair; functions small, names plain,
  comments say why, no em dash in the diff. Seams in parallel-map section 3 (`1b T2 and 2 T3`, `1b T2 and T6`) are
  compatible: `:token` is in the parameter map and health's local answer can gain `mode`.

## Minor

1. `apps/server/src/web.ts:121` with `modules/events/stream.ts:21-22`: `x-robots-tag` (and the other security headers) are
   set with `reply.headers` in an onRequest hook, so a hijacked answer (`/api/stream`, `/mcp`, the sockets) that writes its
   own raw head does not carry it; the plan's "every answer" is not literal. Those answers need a session, so no stranger
   or crawler sees them. Nothing to change unless the lead wants the words exact.
2. `apps/server/test/before-sign-in.test.ts:250`: the name check is case-sensitive, so `acme`, `ACME` or `Ivan@Acme.com`
   in an answer would pass. The sweep itself sends `acme` as `:name`, so a case-insensitive check would need another value
   there. Low value today since no route echoes the company lowercased; noted for the lead's judgment.
3. `apps/server/test/before-sign-in.test.ts:196-199`: `:teamId` is filled with the ids like `:id`, where the plan says any
   parameter outside the map fails the test until added. Sensible, since team ids are ids, but it is a decision the plan did
   not take and it has no `Ruling:` line in the ledger or the commit; the writer's report mentions it.
4. `apps/server/src/auth/tunnel.ts:14-16`: a failed lookup of the tunnel container's name makes `overLink` false, so a link
   visitor would then get the local `/api/health` with `version` and `commit`, and `/api/version` without a session. That
   names the build, not the company, and ledger line 133 already defers this to Task 5. No action for this task.

## Verdict

The task's promise holds at this commit: nothing a stranger can reach over the link, with or without the sweep's list,
names the company, its people or its departments. Approve; the Minors are notes, none needs a fix round.
