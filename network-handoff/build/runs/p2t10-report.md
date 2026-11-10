# Plan 2 Task 10 report (lane /home/altera/hornhoof-network/wt/p2t10)

Status: DONE_WITH_CONCERNS (concern: crapper lists three pre-existing functions over 10, see Gates).

## Read first
CLAUDE.md, hornhoof/AGENTS.md, hornhoof/templates/skills/dev-engineering-rules.md, skills test-driven-development,
systematic-debugging, verification-before-completion (all in plugins/superpowers/skills/<name>/SKILL.md), the brief.

## Files changed
apps/web/src/updates.ts, ui/UpdateProgress.tsx, ui/UpdateBanner.tsx, screens/Versions.tsx, i18n/en.ts, i18n/ru.ts,
guide/install.md, guide/public-link.md, SECURITY.md, apps/web/test/Updates.test.tsx, apps/web/test/i18n.test.tsx.

## Tests, red first
- `shows maintenance while the server answers with it` (Updates.test.tsx): failed by timeout, the bar never showed the
  maintenance text. The idle fixture gained `maintenance: false`.
- `words the reasons of maintenance, read-only and starting in both languages` (i18n.test.tsx): failed with
  received 'x' (the server's own words) instead of the dictionary text.
- After the code: both files pass, 30 of 30 (light.sh, vitest --maxWorkers 2).

## Other checks
- `npx tsc -p apps/web/tsconfig.json --noEmit`: prints nothing (exit 0).
- `npm run lint`: no errors printed.
- Gates via remote.sh (labels p2t10-gates, p2t10-gates2), base lanebase, web: dryer reports no duplicate candidates.
  crapper: UpdateProgress 8.4, stepLabel 5.0, barLabel 3.0, outageOf 4.1 (all new or changed code under 10).
  Still over 10 and not made by this task: Versions 33.1, useUpdates 19.3 (was 20.3 after my first version, 19.3 now),
  UpdateBanner 16.0. I added no branches to Versions or UpdateBanner (only a prop). Not split, outside this task.
- Not run: mutator, the whole suite (lead's).

## Design notes and deviations
- `Updates` keeps `offline` and `maintenance` as booleans, derived from one `outage` state ('none', 'maintenance',
  'offline') so they are never both true. A poll failing with reason `maintenance` sets maintenance and not offline,
  as the plan says; a successful poll clears it.
- UpdateProgress label logic moved into `barLabel` and `stepLabel` to keep CRAP under 10 (no behavior change).
- Plan's test mock answers 503 with `{ error: { code, message, reason } }`, the shape api.ts reads. The older test at
  line 117 uses a flat 502 body; I left it alone.
- Plan said guide/install.md line 43 and public-link.md line 23: the lines were at 42 and 23 in this lane; text matched
  by content. The install.md line read "first free port from 8080 ... `HORNHOOF_PORT`", replaced with the plan's text.
- `errors.maintenance`, `read_only`, `starting` were put at the top of `errors` (the errorText lookup reads reasons there).
- No em dashes, no "ё" in the new strings. Nothing staged or committed.
