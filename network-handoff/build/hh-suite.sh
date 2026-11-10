#!/bin/bash
# Hornhoof's whole suite as `npm test` runs it, with the long timeout really reaching vitest: `npm test -- --testTimeout=...` from
# the root stops at the root script, and a slow test then fails on vitest's default 20 s. Run from a Hornhoof repository root.
set -eu
node scripts/check-release.mjs --local
npm run test:release
npm run typecheck:tests
npm test --workspaces --if-present -- --testTimeout=90000
