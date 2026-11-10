#!/bin/sh
# changed-lines.sh <repo> <base> <file>: the file's lines that differ from <base> in the working tree, comma separated.
# A file new since <base> counts whole.
repo=$1; base=$2; file=$3
if ! git -C "$repo" cat-file -e "$base:$file" 2>/dev/null; then
  seq -s, 1 "$(wc -l < "$repo/$file")"; exit 0
fi
git -C "$repo" diff -U0 "$base" -- "$file" | grep -E '^@@' | sed -E 's/.*\+([0-9]+)(,([0-9]+))? @@.*/\1 \3/' |
  awk '{n=($2==""?1:$2); for(i=0;i<n;i++) printf "%s%d", (c++?",":""), $1+i} END{print ""}'
