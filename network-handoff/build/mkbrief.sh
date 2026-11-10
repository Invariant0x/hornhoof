#!/bin/sh
# mkbrief.sh <plan.md> <task number> <python|typescript> <notes.md> <out.md> [writer|review]
# Writer brief: build rulings + task notes + plan top (Global Constraints, then quality rules, then the rest to the
# end of Review Focus) + the one task. Review brief: review howto first, same content after.
set -eu
L=/home/altera/hornhoof-network/network-build
plan=$1; n=$2; lang=$3; notes=$4; out=$5; kind=${6:-writer}
gc=$(grep -n '^## Global Constraints' "$plan" | head -1 | cut -d: -f1)
gc_end=$(awk -v s="$gc" 'NR>s && /^## / {print NR-1; exit}' "$plan")
t1=$(grep -n '^### Task 1:' "$plan" | head -1 | cut -d: -f1)
ts=$(grep -n "^### Task $n:" "$plan" | head -1 | cut -d: -f1)
te=$(awk -v s="$ts" 'NR>s && /^### Task / {print NR-1; exit}' "$plan")
[ -n "$te" ] || te=$(wc -l < "$plan")
{
  if [ "$kind" = review ]; then cat "$L/briefs/review-howto.md"; echo; else
    echo "You are the writer for Task $n of $(basename "$plan" .md) in Hornhoof's network build. Read everything below before you start."; echo; fi
  if [ "$kind" = review ]; then sed '/^# How you work (writer)/,$d' "$L/briefs/build-rulings.md"; else cat "$L/briefs/build-rulings.md"; fi; echo
  cat "$notes"; echo
  echo "# The plan, from its top to the end of Review Focus (quality rules inserted after its Global Constraints)"; echo
  sed -n "1,${gc_end}p" "$plan"; echo
  cat "$L/briefs/quality-$lang.md"; echo
  sed -n "$((gc_end+1)),$((t1-1))p" "$plan"; echo
  echo "# The task"; echo
  sed -n "${ts},${te}p" "$plan"
} | sed "s/invariant0x@icloud\.com/<owner's address, the lead's alone>/g; s#/Users/0x/Projects/hornhoof-edge#/home/altera/hornhoof-network/hornhoof-edge#g; s#/Users/0x/Projects/Hornhoof-archive#/home/altera/hornhoof-network/hornhoof#g" > "$out"
echo "$out: $(wc -c < "$out") bytes; gc 1-$gc_end, top to $((t1-1)), task $ts-$te"
