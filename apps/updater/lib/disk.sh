# shellcheck shell=bash
# Docker's own share of a machine's disk: old Hornhoof images, leftover test stands, stale build cache, and the Docker
# figures handed to each running Hornhoof node on this computer. Only resources identified by Hornhoof's exact image
# repositories or labels are ever removed; node volumes, database volumes, and anything Hornhoof did not make stay untouched.

DISK_AT=0
DISK_DAY_S=86400
DISK_CLEANED_MAX=50
DISK_STATE_MAX_BYTES=65536
DISK_FUTURE_S=300
DISK_PRIVATE_DIR=''

# Shared jq helpers: parse Docker human sizes (SI and IEC) into integer bytes, and RFC3339 timestamps (with optional
# fractional seconds and timezone offsets) into Unix epoch seconds.
# shellcheck disable=SC2016 # the dollars belong to jq
DISK_JQ_HELPERS='
def to_bytes:
  if type == "number" then floor
  elif type != "string" then 0
  else
    (capture("^\\s*(?<n>[0-9]+(?:\\.[0-9]+)?)\\s*(?<u>[A-Za-z]+)\\s*$") // null) as $m
    | if $m == null then 0
      else (($m.n | tonumber) * (
        if $m.u == "B" then 1
        elif ($m.u == "kB" or $m.u == "KB") then 1000
        elif $m.u == "MB" then 1000000
        elif $m.u == "GB" then 1000000000
        elif $m.u == "TB" then 1000000000000
        elif $m.u == "KiB" then 1024
        elif $m.u == "MiB" then 1048576
        elif $m.u == "GiB" then 1073741824
        elif $m.u == "TiB" then 1099511627776
        else 0 end
      )) | floor
      end
  end;

def parse_ts:
  if type != "string" then null
  else
    (capture("^(?<base>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\\.[0-9]+)?(?<tz>Z|[+-][0-9]{2}:[0-9]{2})$") // null) as $m
    | if $m == null then null
      else
        (($m.base + "Z") | try fromdateiso8601 catch null) as $epoch
        | if $epoch == null then null
          elif $m.tz == "Z" then $epoch
          else
            (($m.tz[1:3] | tonumber) * 3600 + ($m.tz[4:6] | tonumber) * 60) as $off
            | if $m.tz[0:1] == "+" then $epoch - $off else $epoch + $off end
          end
      end
  end;
'

disk_setting() {
  local val=$1 max=$2 def=$3
  case "$val" in '' | *[!0-9]*) printf '%s' "$def"; return 0 ;; esac
  if [ "$val" -le "$max" ]; then printf '%s' "$val"; else printf '%s' "$def"; fi
}

disk_safe_ref() {
  case "$1" in
    '' | -* | *'|'* | *[$' \t\r\n*?[']*) return 1 ;;
    *) return 0 ;;
  esac
}

disk_plain_lab() {
  local re='^[A-Za-z0-9._-]{1,128}$'
  [[ "$1" =~ $re ]]
}

disk_busy() {
  if declare -F update_running > /dev/null 2>&1 && update_running; then return 0; fi
  if [ -n "${SERVER_DIR:-}" ] && [ ! -L "$SERVER_DIR/backups/update.json" ] && [ -f "$SERVER_DIR/backups/update.json" ]; then return 0; fi
  if [ -n "${CONTROL:-}" ] && [ ! -L "$CONTROL/request.json" ] && [ -f "$CONTROL/request.json" ]; then return 0; fi
  if declare -F nodes_look_runs > /dev/null 2>&1 && nodes_look_runs; then return 0; fi
  return 1
}

# Inspects images in batches and writes only the fields needed for cleanup and accounting to out_file.
# Returns non-zero if Docker fails or returns empty/invalid output for a non-empty list (fail-closed).
disk_inspect_images() {
  local work_dir=$1 out_file=$2 raw_ids sorted_ids id i=0
  local -a ids=()
  raw_ids=$work_dir/img-ids.raw
  sorted_ids=$work_dir/img-ids.sorted
  docker image ls -aq --no-trunc > "$raw_ids" 2> /dev/null || return 1
  LC_ALL=C sort -u "$raw_ids" > "$sorted_ids" || return 1
  while IFS= read -r id || [ -n "$id" ]; do
    [ -n "$id" ] || continue
    disk_safe_ref "$id" || continue
    ids+=("$id")
  done < "$sorted_ids"
  if [ "${#ids[@]}" -eq 0 ]; then
    printf '[]\n' > "$out_file"
    return 0
  fi
  (
    while [ "$i" -lt "${#ids[@]}" ]; do
      docker image inspect --format '{{json .}}' "${ids[@]:i:100}" 2> /dev/null || exit 1
      i=$((i + 100))
    done
  ) | jq -sc 'map({Id: .Id, Created: .Created, Size: .Size, RepoTags: .RepoTags, RepoDigests: .RepoDigests})' \
    > "$out_file" 2> /dev/null || return 1
  jq -e 'type == "array" and length > 0' "$out_file" > /dev/null 2>&1
}

# Inspects containers in batches and strips .Config.Env and other sensitive/bulky fields in-stream so secrets never
# appear in argv, shell variables, or temp files. Fails closed on Docker/jq errors.
disk_inspect_containers() {
  local work_dir=$1 out_file=$2 raw_ids sorted_ids id i=0
  local -a ids=()
  raw_ids=$work_dir/ctr-ids.raw
  sorted_ids=$work_dir/ctr-ids.sorted
  docker ps -aq > "$raw_ids" 2> /dev/null || return 1
  LC_ALL=C sort -u "$raw_ids" > "$sorted_ids" || return 1
  while IFS= read -r id || [ -n "$id" ]; do
    [ -n "$id" ] || continue
    disk_safe_ref "$id" || continue
    ids+=("$id")
  done < "$sorted_ids"
  if [ "${#ids[@]}" -eq 0 ]; then
    printf '[]\n' > "$out_file"
    return 0
  fi
  (
    while [ "$i" -lt "${#ids[@]}" ]; do
      docker inspect --size --format '{{json .}}' "${ids[@]:i:100}" 2> /dev/null || exit 1
      i=$((i + 100))
    done
  ) | jq -sc 'map({
    Id: .Id,
    Image: .Image,
    Created: .Created,
    SizeRw: .SizeRw,
    State: {Running: (.State.Running // false)},
    Config: {Labels: (.Config.Labels // {})},
    Mounts: ((.Mounts // []) | map({Type: .Type, Name: .Name}))
  })' > "$out_file" 2> /dev/null || return 1
  jq -e 'type == "array" and length > 0' "$out_file" > /dev/null 2>&1
}

# Inspects volumes in batches and projects only Name, CreatedAt, and Labels to out_file. Fails closed on errors.
disk_inspect_volumes() {
  local work_dir=$1 out_file=$2 raw_names sorted_names name i=0
  local -a names=()
  raw_names=$work_dir/vol-names.raw
  sorted_names=$work_dir/vol-names.sorted
  docker volume ls -q > "$raw_names" 2> /dev/null || return 1
  LC_ALL=C sort -u "$raw_names" > "$sorted_names" || return 1
  while IFS= read -r name || [ -n "$name" ]; do
    [ -n "$name" ] || continue
    disk_safe_ref "$name" || continue
    names+=("$name")
  done < "$sorted_names"
  if [ "${#names[@]}" -eq 0 ]; then
    printf '[]\n' > "$out_file"
    return 0
  fi
  (
    while [ "$i" -lt "${#names[@]}" ]; do
      docker volume inspect --format '{{json .}}' "${names[@]:i:100}" 2> /dev/null || exit 1
      i=$((i + 100))
    done
  ) | jq -sc 'map({Name: .Name, CreatedAt: .CreatedAt, Labels: (.Labels // {})})' \
    > "$out_file" 2> /dev/null || return 1
  jq -e 'type == "array" and length > 0' "$out_file" > /dev/null 2>&1
}

disk_df_build_cache() {
  local work_dir=$1 raw out
  raw=$work_dir/df-cache.ndjson
  docker system df --format '{{json .}}' > "$raw" 2> /dev/null || return 1
  if [ ! -s "$raw" ]; then
    printf '0'
    return 0
  fi
  out=$(jq -s -r "$DISK_JQ_HELPERS"'
    (map(select(.Type == "Build Cache")) | .[0].Size // "0B") | to_bytes
  ' < "$raw" 2> /dev/null) || return 1
  plain_number "${out:-}" || return 1
  printf '%s' "$out"
}

disk_df_volumes() {
  local out_file=$1
  if docker system df -v --format '{{json .}}' 2> /dev/null | jq -sc "$DISK_JQ_HELPERS"'
    ((.[0].Volumes // []) | map({key: .Name, value: (.Size | to_bytes)}) | from_entries) // {}
  ' > "$out_file" 2> /dev/null && jq -e 'type == "object"' "$out_file" > /dev/null 2>&1; then
    return 0
  fi
  printf '{}\n' > "$out_file"
  return 1
}

# Total and free bytes of Docker's disk (the filesystem this updater runs on).
disk_fs_space() {
  local raw out
  raw=$(df -Pk / 2> /dev/null || true)
  out=$(printf '%s\n' "$raw" | awk 'NR == 2 && $2 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ { printf "%.0f %.0f\n", $2 * 1024, $4 * 1024 }' || true)
  printf '%s\n' "${out:-0 0}"
}

# Removes old images of Hornhoof's three repositories, keeping the two newest per repository (for rollback) and any image
# referenced by a running or stopped container. Never uses -f and requires all tags and digests to belong to Hornhoof.
# Prints total freed bytes.
disk_clean_images() {
  local work_dir=$1 images_file=$2 containers_file=$3 plan_file id size refs freed=0 ref ok
  local -a ref_arr=()
  plan_file=$work_dir/clean-images.plan
  # shellcheck disable=SC2016 # the dollars belong to jq
  jq -nr \
    --slurpfile images_wrap "$images_file" \
    --slurpfile containers_wrap "$containers_file" \
    --arg app "$IMAGE" \
    --arg node "$NODE_IMAGE" \
    --arg upd "$UPDATER_IMAGE" \
    "$DISK_JQ_HELPERS"'
    ($images_wrap[0] // []) as $images |
    ($containers_wrap[0] // []) as $containers |
    def is_repo($r):
      ((.RepoTags // []) | any(startswith($r + ":"))) or
      ((.RepoDigests // []) | any(startswith($r + "@")));
    def own_tags:
      ((.RepoTags // []) | map(select(. != "<none>:<none>")));
    def own_digests:
      ((.RepoDigests // []) | map(select(. != "<none>@<none>")));
    def only_own_tags:
      (own_tags | all(startswith($app + ":") or startswith($node + ":") or startswith($upd + ":")));
    def only_own_digests:
      (own_digests | all(startswith($app + "@") or startswith($node + "@") or startswith($upd + "@")));
    def created_key: (.Created | parse_ts) // 0;

    ([$containers[].Image | select(type == "string")] | unique) as $used |
    ([$app, $node, $upd] | map(. as $r |
      ($images | map(select(is_repo($r) and only_own_tags and only_own_digests)) | sort_by(-(created_key)) | .[0:2] | map(.Id))
    ) | add | unique) as $keep_recent |
    ($keep_recent + $used | unique) as $keep |
    $images
    | map(select((is_repo($app) or is_repo($node) or is_repo($upd)) and only_own_tags and only_own_digests))
    | map(select(.Id as $id | ($keep | index($id)) == null))
    | .[]
    | (own_tags | if length > 1 then join(" ") else "" end) as $multi |
    [.Id, ((.Size // 0) | floor | tostring), (if $multi != "" then $multi else .Id end)] | join("|")
  ' > "$plan_file" 2> /dev/null || : > "$plan_file"

  while IFS='|' read -r id size refs || [ -n "$id" ]; do
    [ -n "$id" ] || continue
    disk_safe_ref "$id" || continue
    plain_number "${size:-}" || size=0
    ref_arr=()
    IFS=' ' read -r -a ref_arr <<< "$refs" || true
    [ "${#ref_arr[@]}" -gt 0 ] || continue
    ok=1
    for ref in "${ref_arr[@]}"; do
      disk_safe_ref "$ref" || { ok=0; break; }
    done
    [ "$ok" = 1 ] || continue
    if docker rmi "${ref_arr[@]}" > /dev/null 2>&1; then
      printf 'Removed old Hornhoof image %s (%s bytes).\n' "$id" "$size" >&2
      freed=$((freed + size))
    fi
  done < "$plan_file"
  printf '%s' "$freed"
}

# Removes day-old hornhoof.lab test stands whole (containers, volumes and networks), plus stale exited io.hornhoof.since
# port-lock containers (without -f). Prints "<freed_containers> <freed_volumes>".
disk_clean_labs() {
  local work_dir=$1 containers_file=$2 volumes_file=$3 vol_sizes_file=$4 now=$5 lab_age=$6
  local plan_file lock_file lab cids vols cbytes vbytes cid size freed_c=0 freed_v=0 id net ok
  local -a cid_arr=() vol_arr=() nets=()
  plan_file=$work_dir/clean-labs.plan
  lock_file=$work_dir/clean-locks.plan
  # shellcheck disable=SC2016 # the dollars belong to jq
  jq -nr \
    --slurpfile containers_wrap "$containers_file" \
    --slurpfile volumes_wrap "$volumes_file" \
    --slurpfile vsizes_wrap "$vol_sizes_file" \
    --argjson now "$now" \
    --argjson age "$lab_age" \
    "$DISK_JQ_HELPERS"'
    ($containers_wrap[0] // []) as $containers |
    ($volumes_wrap[0] // []) as $volumes |
    ($vsizes_wrap[0] // {}) as $vsizes |
    def expired($ts): ($ts != null) and ($ts > 0) and (($now - $ts) >= $age);

    (([$containers[] | select((.Config.Labels["hornhoof.lab"] // "") != "") | .Config.Labels["hornhoof.lab"]]
      + [$volumes[] | select((.Labels["hornhoof.lab"] // "") != "") | .Labels["hornhoof.lab"]]) | unique) as $labs |
    $labs[] as $lab |
    ($containers | map(select((.Config.Labels["hornhoof.lab"] // "") == $lab))) as $cs |
    ($volumes | map(select((.Labels["hornhoof.lab"] // "") == $lab))) as $vs |
    (($cs | map(.Created | parse_ts)) + ($vs | map(.CreatedAt | parse_ts))) as $times |
    select(($times | length) > 0 and ($times | all(expired(.)))) |
    [
      $lab,
      ($cs | map(.Id) | join(" ")),
      ($vs | map(.Name) | join(" ")),
      ($cs | map(.SizeRw // 0) | add // 0 | floor | tostring),
      ($vs | map($vsizes[.Name] // 0) | add // 0 | floor | tostring)
    ] | join("|")
  ' > "$plan_file" 2> /dev/null || : > "$plan_file"

  while IFS='|' read -r lab cids vols cbytes vbytes || [ -n "$lab" ]; do
    [ -n "$lab" ] || continue
    disk_plain_lab "$lab" || continue
    plain_number "${cbytes:-}" || cbytes=0
    plain_number "${vbytes:-}" || vbytes=0
    if [ -n "$cids" ]; then
      cid_arr=()
      IFS=' ' read -r -a cid_arr <<< "$cids" || true
      ok=1
      if [ "${#cid_arr[@]}" -gt 0 ]; then
        for id in "${cid_arr[@]}"; do disk_safe_ref "$id" || { ok=0; break; }; done
        if [ "$ok" = 1 ] && docker rm -f -v "${cid_arr[@]}" > /dev/null 2>&1; then
          freed_c=$((freed_c + cbytes))
        fi
      fi
    fi
    if [ -n "$vols" ]; then
      vol_arr=()
      IFS=' ' read -r -a vol_arr <<< "$vols" || true
      ok=1
      if [ "${#vol_arr[@]}" -gt 0 ]; then
        for id in "${vol_arr[@]}"; do disk_safe_ref "$id" || { ok=0; break; }; done
        if [ "$ok" = 1 ] && docker volume rm -f "${vol_arr[@]}" > /dev/null 2>&1; then
          freed_v=$((freed_v + vbytes))
        fi
      fi
    fi
    nets=()
    if docker network ls --filter "label=hornhoof.lab=$lab" -q > "$work_dir/nets.raw" 2> /dev/null; then
      LC_ALL=C sort -u "$work_dir/nets.raw" > "$work_dir/nets.sorted" 2> /dev/null || : > "$work_dir/nets.sorted"
      while IFS= read -r net || [ -n "$net" ]; do
        [ -n "$net" ] || continue
        disk_safe_ref "$net" || continue
        nets+=("$net")
      done < "$work_dir/nets.sorted"
    fi
    if [ "${#nets[@]}" -gt 0 ]; then
      docker network rm "${nets[@]}" > /dev/null 2>&1 || true
    fi
    printf 'Removed expired test stand hornhoof.lab=%s (containers %s bytes, volumes %s bytes).\n' "$lab" "$cbytes" "$vbytes" >&2
  done < "$plan_file"

  # Stale exited port-lock containers created by install.sh (io.hornhoof.since). Never uses -f so a container that started
  # running after inspect is refused by Docker.
  # shellcheck disable=SC2016 # the dollars belong to jq
  jq -nr \
    --slurpfile containers_wrap "$containers_file" \
    --argjson now "$now" \
    --argjson age "$lab_age" \
    '
    ($containers_wrap[0] // [])[]
    | select((.State.Running // false) == false)
    | (.Config.Labels["io.hornhoof.since"] // "") as $since
    | select($since | test("^[0-9]+$"))
    | ($since | tonumber) as $ts
    | select($ts > 0 and (($now - $ts) >= $age))
    | [.Id, ((.SizeRw // 0) | floor | tostring)] | join("|")
  ' > "$lock_file" 2> /dev/null || : > "$lock_file"

  while IFS='|' read -r cid size || [ -n "$cid" ]; do
    [ -n "$cid" ] || continue
    disk_safe_ref "$cid" || continue
    plain_number "${size:-}" || size=0
    if docker rm -v "$cid" > /dev/null 2>&1; then
      printf 'Removed stale Hornhoof lock container %s (%s bytes).\n' "$cid" "$size" >&2
      freed_c=$((freed_c + size))
    fi
  done < "$lock_file"

  printf '%s %s' "$freed_c" "$freed_v"
}

# Whether Docker's disk is short of free space against max(share% of total, HORNHOOF_DISK_GB in decimal GB).
disk_is_short() {
  local total=$1 free=$2 disk_share disk_gb ans
  disk_share=$(disk_setting "${HORNHOOF_DISK_SHARE:-}" 90 10)
  disk_gb=$(disk_setting "${HORNHOOF_DISK_GB:-}" 4096 20)
  # shellcheck disable=SC2016 # the dollars belong to jq
  ans=$(jq -nr \
    --argjson total "${total:-0}" \
    --argjson free "${free:-0}" \
    --argjson dshare "$disk_share" \
    --argjson dgb "$disk_gb" \
    '
    def max_of($a; $b): if $a > $b then $a else $b end;
    if $total <= 0 then "no"
    else
      max_of((($total * $dshare) / 100) | round; $dgb * 1000000000) as $dthresh |
      if $free < $dthresh then "yes" else "no" end
    end
  ' 2> /dev/null || printf 'no')
  [ "$ans" = yes ]
}

# Prunes dangling (<none>:<none>) images unused by any running or stopped container when the machine is short of space.
# Never passes -a/--all so tagged images and images referenced by stopped rollback containers stay untouched.
disk_clean_dangling_images() {
  local total=$1 free=$2 out line reclaimed=0
  if disk_is_short "$total" "$free"; then
    out=$(docker image prune -f --filter dangling=true 2> /dev/null || true)
    line=$(printf '%s\n' "$out" | sed -n 's/^Total reclaimed space:[[:space:]]*//p' | tail -n 1 || true)
    if [ -n "$line" ]; then
      reclaimed=$(printf '%s\n' "$line" | jq -R -r "$DISK_JQ_HELPERS"' to_bytes' 2> /dev/null || true)
    fi
    plain_number "${reclaimed:-}" || reclaimed=0
    if [ "$reclaimed" -gt 0 ]; then
      printf 'Pruned %s bytes of dangling Docker images.\n' "$reclaimed" >&2
    fi
  fi
  printf '%s' "$reclaimed"
}

# Prunes all unused Docker build cache when the disk is below its decimal GB threshold, or build cache unused for
# HORNHOOF_BUILD_CACHE_UNTIL (default 72h) when the cache exceeds its limit. Prints reclaimed bytes.
disk_clean_build_cache() {
  local cache_bytes=$1 total=$2 free=$3
  local disk_share disk_gb cache_share cache_gb until_dur until_re mode out reclaimed=0
  disk_share=$(disk_setting "${HORNHOOF_DISK_SHARE:-}" 90 10)
  disk_gb=$(disk_setting "${HORNHOOF_DISK_GB:-}" 4096 20)
  cache_share=$(disk_setting "${HORNHOOF_BUILD_CACHE_SHARE:-}" 90 10)
  cache_gb=$(disk_setting "${HORNHOOF_BUILD_CACHE_GB:-}" 4096 10)
  until_dur=${HORNHOOF_BUILD_CACHE_UNTIL:-72h}
  until_re='^[1-9][0-9]*[hms]$'
  [[ "$until_dur" =~ $until_re ]] || until_dur=72h

  # shellcheck disable=SC2016 # the dollars belong to jq
  mode=$(jq -nr \
    --argjson total "${total:-0}" \
    --argjson free "${free:-0}" \
    --argjson cache "${cache_bytes:-0}" \
    --argjson dshare "$disk_share" \
    --argjson dgb "$disk_gb" \
    --argjson cshare "$cache_share" \
    --argjson cgb "$cache_gb" \
    '
    def max_of($a; $b): if $a > $b then $a else $b end;
    if $total <= 0 then "no"
    else
      max_of((($total * $dshare) / 100) | round; $dgb * 1000000000) as $dthresh |
      max_of((($total * $cshare) / 100) | round; $cgb * 1000000000) as $climit |
      if $free < $dthresh then "all"
      elif $cache > $climit then "aged"
      else "no" end
    end
  ' 2> /dev/null || printf 'no')

  if [ "$mode" = all ] || [ "$mode" = aged ]; then
    local line
    if [ "$mode" = all ]; then
      out=$(docker builder prune -f 2> /dev/null || true)
    else
      out=$(docker builder prune -f --filter "until=$until_dur" 2> /dev/null || true)
    fi
    line=$(printf '%s\n' "$out" | sed -n 's/^Total reclaimed space:[[:space:]]*//p' | tail -n 1 || true)
    if [ -n "$line" ]; then
      reclaimed=$(printf '%s\n' "$line" | jq -R -r "$DISK_JQ_HELPERS"' to_bytes' 2> /dev/null || true)
    fi
    plain_number "${reclaimed:-}" || reclaimed=0
    if [ "$reclaimed" -gt 0 ]; then
      if [ "$mode" = all ]; then
        printf 'Pruned %s bytes of Docker build cache.\n' "$reclaimed" >&2
      else
        printf 'Pruned %s bytes of Docker build cache (unused for %s).\n' "$reclaimed" "$until_dur" >&2
      fi
    fi
  fi
  printf '%s' "$reclaimed"
}

disk_in_shared() {
  local dir=${1%/*}
  dir=${dir%/}
  if [ -n "${CONTROL:-}" ]; then
    case "$dir" in "${CONTROL%/}" | "${CONTROL%/}"/?*) return 0 ;; esac
  fi
  if [ -n "${COMPUTER_CONTROL:-}" ]; then
    case "$dir" in "${COMPUTER_CONTROL%/}" | "${COMPUTER_CONTROL%/}"/?*) return 0 ;; esac
  fi
  return 1
}

# Reads the cleaned-history state file safely through shared.sh's take/take_here (never following symlinks or blocking
# on FIFOs) with a strict byte cap before jq ever parses it.
disk_read_state() {
  local state_file=$1 work_dir=$2 out_file=$3 raw_file parent base bytes
  raw_file=$work_dir/prev.raw
  printf '[]\n' > "$out_file"
  [ -n "$state_file" ] || return 0
  case "$state_file" in */*) ;; *) return 0 ;; esac
  parent=${state_file%/*}
  base=${state_file##*/}
  [ -n "$parent" ] && [ -n "$base" ] && [ "$base" != . ] && [ "$base" != .. ] || return 0

  if disk_in_shared "$state_file"; then
    take "$state_file" quiet head -c "$((DISK_STATE_MAX_BYTES + 1))" > "$raw_file" || return 0
  else
    [ -d "$parent" ] || return 0
    (cd -P -- "$parent" 2> /dev/null && take_here "$base" quiet head -c "$((DISK_STATE_MAX_BYTES + 1))") > "$raw_file" || return 0
  fi

  bytes=$(wc -c < "$raw_file" | tr -d '[:space:]')
  if ! plain_number "$bytes" || [ "$bytes" -eq 0 ] || [ "$bytes" -gt "$DISK_STATE_MAX_BYTES" ]; then
    return 0
  fi
  jq -c 'if type == "array" then . else [] end' < "$raw_file" > "$out_file" 2> /dev/null || printf '[]\n' > "$out_file"
}

# Atomically writes the cleaned-history state file via private 0700 staging and move_over (never following symlinks,
# never dropping files into a symlinked directory, and never opening a FIFO).
disk_write_state() {
  local state_file=$1 src_file=$2 parent base
  [ -n "$state_file" ] || return 0
  case "$state_file" in */*) ;; *) return 0 ;; esac
  parent=${state_file%/*}
  base=${state_file##*/}
  [ -n "$parent" ] && [ -n "$base" ] && [ "$base" != . ] && [ "$base" != .. ] || return 0

  if disk_in_shared "$state_file"; then
    publish "$state_file" over cat -- "$src_file" 2> /dev/null || true
  else
    [ -d "$parent" ] || return 0
    (cd -P -- "$parent" 2> /dev/null && put_in_place "$base" disk-cleaned over cat -- "$src_file") 2> /dev/null || true
  fi
}

# Updates the rolling 24-hour cleaned log with strict field/timestamp validation and writes the array to cleaned_file.
disk_update_cleaned() {
  local state_file=$1 work_dir=$2 now=$3 stamp=$4 freed_i=$5 freed_c=$6 freed_v=$7 freed_b=$8 cleaned_file=$9
  local prev_file=$work_dir/prev.json
  disk_read_state "$state_file" "$work_dir" "$prev_file"
  # shellcheck disable=SC2016 # the dollars belong to jq
  if ! jq -nc \
    --slurpfile prev_wrap "$prev_file" \
    --argjson now "$now" \
    --arg stamp "$stamp" \
    --argjson freed_img "$freed_i" \
    --argjson freed_ctr "$freed_c" \
    --argjson freed_vol "$freed_v" \
    --argjson freed_bld "$freed_b" \
    --argjson day "$DISK_DAY_S" \
    --argjson future "$DISK_FUTURE_S" \
    --argjson cap "$DISK_CLEANED_MAX" \
    "$DISK_JQ_HELPERS"'
    def valid_part: . == "images" or . == "containers" or . == "volumes" or . == "buildCache";
    def valid_entry:
      type == "object"
      and (.part | type == "string" and valid_part)
      and (.bytes | type == "number" and (. > 0) and (. <= 9007199254740991) and (. == floor))
      and (.at | type == "string")
      and ((.at | parse_ts) as $t | $t != null and $t > 0 and (($now - $t) >= (0 - $future)) and (($now - $t) <= $day));

    ([
      {part: "images", bytes: $freed_img, at: $stamp},
      {part: "containers", bytes: $freed_ctr, at: $stamp},
      {part: "volumes", bytes: $freed_vol, at: $stamp},
      {part: "buildCache", bytes: $freed_bld, at: $stamp}
    ] | map(select(.bytes > 0))) as $added |
    (($prev_wrap[0] // [])
      | if type == "array" then . else [] end
      | map(select(valid_entry) | {part: .part, bytes: .bytes, at: .at})) as $clean_prev |
    ($added + $clean_prev) | .[0:$cap]
  ' > "$cleaned_file" 2> /dev/null || [ ! -s "$cleaned_file" ]; then
    printf '[]\n' > "$cleaned_file"
  fi
  disk_write_state "$state_file" "$cleaned_file"
}

# Measures Hornhoof's Docker parts after cleaning and copies docker-disk.json into every running Hornhoof node container.
# Fails closed on Docker inspection errors so partial data never overwrites a node's existing report.
disk_measure_and_deliver() {
  local work_dir=$1 stamp=$2 cleaned_file=$3
  local images_file=$work_dir/post-images.json
  local containers_file=$work_dir/post-containers.json
  local volumes_file=$work_dir/post-volumes.json
  local vsizes_file=$work_dir/post-vsizes.json
  local targets_file=$work_dir/targets.txt
  local report_file=$work_dir/docker-disk.json
  local cache_bytes own_project='' cid

  disk_inspect_images "$work_dir" "$images_file" || return 0
  disk_inspect_containers "$work_dir" "$containers_file" || return 0
  disk_inspect_volumes "$work_dir" "$volumes_file" || return 0
  disk_df_volumes "$vsizes_file" || return 0
  cache_bytes=$(disk_df_build_cache "$work_dir") || return 0
  if [ -n "${SERVER_DIR:-}" ]; then own_project=$(compose_project 2> /dev/null || true); fi

  # shellcheck disable=SC2016 # the dollars belong to jq
  jq -nr \
    --slurpfile images_wrap "$images_file" \
    --slurpfile containers_wrap "$containers_file" \
    --arg app "$IMAGE" \
    --arg node "$NODE_IMAGE" \
    --arg upd "$UPDATER_IMAGE" \
    --arg own_project "$own_project" \
    '
    ($images_wrap[0] // []) as $images |
    ($containers_wrap[0] // []) as $containers |
    def is_own_image:
      ((.RepoTags // []) | any(startswith($app + ":") or startswith($node + ":") or startswith($upd + ":"))) or
      ((.RepoDigests // []) | any(startswith($app + "@") or startswith($node + "@") or startswith($upd + "@")));
    ([$images[] | select(is_own_image) | .Id] | unique) as $own_img_ids |
    ([
      (if $own_project != "" then $own_project else empty end),
      ($containers[]
        | select((.Config.Labels["com.docker.compose.project"] // "") != "")
        | select(.Image as $img | ($own_img_ids | index($img)) != null)
        | .Config.Labels["com.docker.compose.project"])
    ] | unique) as $own_projects |
    $containers[]
    | select((.State.Running // false) == true)
    | select(
        ((.Config.Labels["hornhoof.subscription"] // "") != "") or
        ((.Config.Labels["com.docker.compose.service"] // "") == "node" and
          ((.Config.Labels["com.docker.compose.project"] // "") as $p | $p != "" and (($own_projects | index($p)) != null)))
      )
    | .Id
  ' 2> /dev/null | LC_ALL=C sort -u > "$targets_file" || return 0
  [ -s "$targets_file" ] || return 0

  # shellcheck disable=SC2016 # the dollars belong to jq
  jq -nc \
    --arg stamp "$stamp" \
    --slurpfile images_wrap "$images_file" \
    --slurpfile containers_wrap "$containers_file" \
    --slurpfile volumes_wrap "$volumes_file" \
    --slurpfile vsizes_wrap "$vsizes_file" \
    --argjson cache "${cache_bytes:-0}" \
    --slurpfile cleaned_wrap "$cleaned_file" \
    --arg app "$IMAGE" \
    --arg node "$NODE_IMAGE" \
    --arg upd "$UPDATER_IMAGE" \
    --arg own_project "$own_project" \
    '
    ($images_wrap[0] // []) as $images |
    ($containers_wrap[0] // []) as $containers |
    ($volumes_wrap[0] // []) as $volumes |
    ($vsizes_wrap[0] // {}) as $vsizes |
    ($cleaned_wrap[0] // []) as $cleaned |
    def is_own_image:
      ((.RepoTags // []) | any(startswith($app + ":") or startswith($node + ":") or startswith($upd + ":"))) or
      ((.RepoDigests // []) | any(startswith($app + "@") or startswith($node + "@") or startswith($upd + "@")));

    ([$images[] | select(is_own_image) | .Id] | unique) as $own_img_ids |
    ([
      (if $own_project != "" then $own_project else empty end),
      ($containers[]
        | select((.Config.Labels["com.docker.compose.project"] // "") != "")
        | select(.Image as $img | ($own_img_ids | index($img)) != null)
        | .Config.Labels["com.docker.compose.project"])
    ] | unique) as $own_projects |
    def is_own_container:
      ((.Config.Labels["hornhoof.subscription"] // "") != "") or
      ((.Config.Labels["hornhoof.updater"] // "") != "") or
      ((.Config.Labels["hornhoof.lab"] // "") != "") or
      ((.Config.Labels["io.hornhoof.since"] // "") != "") or
      ((.Config.Labels["com.docker.compose.project"] // "") as $p | $p != "" and (($own_projects | index($p)) != null));

    ($containers | map(select(is_own_container))) as $own_cs |
    ([
      ($volumes[]
        | select(
            ((.Labels["hornhoof.lab"] // "") != "") or
            ((.Labels["com.docker.compose.project"] // "") as $p | $p != "" and (($own_projects | index($p)) != null))
          )
        | .Name),
      ($own_cs[].Mounts[]? | select(.Type == "volume" and ((.Name // "") != "")) | .Name)
    ] | unique) as $own_vols |

    {
      at: $stamp,
      parts: {
        images: ($images | map(select(is_own_image) | (.Size // 0)) | add // 0 | floor),
        containers: ($own_cs | map(.SizeRw // 0) | add // 0 | floor),
        volumes: ($own_vols | map($vsizes[.] // 0) | add // 0 | floor),
        buildCache: ($cache | floor)
      },
      cleaned: $cleaned
    }
  ' > "$report_file" 2> /dev/null || return 0
  [ -s "$report_file" ] || return 0

  chmod 644 "$report_file" 2> /dev/null || true
  while IFS= read -r cid || [ -n "$cid" ]; do
    [ -n "$cid" ] || continue
    disk_safe_ref "$cid" || continue
    docker cp "$report_file" "$cid:/data/" > /dev/null 2>&1 || true
  done < "$targets_file"
}

disk_care_pass() {
  local work_dir=$1 state_file=$2 now=$3 stamp=$4 lab_age=$5
  local images_file=$work_dir/images.json
  local containers_file=$work_dir/containers.json
  local volumes_file=$work_dir/volumes.json
  local vsizes_file=$work_dir/vsizes.json
  local cleaned_file=$work_dir/cleaned.json
  local have_images=0 have_containers=0 have_volumes=0 have_cache=0
  local cache_bytes=0 total=0 free=0 freed_i=0 freed_c=0 freed_v=0 freed_b=0 lab_res=''

  if disk_inspect_images "$work_dir" "$images_file"; then have_images=1; fi
  if disk_inspect_containers "$work_dir" "$containers_file"; then have_containers=1; fi
  if disk_inspect_volumes "$work_dir" "$volumes_file"; then have_volumes=1; fi
  disk_df_volumes "$vsizes_file" || true
  if cache_bytes=$(disk_df_build_cache "$work_dir"); then have_cache=1; else cache_bytes=0; fi
  read -r total free <<< "$(disk_fs_space || printf '0 0')" || true
  plain_number "${total:-}" || total=0
  plain_number "${free:-}" || free=0

  if [ "$have_images" = 1 ] && [ "$have_containers" = 1 ]; then
    freed_i=$(disk_clean_images "$work_dir" "$images_file" "$containers_file")
    plain_number "${freed_i:-}" || freed_i=0
  fi
  if [ "$have_containers" = 1 ] && [ "$have_volumes" = 1 ]; then
    lab_res=$(disk_clean_labs "$work_dir" "$containers_file" "$volumes_file" "$vsizes_file" "$now" "$lab_age")
    read -r freed_c freed_v <<< "${lab_res:-0 0}" || true
    plain_number "${freed_c:-}" || freed_c=0
    plain_number "${freed_v:-}" || freed_v=0
  fi
  read -r total free <<< "$(disk_fs_space || printf '0 0')" || true
  plain_number "${total:-}" || total=0
  plain_number "${free:-}" || free=0
  if [ "$have_images" = 1 ] && [ "$have_containers" = 1 ]; then
    local freed_dangling=0
    freed_dangling=$(disk_clean_dangling_images "$total" "$free")
    plain_number "${freed_dangling:-}" || freed_dangling=0
    freed_i=$((freed_i + freed_dangling))
    if [ "$freed_dangling" -gt 0 ]; then
      read -r total free <<< "$(disk_fs_space || printf '0 0')" || true
      plain_number "${total:-}" || total=0
      plain_number "${free:-}" || free=0
    fi
  fi
  if [ "$have_cache" = 1 ]; then
    freed_b=$(disk_clean_build_cache "$cache_bytes" "$total" "$free")
    plain_number "${freed_b:-}" || freed_b=0
  fi

  disk_update_cleaned "$state_file" "$work_dir" "$now" "$stamp" "$freed_i" "$freed_c" "$freed_v" "$freed_b" "$cleaned_file"
  disk_measure_and_deliver "$work_dir" "$stamp" "$cleaned_file"
}

# One paced pass of Docker disk care. Runs at most once per HORNHOOF_DISK_EVERY seconds (default 1 hour) and skips while an
# update or worker node catch-up is active.
disk_care() {
  local every now stamp lab_age state_file='' work_dir
  if disk_busy; then return 0; fi
  every=$(disk_setting "${HORNHOOF_DISK_EVERY:-}" 86400 3600)
  now=$(date +%s)
  plain_number "$now" || return 0
  if [ "$every" -gt 0 ] && [ "$now" -lt "$DISK_AT" ]; then return 0; fi
  DISK_AT=$((now + every))

  stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  lab_age=$(disk_setting "${HORNHOOF_DISK_LAB_AGE:-}" 2592000 86400)
  if [ -n "${HORNHOOF_DISK_STATE:-}" ]; then
    state_file=$HORNHOOF_DISK_STATE
  elif [ -n "${SERVER_DIR:-}" ] && [ -d "$SERVER_DIR" ] && [ ! -L "$SERVER_DIR" ] && [ -w "$SERVER_DIR" ]; then
    state_file=$SERVER_DIR/.disk-cleaned.json
  else
    if [ -z "${DISK_PRIVATE_DIR:-}" ] || [ ! -d "$DISK_PRIVATE_DIR" ] || [ -L "$DISK_PRIVATE_DIR" ] || [ ! -O "$DISK_PRIVATE_DIR" ]; then
      DISK_PRIVATE_DIR=$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/hornhoof-disk-state.XXXXXXXX" 2> /dev/null || true)
    fi
    if [ -n "${DISK_PRIVATE_DIR:-}" ]; then
      state_file=$DISK_PRIVATE_DIR/disk-cleaned.json
    fi
  fi

  work_dir=$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/hornhoof-disk-work.XXXXXXXX" 2> /dev/null || true)
  [ -n "$work_dir" ] || return 0
  work_dir=$(cd -P -- "$work_dir" && physical_dir) || { rm -rf -- "${work_dir:?}"; return 0; }
  (
    trap 'rm -rf -- "${work_dir:?}"' EXIT
    disk_care_pass "$work_dir" "$state_file" "$now" "$stamp" "$lab_age"
  )
}
