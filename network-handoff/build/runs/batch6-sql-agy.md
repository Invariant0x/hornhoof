I have read [brief.md](file:///tmp/claude-1000/-home-altera-hornhoof-network/agy-work/batch6-sql/brief.md) in full. Next, I will list the workspace contents and read the skills in `../skills/` before examining the spec, ledger, and diff.
### Context and Verification Scope

Read [brief.md](file:///tmp/claude-1000/-home-altera-hornhoof-network/agy-work/batch6-sql/brief.md), [systematic-debugging.md](file:///tmp/claude-1000/-home-altera-hornhoof-network/agy-work/batch6-sql/skills/systematic-debugging.md), [test-driven-development.md](file:///tmp/claude-1000/-home-altera-hornhoof-network/agy-work/batch6-sql/skills/test-driven-development.md), [verification-before-completion.md](file:///tmp/claude-1000/-home-altera-hornhoof-network/agy-work/batch6-sql/skills/verification-before-completion.md), [spec.md](file:///tmp/claude-1000/-home-altera-hornhoof-network/agy-work/batch6-sql/spec.md), [ledger.md](file:///tmp/claude-1000/-home-altera-hornhoof-network/agy-work/batch6-sql/ledger.md), and [package.diff](file:///tmp/claude-1000/-home-altera-hornhoof-network/agy-work/batch6-sql/package.diff). Note: the `repo/` folder in this workspace is empty (`0` files), so `AGENTS.md`, `templates/skills/dev-engineering-rules.md`, `package-lock.json`, and local `libpg-query` execution were not available here; all checks below are reasoned directly from `package.diff`, PostgreSQL 17's `gram.y` / `parsenodes.h` / `parse_func.c`, `@pgsql/types`, and Emscripten UTF-8 conversion semantics.

Checked all six `Plan 3 Task 3: Ruling` entries in [ledger.md](file:///tmp/claude-1000/-home-altera-hornhoof-network/agy-work/batch6-sql/ledger.md#L320-L325), Uncle Bob gates (every function <= 11 lines, max CC 5 / CRAP <= 5, no duplication, plain English why-comments, zero em dashes or non-ASCII bytes), statement/intoClause coverage across all PostgreSQL 17 raw parse nodes, function/field call resolution (`FuncCall` including 3-part `db.net.*`, `ColumnRef`, `A_Indirection`), and NUL/lone-surrogate truncation (`READ_DIFFERENTLY`).

### Critical

None.

### Important

None.

### Minor

- `apps/server/src/db/sql-check.ts:53` - `refusedColumn` inspects `namesIn(fields).at(-1)`, which strips `A_Star`, so `SELECT lo_rows.* FROM (SELECT 1) lo_rows` falsely fails with `This tool does not call lo_rows.`; check whether `fields.at(-1)` itself is a `String` node instead.
- `apps/server/src/db/sql-check.ts:76-85` - `entriesOf` pushes entries forward onto a LIFO stack and walks sibling statements right-to-left, so `COMMIT; SELECT pg_cancel_backend(1)` reports `function` instead of `statement` (dropping `READ_ONLY` in read mode); push entries in reverse so the first violation in SQL order wins.
- `apps/server/src/db/sql-check.ts:7` - `REFUSED_FUNCTIONS` lives here by Ruling 6 while Task 3's interface and Plan 4 name `db/agent-sql.ts`, so an import from `agent-sql.ts` fails unless Task 3's later writer adds `export { REFUSED_FUNCTIONS } from './sql-check.js'` in `apps/server/src/db/agent-sql.ts`.
- `apps/server/package.json:25` - `package-lock.json` is omitted from `package.diff` and `repo/` is empty here, so confirm on `batch-6` that `38e531ae` updates `package-lock.json` with only `libpg-query@17.7.3` and `@pgsql/types`, else `npm ci` fails.
