# Review: batch 6, slice sql (Plan 3 Task 3, sql-check.ts), Claude

Package: `network-build/runs/batch6-sql.diff`, commit 38e531ae on `batch-6` (`apps/server/package.json`,
`package-lock.json`, `apps/server/src/db/sql-check.ts`, `apps/server/test/sql-check.test.ts`). Read only; nothing changed,
nothing committed. Probe scripts and their output live in `network-build/tmp/review-sql-claude/`.

Read for this review: the brief `briefs/batch6-sql-review.md`; `CLAUDE.md`; `hornhoof/AGENTS.md`;
`hornhoof/templates/skills/dev-engineering-rules.md`; the skills `test-driven-development`, `systematic-debugging` and
`verification-before-completion`; plan 3's rulings 1 to 5, its Review Focus (point 5), Global Constraints and Task 3;
the spec's "The orchestrator's SQL" (lines 408 to 430) and its test list (line 1147); `parallel-map.md` section 3 (the
seam `3 T3 and 4 T3`); plan 4 line 54 (`REFUSED_FUNCTIONS` named in `agent-sql.ts`); `progress.md` lines 319 to 327 (the
writer's rulings, the carry note and the deferred Minor); the author check log `runs/remote-p3sql-check-20261105-014843-1513696.log`.

How I checked the walk: I ran `checkAgentSql` from the branch's own file with `node --experimental-transform-types` on
about 90 texts beyond the test file's: every statement kind I could think of that is not one of the four (LOCK, SHOW,
LISTEN, NOTIFY, COPY, DECLARE, EXECUTE, VACUUM, EXPLAIN with ANALYZE, CREATE TABLE AS, INTO inside a subquery and inside
an INSERT's select, MERGE with RETURNING), every place a call can stand (ROWS FROM, CASE, JSON_TABLE's DEFAULT,
JSON_OBJECT, a correlated subquery in a WHERE operator, a second statement of three), the field spellings on a whole-row
`(a.*)`, on an alias, on a derived table's column, and ordinary statements with FOR UPDATE, TABLE, VALUES, ORDER BY
USING, GROUPING SETS, OVERRIDING SYSTEM VALUE, DEFAULT, FETCH FIRST, MATERIALIZED, CYCLE, WITH ORDINALITY, IS JSON,
WITHIN GROUP, OPERATOR(), regproc literals. Nothing ruling 4 refuses got past, and no ordinary statement was refused,
with the one exception in Minor 1. The interface matches the plan: `SqlRefused.kind`, `ONLY_STATEMENTS` word for word,
the function message `This tool does not call <name>.`, `REFUSED_FUNCTIONS` equal to ruling 4's twelve names. The CJS
build imports under plain Node ESM (`import { parse } from 'libpg-query'` from `apps/server`), so the production start
is not only a vitest result. `libpg-query` is pinned at exactly 17.7.3 and the lockfile adds only it and
`@pgsql/types` 17.6.2. No em dash, nothing private, no secret in any of the four files or the commit message. The
tests are deterministic and each would fail with the code wrong on what it names; types, lint, CRAP 5.0 and dryer are
in the author check log.

## Critical

None.

## Important

### 1. Thirty-nine deep texts inside the tool's 20,000-character limit kill the parser for the life of the process

`apps/server/src/db/sql-check.ts:95-101` (`parsed`) and the ledger's deferred Minor (`progress.md:327`), which says
"the parser still answers correctly afterwards". It does not. libpg-query holds one WASM instance for the process
(`node_modules/libpg-query/wasm/index.cjs:120-127`, `initPromise` once, no way to make another). A text such as
`SELECT 1` followed by `+1` 9,600 or more times (19,208 characters, under the tool's `max(20_000)` at
`database.ts:105`) overflows the WASM stack; V8 throws `RangeError: Maximum call stack size exceeded` out of the C
code, so the parser's memory context is never freed, and the leak is far more than 150 KB. Reproduced with
`tmp/review-sql-claude/threshold.mjs`: with `SELECT 1` + `+1` x 9990 (19,988 characters), after 39 such calls
`checkAgentSql('SELECT 1')` throws `memory access out of bounds`, and so does every call after it, for ever; RSS was
221 MB. The bison path (`memory exhausted at or near "+"`, from unary `+` 19,990 times) does not leak: 150 of them and
the parser still answers (`bison.mjs`).

What a person gets: the company's orchestrator loses its `database` tool until someone restarts the app. Every text,
good or bad, comes back as `Hornhoof did not run this SQL: memory access out of bounds`, which reads like a typo in its
SQL, and no log line says the checker is dead. Nothing runs that should not (it fails closed, which is why this is not
Critical), but a looping agent, or an LLM in degenerate repetition (`+1+1+1...` is exactly the shape such output
takes), reaches 39 calls in minutes, and a prompt-injected one on purpose. The commit message's "the parser answered
correctly after them" and the ledger's Minor rest on a probe that did not go far enough within the limit.

What would make it right: parse in a place that can be thrown away. The clean shape is a `worker_threads` Worker that
holds the WASM instance; `parsed` posts the text and waits; any failure that is not the parser's own `SqlError`
(RangeError, `memory access out of bounds`, a worker exit) refuses the text with kind `syntax` as now, logs one
warning line, and replaces the worker, so the next call parses with a fresh instance. A test, red first: 60 calls of
`SELECT 1${'+1'.repeat(9990)}` each reject with kind `syntax`, then `SELECT 1; COMMIT` still rejects with kind
`statement` and `SELECT 1` resolves. If the writer would rather refuse before parsing, a bound on expression depth
cannot be read off the text without a parser, so a pre-check by length or by counting operators is not a fix; the
instance must be replaceable. Update the ledger's Minor to what is true.

## Minor

1. `sql-check.ts:51` (`refusedColumn`): `namesIn(fields).at(-1)` drops the star, so `SELECT set_config.* FROM agents
   set_config` is refused as a call of `set_config` (reproduced); look at the last field, not the last name, so that a
   star or an index at the end means "no call". Exotic alias, a false refusal only.
2. Commit message and `progress.md:327`: "about 150 KB each" and "answers correctly afterwards" are not true at this
   commit (see Important 1); rewrite the ledger line with the fix.
3. `progress.md:325` ruling and plan 4 line 54: plan 4 imports `REFUSED_FUNCTIONS` from `db/agent-sql.ts`; the carry
   note leaves it to that task's writer to import from `sql-check.js`. A one-line re-export from `agent-sql.ts` would
   keep plan 4's text true without a second copy; for the lead to carry, nothing to change here.
4. `sql-check.test.ts:173-179`: the 100,000-deep texts settle by whichever stack gives out first (WASM or Node's); the
   writer notes it. Fail closed either way, so no change asked; the Important 1 test replaces its "still answers" half.

Nothing else found: no gap against the Interfaces, no test that passes with the code wrong on what it names, no secret,
nothing private, no em dash, no process or port left behind, no Docker touched.
