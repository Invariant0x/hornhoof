#!/bin/bash
# review-package.sh <repo> <base> <out>: everything that differs from <base> in the working tree, new files included, with
# context, as one file a reviewer reads once. It carries no author lines.
set -eu
repo=$1; base=$2; out=$3
cd "$repo"
{
  echo "# Review package: working tree against $base"; echo; echo "## Commits since base"; git log --format='%h %s' "$base"..HEAD; echo
  echo "## Files changed"; git diff --stat "$base"; git ls-files --others --exclude-standard | sed 's/^/new: /'; echo; echo "## Diff"
  git diff -U10 "$base"
  git ls-files --others --exclude-standard | while read -r f; do git diff --no-index -- /dev/null "$f" || true; done
} > "$out"
wc -c "$out"
