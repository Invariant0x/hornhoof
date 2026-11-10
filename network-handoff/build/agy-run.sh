#!/bin/bash
# agy-run.sh review|write <repo> <label> <brief.md> [<package.diff>]
# Runs Antigravity on a clean copy of a repository, outside ~/hornhoof-network. It is an outside service, and CLAUDE.md keeps
# Ivan's address from such requests: the copy has no .git (author lines), no parent CLAUDE.md, and every file scrubbed.
#   review: read only (--mode plan); the report goes to runs/<label>-agy.md.
#   write:  edits allowed in the copy (--mode accept-edits); the copy's diff against the repository goes to runs/<label>-agy.diff
#           for the lead to judge and apply. It never touches the repository itself.
set -u
ROOT=/home/altera/hornhoof-network
SCRATCH=/tmp/claude-1000/-home-altera-hornhoof-network/agy-work
# Ivan's word, through David AI: Antigravity runs only on Argon with high effort, writers and reviewers alike.
MODEL=gemini-4-argon-high
mode=${1:?review or write}; repo=${2:?repo folder}; label=${3:?label}; brief=${4:?brief}; package=${5:-}
scrub() { sed -E 's/invariant0x@icloud\.com/<owner-address>/g'; }
# A reader on an empty copy still answers from the diff alone and looks finished, so a wrong path must stop here.
[ -d "$repo" ] || repo=$ROOT/$repo
repo=$(cd "$repo" 2>/dev/null && pwd) || { echo "no repository at $2" >&2; exit 2; }
[ -n "$(git -C "$repo" ls-files | head -1)" ] || { echo "no tracked files in $repo" >&2; exit 2; }
work=$SCRATCH/$label
rm -rf "$work"; mkdir -p "$work/repo"
git -C "$repo" ls-files -co --exclude-standard -z | rsync -a0 --files-from=- "$repo/" "$work/repo/"
[ -d "$repo/relay/test/.bin" ] && cp -a "$repo/relay/test/.bin" "$work/repo/relay/test/.bin"
# Dependencies are links into the lane, each workspace's too, so that a focused test can run.
(cd "$repo" && find . -name node_modules -type d -prune) | while read -r d; do mkdir -p "$work/repo/$(dirname "$d")"; ln -s "$repo/$d" "$work/repo/$d"; done
[ -d "$repo/packages/protocol/dist" ] && cp -a "$repo/packages/protocol/dist" "$work/repo/packages/protocol/" || true
grep -rlI --exclude-dir=node_modules 'invariant0x@icloud' "$work/repo" | while read -r f; do [ -L "$f" ] || sed -i -E 's/invariant0x@icloud\.com/<owner-address>/g' "$f"; done
scrub < "$brief" > "$work/brief.md"
scrub < "$ROOT/specs/2026-11-02-single-network-design.md" > "$work/spec.md"
scrub < "$ROOT/network-build/progress.md" > "$work/ledger.md"
[ -n "$package" ] && scrub < "$package" > "$work/package.diff"
# The clean copy cannot reach the plugin folder, so the skills the rules name travel with it.
for skill in test-driven-development systematic-debugging verification-before-completion; do
  mkdir -p "$work/skills"; scrub < "$ROOT/plugins/superpowers/skills/$skill/SKILL.md" > "$work/skills/$skill.md"
done
# The public image names (invariant0x/hornhoof) are the repository's public code; only the address must not travel.
if grep -rlI --exclude-dir=node_modules 'invariant0x@' "$work" >/dev/null; then echo "address left in the copy, stopping" >&2; exit 4; fi
where="Your workspace is the folder above this one. Read ../brief.md first, all of it, then the skills in ../skills/ and follow them. ../spec.md is the spec, ../ledger.md the ledger, the current folder is the repository. Paths in the brief that start with /home/altera/hornhoof-network mean these. Read nothing outside the workspace, and do not look for a .git folder: there is none."
if [ "$mode" = review ]; then
  prompt="$where The change under review is ../package.diff. Follow the brief's reviewer instructions, read only. Your final message is the findings list."
  flags=(--mode plan); out=$ROOT/network-build/runs/$label-agy.md
else
  prompt="$where Follow the brief's writer instructions in this copy. Change only the files the task names, test first. Your final message is the report."
  flags=(--mode accept-edits); out=$ROOT/network-build/runs/$label-agy-report.md
fi
cd "$work/repo" || exit 1
nice -n 10 ~/.local/bin/agy -p "$prompt" "${flags[@]}" --sandbox --dangerously-skip-permissions --model "$MODEL" --effort high --output-format text --print-timeout 40m > "$out" 2> "$out.err"
code=$?
if [ "$mode" = write ]; then
  # The scrub is undone in the copy first, so that the diff holds only what Antigravity changed.
  grep -rlI --exclude-dir=node_modules '<owner-address>' "$work/repo" | while read -r f; do [ -L "$f" ] || sed -i 's/<owner-address>/invariant0x@icloud.com/g' "$f"; done
  diff -ruN --exclude=node_modules --exclude=.bin --exclude=__pycache__ --exclude=.metrics --exclude=target "$repo" "$work/repo" 2>/dev/null | grep -v '^Only in .*\.git' > "$ROOT/network-build/runs/$label-agy.diff"
fi
echo "agy $mode $label: exit $code, $(wc -c < "$out") bytes in $out"
rm -rf "$work"
exit $code
