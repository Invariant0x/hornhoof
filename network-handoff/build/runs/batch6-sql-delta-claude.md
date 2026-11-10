# Delta read: batch 6, slice sql, the fix round (Claude)

Package: `network-build/runs/batch6-sql-delta.diff`, commit f11376d6 on `batch-6` (`apps/server/src/db/sql-check.ts`,
new `apps/server/src/db/sql-parser.ts`, `apps/server/test/sql-check.test.ts`, new `apps/server/test/sql-parser.test.ts`).
Read only; nothing changed, nothing committed. Also read: `runs/batch6-sql-merged.md`, the ledger's `Batch 6's fix,
sql-check` lines (`progress.md:405-406`), the author check log `runs/remote-b6fixq-check-20261105-103629-2442023.log`
(135 tests, types and lint silent, worst changed CRAP 4.0, dryer none). Probe script and output:
`network-build/tmp/review-sql-claude/fixed.mjs`, run with tsx from `apps/server`; the process ended by itself, exit 0.

## The findings of round one

**Important 1 (the flood kills the parser): ADDRESSED.** `sql-parser.ts` holds the parser in a `worker_threads` Worker
(`ThrowawayParser`); `heard` and `throwAway` replace it on `{ broken }`, on `error`, on `exit` and at the 10 s deadline,
with one `console.warn` line that carries only a reason word (`RangeError`, `out of time`, `it stopped`, `it could not
start`), never the text. `sql-check.ts:106-111` turns `broken` into `SqlRefused('syntax', PARSER_GAVE_OUT)`. The test
`keeps answering after a flood of texts too deep for the parser` (`sql-check.test.ts`) sends 60 texts of `SELECT 1` +
`+1` x 9990, then expects `SELECT 1; COMMIT` refused as `statement`, `SELECT 1` resolved and exactly 60 warnings. It
fails without the fix: with the old `parsed` the 40th or so `SELECT 1` throws `memory access out of bounds` (my round
one reproduction, 39 calls), and `console.warn` is never called. My probe on the fixed branch: `+1` x 3000 passes,
x 5000 and x 9990 are refused with the fixed message and one warning each, and `SELECT 1` passes afterwards.

**Merged Minor 2 (a star after an alias named like a function): ADDRESSED.** `refusedColumn` now reads the last field
itself (`namesIn(fields.slice(-1)).at(0)`), so an `A_Star` there means no call. The three `leaves alone a star after an
alias named like a refused function` cases fail without the fix: the old `namesIn(fields).at(-1)` yields the alias
(`lo_rows`, `set_config`) and refuses it. Probe: `SELECT set_config.* FROM agents set_config` passes, `SELECT
a.set_config FROM agents a` is still refused as a call.

**Merged Minor 3 (first fault in text order): ADDRESSED.** `entriesOf` now seeds the stack with the top entries
reversed and pushes each node's children reversed after yielding it, which is a pre-order walk in key order, and the
parser's `stmts` and lists are in text order. The three `names the first fault in the order of the text` cases fail
without the fix: the old walk popped the last pushed sibling first, so `COMMIT; SELECT pg_cancel_backend(1)` named the
function and `SELECT pg_reload_conf(), pg_cancel_backend(1)` named `pg_cancel_backend`. Probe: both answer as the test
says. Within one statement the order is the parser's fields (the writer's ruling); refused either way.

The deep tests now hold on the worker's own 2 MB stack (`resourceLimits.stackSizeMb`), not Node's default, and the
built-output check runs the probe with a 3,900 KB main stack to show that the worker's limit is what decides.

## New breakage looked for

- **A text that gets through because the worker failed or timed out.** None. `parsed` returns a tree only on `{ tree }`;
  every other answer, and the `.catch` in `parse` for a worker that could not start, becomes `SqlRefused('syntax')`.
  A late answer from a replaced worker is dropped by `worker !== this.worker` in `heard` (tested in `hears nothing
  more from a worker it threw away`, with a late `tree` for `COMMIT`). One worker, one text at a time (`lastTurn`), so
  an answer can only belong to the text waiting. Fail closed holds.
- **A caller left waiting for good.** None. Every exit from `ask` settles: a message, `error`, `exit`, the deadline, or a
  synchronous throw in `start`/`postMessage` caught by `parse`'s `.catch`. The deadline timer is the only thing that can
  be lost, and it is cleared in `settle`. The spin-in-WASM test shows a worker that never yields is still freed at the
  deadline and ends on `terminate()`. A caller's worst wait is 10 s per text ahead of it plus 10 s, as the ruling says;
  with nothing stuck a text costs well under a millisecond.
- **SQL text reaching a log line.** None. `logged(why)` prints a reason word only; the worker sends `String(err &&
  err.name)` for a failure, not the message. The parser's own `SqlError` message (`syntax error at or near "x"`) goes to
  the orchestrator as the plan says, not to a log. Tested by `logs that it replaced a parser, without the text`.
- **The worker eval string.** A constant, no interpolation; it requires `libpg-query` by the absolute path the main
  module resolved with `createRequire(import.meta.url)`, so vitest, tsx and dist all find the same file. `env: {}`,
  `execArgv: []`, a 2 MB stack. Only `parentPort` messages cross. Nothing from a text is evaluated.
- **A process that cannot exit.** None. The worker is `unref()`ed; the deadline timer holds the process only while a
  caller waits and is cleared on settle. The built-output check's probe and my own probe both ended by themselves.
- **The contract with the later tool caller.** Unchanged: `checkAgentSql(text): Promise<void>`, `SqlRefused` with the
  three kinds, `ONLY_STATEMENTS`, `REFUSED_FUNCTIONS`. Two message changes, both within the plan's words: an empty text
  reads `The text is empty.` (the tool's `z.string().trim().min(1)` never sends one), and a parser failure that is not a
  parse error reads the fixed `PARSER_GAVE_OUT`. The carry note stands: the tool must check the very string it hands to
  `run`. A first call, and the first after a replacement, costs about 50 ms for the worker's start; a stuck parser
  adds at most 10 s to one `database` call, which that call reports as a refusal, not as a hang.

## Not blocking, for the record

- The flood test took 21.7 s on home-api (60 replacements, timeout 60 s), the built-output test 5.2 s and a `tsc` run;
  both are the slow end of the server suite. `dist/` is in `.gitignore`, and the test removes its own folder.
- `void worker.terminate()` would surface as an unhandled rejection if `terminate` ever rejected; Node's `Worker.terminate`
  resolves, also on a worker already gone.
- The worker's 2 MB stack takes a chain of about 3,900 operators where the main thread took about 9,600; IN lists of
  4,000 items, AND chains of 2,000 and UNION chains of 1,300 at the tool's limit still pass (probed). Nothing written by
  hand reaches it; a looping text hears "write it shorter".
- Not shown on the Alpine image, as the writer says; a real-image run at the plan's end should see the worker start.

Nothing blocking. The round one Important and the two merged Minors are addressed, each with a test that fails without
its fix.
