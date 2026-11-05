#!/usr/bin/env bash
set -euo pipefail
export CI=true NO_COLOR=1 FORCE_COLOR=0 VITEST_MAX_WORKERS=2
printf '%s  %s\n' '66b0a5f749b0a43db012cbcc8fa60f1ca102a74f9edc2ab31da384a104f787d6' "$HH_IN/pinned-sources.tar.gz" | sha256sum --check
mkdir -p .metrics/paired-source
tar -xzf "$HH_IN/pinned-sources.tar.gz" -C .metrics/paired-source
git fetch --quiet --update-shallow --no-tags "$PWD/.metrics/paired-source/source.git" refs/heads/control refs/heads/optimized
status=0
node scripts/benchmarks/linux-pair.mjs 05c63819d59c0cbba044132c89c503f30cb49856 54340764df895693cabdad4027fdad2ffcf48e38 | tee "$HH_OUT/pair-measurements.log" || status=$?
shopt -s nullglob
logs=(.metrics/paired-tests/*.log)
if ((${#logs[@]})); then tar -czf "$HH_OUT/pair-stage-logs.tar.gz" -- "${logs[@]}"; fi
exit "$status"
