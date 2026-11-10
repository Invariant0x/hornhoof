#!/bin/bash
# Direct test of hh-related.sh's choice of runs: a list of changed files in, the runs it would make out, nothing executed.
L=/home/altera/hornhoof-network/network-build
fails=0
expect() { # expect <name> <changed files, one per line> <wanted runs, one per line>
  local got; got=$(printf '%s\n' "$2" | "$L/hh-related.sh" --plan)
  if [ "$got" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; echo "  wanted: $3"; echo "  got:    $got"; fails=$((fails+1)); fi
}
expect 'one app runs what its files reach' 'apps/node/src/outbox.ts
apps/node/test/outbox.test.ts' 'apps/node related src/outbox.ts test/outbox.test.ts'
expect 'two apps run each their own' 'apps/server/src/app.ts
apps/web/src/App.tsx' 'apps/server related src/app.ts
apps/web related src/App.tsx'
expect 'a protocol change runs everything that imports it, whole' 'packages/protocol/src/index.ts
apps/node/src/main.ts' 'apps/server whole
apps/node whole
apps/web whole
packages/protocol whole'
expect 'a template change runs the server whole' 'templates/skills/dev-engineering-rules.md' 'apps/server whole'
expect 'a template and a node change run both' 'templates/a.md
apps/node/src/main.ts' 'apps/server whole
apps/node related src/main.ts'
expect 'a doc alone runs no tests' 'README.md' ''
exit $fails
