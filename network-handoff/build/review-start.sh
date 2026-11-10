#!/bin/bash
# review-start.sh <lane> <plan-file> <task> <python|typescript> <round>: builds a lane's review package and the reviewers' brief.
set -eu
ROOT=/home/altera/hornhoof-network; B=$ROOT/network-build
lane=$1; plan=$2; task=$3; lang=$4; round=$5
"$B/lane.sh" package "$lane" "$B/runs/$lane-r$round.diff" > /dev/null
cat > "$B/briefs/$lane-r$round-notes.md" <<NOTES
# Notes for this review from the build lead

- This is review round $round of plan task $task, written in the lane \`$ROOT/wt/$lane\`. The change under review is the package
  \`$B/runs/$lane-r$round.diff\`: the lane's own work against its start, the tag \`lanebase\`. What it stacks on is reviewed separately.
- The writer's report, claims to verify and not to trust: \`$B/runs/$lane-report.md\`. It says what ran and how each test failed first.
- Where this task meets others: \`$B/parallel-map.md\` sections 1, 3 and 4 for this task, and section 5's rulings, all taken. Build ruling 5: migration numbers are the plan's plus 11.
- The lead runs the full suite and the three gates itself, on the test machine. You run at most focused tests, in the lane, through
  \`$B/light.sh <command>\`.
NOTES
if [ "$round" -gt 1 ]; then
  {
    echo
    echo "# This is a scoped re-review, round $round"
    echo
    echo "Say for each finding below ADDRESSED or NOT ADDRESSED, with how you checked it, and whether its test really fails without the fix. Report new Critical or Important breakage only in what the fix changed. Do not reopen what was accepted or deferred, and do not review the rest of the task again."
    echo
    cat "$B/runs/$lane-r$((round - 1))-merged.md"
  } >> "$B/briefs/$lane-r$round-notes.md"
fi
"$B/mkbrief.sh" "$plan" "$task" "$lang" "$B/briefs/$lane-r$round-notes.md" "$B/briefs/$lane-r$round-review.md" review | cut -c1-120
