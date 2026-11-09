#!/usr/bin/env bash
# Prints the build of the node image: the last commit that changed a file the image is made of. The image carries it
# and nothing else of a commit, so an unchanged node image keeps its digest, and the server built from the same commit
# knows which build its nodes should be. CI runs it for both images.
set -euo pipefail

# What apps/node/Dockerfile copies from the repository, and what Docker leaves out of it.
INPUTS=(apps/node packages/protocol package.json package-lock.json tsconfig.base.json apps/server/package.json apps/web/package.json scripts/release/workspace-versions.mjs .dockerignore)

cd "$(dirname "$0")/.."
# In a shallow clone the one commit there seems to change every file, so the build would be that commit every time.
if [ "$(git rev-parse --is-shallow-repository)" != false ]; then
  echo "node-build.sh needs the whole history of the repository: check it out with fetch-depth: 0." >&2
  exit 1
fi
# What Docker leaves out of them, such as the tests: each line of .dockerignore, read as Docker reads it, and all under
# it. An exception would bring back a file that this leaves out, so the script refuses one rather than miss a change.
OUTSIDE=()
while read -r pattern || [ -n "$pattern" ]; do
  case "$pattern" in
    '') continue ;;
    '!'*) echo "node-build.sh cannot follow the exception $pattern in .dockerignore." >&2; exit 1 ;;
  esac
  pattern=${pattern#/}
  pattern=${pattern%/}
  OUTSIDE+=(":(exclude,glob)$pattern" ":(exclude,glob)$pattern/**")
done < .dockerignore
build=$(git log -1 --format=%H -- "${INPUTS[@]}" "${OUTSIDE[@]}")
if [ -z "$build" ]; then
  echo "node-build.sh found no commit that changed the files of the node image." >&2
  exit 1
fi
echo "$build"
