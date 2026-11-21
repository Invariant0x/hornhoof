# shellcheck shell=bash
# Docker's own share of a machine's disk: old Hornhoof images, leftover test stands, stale build cache, and the Docker
# figures handed to each running Hornhoof node on this computer. Only resources identified by Hornhoof's exact image
# repositories or labels are ever removed; node volumes, database volumes, and anything Hornhoof did not make stay untouched.

DISK_AT=0
DISK_DAY_S=86400
DISK_CLEANED_MAX=50

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
  [[ "$1" =~ ^[A-Za-z0-9._-]{1,128}$ ]]
}

disk_busy() {
  if declare -F update_running > /dev/null 2>&1 && update_running; then return 0; fi
  if [ -n "${SERVER_DIR:-}" ] && [ -f "$SERVER_DIR/backups/update.json" ]; then return 0; fi
  if [ -n "${CONTROL:-}" ] && [ -f "$CONTROL/request.json" ]; then return 0; fi
  if declare -F nodes_look_runs > /dev/null 2>&1 && nodes_look_runs; then return 0; fi
  return 1
}

disk_inspect_images() {
  local -a ids=()
  local raw out
  mapfile -t ids < <(docker image ls -aq --no-trunc 2> /dev/null | awk '/^[^- \t\r\n*?[][^ \t\r\n*?[]*$/' | sort -u || true)
  if [ "${#ids[@]}" -eq 0 ]; then
    printf '[]'
    return 0
  fi
  raw=$(docker image inspect --format '{{json .}}' "${ids[@]}" 2> /dev/null || true)
  if [ -z "$raw" ]; then
    printf '[]'
    return 0
  fi
  out=$(printf '%s\n' "$raw" | jq -s '.' 2> /dev/null || true)
  printf '%s' "${out:-[]}"
}

disk_inspect_containers() {
  local -a ids=()
  local raw out
  mapfile -t ids < <(docker ps -aq 2> /dev/null | awk '/^[^- \t\r\n*?[][^ \t\r\n*?[]*$/' | sort -u || true)
  if [ "${#ids[@]}" -eq 0 ]; then
    printf '[]'
    return 0
  fi
  raw=$(docker inspect --size --format '{{json .}}' "${ids[@]}" 2> /dev/null || true)
  if [ -z "$raw" ]; then
    printf '[]'
    return 0
  fi
  out=$(printf '%s\n' "$raw" | jq -s '.' 2> /dev/null || true)
  printf '%s' "${out:-[]}"
}

disk_inspect_volumes() {
  local -a names=()
  local raw out
  mapfile -t names < <(docker volume ls -q 2> /dev/null | awk '/^[^- \t\r\n*?[][^ \t\r\n*?[]*$/' | sort -u || true)
  if [ "${#names[@]}" -eq 0 ]; then
    printf '[]'
    return 0
  fi
  raw=$(docker volume inspect --format '{{json .}}' "${names[@]}" 2> /dev/null || true)
  if [ -z "$raw" ]; then
    printf '[]'
    return 0
  fi
  out=$(printf '%s\n' "$raw" | jq -s '.' 2> /dev/null || true)
  printf '%s' "${out:-[]}"
}

disk_df_build_cache() {
  local raw out
  raw=$(docker system df --format '{{json .}}' 2> /dev/null || true)
  if [ -z "$raw" ]; then
    printf '0'
    return 0
  fi
  out=$(printf '%s\n' "$raw" | jq -s -r "$DISK_JQ_HELPERS"'
    (map(select(.Type == "Build Cache")) | .[0].Size // "0B") | to_bytes
  ' 2> /dev/null || true)
  printf '%s' "${out:-0}"
}

disk_df_volumes() {
  local raw out
  raw=$(docker system df -v --format '{{json .}}' 2> /dev/null || true)
  if [ -z "$raw" ]; then
    printf '{}'
    return 0
  fi
  out=$(printf '%s\n' "$raw" | jq -r "$DISK_JQ_HELPERS"'
    ((.Volumes // []) | map({key: .Name, value: (.Size | to_bytes)}) | from_entries) // {}
  ' 2> /dev/null || true)
  if [ -n "$out" ]; then printf '%s' "$out"; else printf '{}'; fi
}

# Total and free bytes of Docker's disk (the filesystem this updater runs on).
disk_fs_space() {
  local raw out
  raw=$(df -Pk / 2> /dev/null || true)
  out=$(printf '%s\n' "$raw" | awk 'NR == 2 && $2 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ { printf "%.0f %.0f\n", $2 * 1024, $4 * 1024 }' || true)
  printf '%s\n' "${out:-0 0}"
}

# Removes old images of Hornhoof's three repositories, keeping the two newest per repository (for rollback) and any image
# referenced by a running or stopped container. Never uses -f. Prints total freed bytes.
disk_clean_images() {
  local images_json=$1 containers_json=$2 plan id size refs freed=0 ref ok
  local -a ref_arr=()
  # shellcheck disable=SC2016 # the dollars belong to jq
  plan=$(jq -nr \
    --argjson images "$images_json" \
    --argjson containers "$containers_json" \
    --arg app "$IMAGE" \
    --arg node "$NODE_IMAGE" \
    --arg upd "$UPDATER_IMAGE" \
    "$DISK_JQ_HELPERS"'
    def is_repo($r):
      ((.RepoTags // []) | any(startswith($r + ":"))) or
      ((.RepoDigests // []) | any(startswith($r + "@")));
    def own_tags:
      ((.RepoTags // []) | map(select(. != "<none>:<none>")));
    def only_own_tags:
      (own_tags | all(startswith($app + ":") or startswith($node + ":") or startswith($upd + ":")));
    def created_key: (.Created | parse_ts) // 0;

    ([$containers[].Image | select(type == "string")] | unique) as $used |
    ([$app, $node, $upd] | map(. as $r |
      ($images | map(select(is_repo($r) and only_own_tags)) | sort_by(-(created_key)) | .[0:2] | map(.Id))
    ) | add | unique) as $keep_recent |
    ($keep_recent + $used | unique) as $keep |
    $images
    | map(select((is_repo($app) or is_repo($node) or is_repo($upd)) and only_own_tags))
    | map(select(.Id as $id | ($keep | index($id)) == null))
    | .[]
    | (own_tags | if length > 1 then join(" ") else "" end) as $multi |
    [.Id, ((.Size // 0) | floor | tostring), (if $multi != "" then $multi else .Id end)] | join("|")
  ' 2> /dev/null || true)

  while IFS='|' read -r id size refs; do
    [ -n "$id" ] || continue
    disk_safe_ref "$id" || continue
    plain_number "${size:-}" || size=0
    read -r -a ref_arr <<< "$refs"
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
  done <<< "$plan"
  printf '%s' "$freed"
}

# Removes day-old hornhoof.lab test stands whole (containers, volumes and networks), plus stale exited io.hornhoof.since
# port-lock containers. Prints "<freed_containers> <freed_volumes>".
disk_clean_labs() {
  local containers_json=$1 volumes_json=$2 vol_sizes_json=$3 now=$4 lab_age=$5
  local plan lab cids vols cbytes vbytes cid size freed_c=0 freed_v=0 id ok
  local -a cid_arr=() vol_arr=() nets=()
  # shellcheck disable=SC2016 # the dollars belong to jq
  plan=$(jq -nr \
    --argjson containers "$containers_json" \
    --argjson volumes "$volumes_json" \
    --argjson vsizes "$vol_sizes_json" \
    --argjson now "$now" \
    --argjson age "$lab_age" \
    "$DISK_JQ_HELPERS"'
    def expired($ts): ($ts != null) and (($now - $ts) >= $age);

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
  ' 2> /dev/null || true)

  while IFS='|' read -r lab cids vols cbytes vbytes; do
    [ -n "$lab" ] || continue
    disk_plain_lab "$lab" || continue
    plain_number "${cbytes:-}" || cbytes=0
    plain_number "${vbytes:-}" || vbytes=0
    if [ -n "$cids" ]; then
      read -r -a cid_arr <<< "$cids"
      ok=1
      for id in "${cid_arr[@]}"; do disk_safe_ref "$id" || { ok=0; break; }; done
      if [ "$ok" = 1 ] && [ "${#cid_arr[@]}" -gt 0 ] && docker rm -f -v "${cid_arr[@]}" > /dev/null 2>&1; then
        freed_c=$((freed_c + cbytes))
      fi
    fi
    if [ -n "$vols" ]; then
      read -r -a vol_arr <<< "$vols"
      ok=1
      for id in "${vol_arr[@]}"; do disk_safe_ref "$id" || { ok=0; break; }; done
      if [ "$ok" = 1 ] && [ "${#vol_arr[@]}" -gt 0 ] && docker volume rm -f "${vol_arr[@]}" > /dev/null 2>&1; then
        freed_v=$((freed_v + vbytes))
      fi
    fi
    mapfile -t nets < <(docker network ls --filter "label=hornhoof.lab=$lab" -q 2> /dev/null | awk '/^[^- \t\r\n*?[][^ \t\r\n*?[]*$/' | sort -u || true)
    if [ "${#nets[@]}" -gt 0 ]; then
      docker network rm "${nets[@]}" > /dev/null 2>&1 || true
    fi
    printf 'Removed expired test stand hornhoof.lab=%s (containers %s bytes, volumes %s bytes).\n' "$lab" "$cbytes" "$vbytes" >&2
  done <<< "$plan"

  # Stale exited port-lock containers created by install.sh (io.hornhoof.since).
  # shellcheck disable=SC2016 # the dollars belong to jq
  plan=$(jq -nr \
    --argjson containers "$containers_json" \
    --argjson now "$now" \
    --argjson age "$lab_age" \
    '
    $containers[]
    | select((.State.Running // false) == false)
    | (.Config.Labels["io.hornhoof.since"] // "") as $since
    | select($since | test("^[0-9]+$"))
    | select(($now - ($since | tonumber)) >= $age)
    | [.Id, ((.SizeRw // 0) | floor | tostring)] | join("|")
  ' 2> /dev/null || true)

  while IFS='|' read -r cid size; do
    [ -n "$cid" ] || continue
    disk_safe_ref "$cid" || continue
    plain_number "${size:-}" || size=0
    if docker rm -f -v "$cid" > /dev/null 2>&1; then
      printf 'Removed stale Hornhoof lock container %s (%s bytes).\n' "$cid" "$size" >&2
      freed_c=$((freed_c + size))
    fi
  done <<< "$plan"

  printf '%s %s' "$freed_c" "$freed_v"
}

# Prunes Docker build cache unused for HORNHOOF_BUILD_CACHE_UNTIL (default 72h) only when Docker's disk is under its
# threshold or the cache exceeds its limit (max of share and amount). Prints reclaimed bytes.
disk_clean_build_cache() {
  local cache_bytes=$1 total=$2 free=$3
  local disk_share disk_gb cache_share cache_gb until_dur should_prune out reclaimed=0
  disk_share=$(disk_setting "${HORNHOOF_DISK_SHARE:-}" 90 10)
  disk_gb=$(disk_setting "${HORNHOOF_DISK_GB:-}" 4096 20)
  cache_share=$(disk_setting "${HORNHOOF_BUILD_CACHE_SHARE:-}" 90 10)
  cache_gb=$(disk_setting "${HORNHOOF_BUILD_CACHE_GB:-}" 4096 10)
  until_dur=${HORNHOOF_BUILD_CACHE_UNTIL:-72h}
  [[ "$until_dur" =~ ^[1-9][0-9]*[hms]$ ]] || until_dur=72h

  # shellcheck disable=SC2016 # the dollars belong to jq
  should_prune=$(jq -nr \
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
      max_of((($total * $dshare) / 100) | round; $dgb * 1073741824) as $dthresh |
      max_of((($total * $cshare) / 100) | round; $cgb * 1073741824) as $climit |
      if ($free < $dthresh) or ($cache > $climit) then "yes" else "no" end
    end
  ' 2> /dev/null || printf 'no')

  if [ "$should_prune" = yes ]; then
    local line
    out=$(docker builder prune -f --filter "until=$until_dur" 2> /dev/null || true)
    line=$(printf '%s\n' "$out" | sed -n 's/^Total reclaimed space:[[:space:]]*//p' | tail -n 1 || true)
    if [ -n "$line" ]; then
      reclaimed=$(printf '%s\n' "$line" | jq -R -r "$DISK_JQ_HELPERS"' to_bytes' 2> /dev/null || true)
    fi
    plain_number "${reclaimed:-}" || reclaimed=0
    if [ "$reclaimed" -gt 0 ]; then
      printf 'Pruned %s bytes of Docker build cache (unused for %s).\n' "$reclaimed" "$until_dur" >&2
    fi
  fi
  printf '%s' "$reclaimed"
}

# Updates the rolling 24-hour cleaned log and prints the resulting cleaned JSON array.
disk_update_cleaned() {
  local state_file=$1 now=$2 stamp=$3 freed_i=$4 freed_c=$5 freed_v=$6 freed_b=$7
  local prev='[]' next tmp
  if [ -f "$state_file" ] && [ ! -L "$state_file" ]; then
    prev=$(jq -c 'if type == "array" then . else [] end' "$state_file" 2> /dev/null || printf '[]')
  fi
  # shellcheck disable=SC2016 # the dollars belong to jq
  next=$(jq -nc \
    --argjson prev "$prev" \
    --argjson now "$now" \
    --arg stamp "$stamp" \
    --argjson freed_img "$freed_i" \
    --argjson freed_ctr "$freed_c" \
    --argjson freed_vol "$freed_v" \
    --argjson freed_bld "$freed_b" \
    --argjson day "$DISK_DAY_S" \
    --argjson cap "$DISK_CLEANED_MAX" \
    "$DISK_JQ_HELPERS"'
    ([
      {part: "images", bytes: $freed_img, at: $stamp},
      {part: "containers", bytes: $freed_ctr, at: $stamp},
      {part: "volumes", bytes: $freed_vol, at: $stamp},
      {part: "buildCache", bytes: $freed_bld, at: $stamp}
    ] | map(select(.bytes > 0))) as $added |
    ($added + $prev)
    | map(select((.at | parse_ts) as $t | $t != null and (($now - $t) <= $day)))
    | .[0:$cap]
  ' 2> /dev/null || printf '[]')
  tmp=$(umask 077 && mktemp "${state_file}.XXXXXX" 2> /dev/null || true)
  if [ -n "$tmp" ]; then
    if ! { printf '%s\n' "$next" > "$tmp" && mv -f "$tmp" "$state_file" 2> /dev/null; }; then
      rm -f "$tmp"
    fi
  fi
  printf '%s' "$next"
}

# Measures Hornhoof's Docker parts after cleaning and copies docker-disk.json into every running Hornhoof node container.
disk_measure_and_deliver() {
  local stamp=$1 cleaned_json=$2
  local images_json containers_json volumes_json vol_sizes_json cache_bytes own_project=''
  local report_json tmpdir tmp cid targets
  images_json=$(disk_inspect_images)
  containers_json=$(disk_inspect_containers)
  volumes_json=$(disk_inspect_volumes)
  vol_sizes_json=$(disk_df_volumes)
  cache_bytes=$(disk_df_build_cache)
  if [ -n "${SERVER_DIR:-}" ]; then own_project=$(compose_project 2> /dev/null || true); fi

  # shellcheck disable=SC2016 # the dollars belong to jq
  report_json=$(jq -nc \
    --arg stamp "$stamp" \
    --argjson images "$images_json" \
    --argjson containers "$containers_json" \
    --argjson volumes "$volumes_json" \
    --argjson vsizes "$vol_sizes_json" \
    --argjson cache "${cache_bytes:-0}" \
    --argjson cleaned "$cleaned_json" \
    --arg app "$IMAGE" \
    --arg node "$NODE_IMAGE" \
    --arg upd "$UPDATER_IMAGE" \
    --arg own_project "$own_project" \
    '
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
  ' 2> /dev/null || true)
  [ -n "$report_json" ] || return 0

  # shellcheck disable=SC2016 # the dollars belong to jq
  targets=$(jq -nr \
    --argjson images "$images_json" \
    --argjson containers "$containers_json" \
    --arg app "$IMAGE" \
    --arg node "$NODE_IMAGE" \
    --arg upd "$UPDATER_IMAGE" \
    --arg own_project "$own_project" \
    '
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
  ' 2> /dev/null | sort -u || true)
  [ -n "$targets" ] || return 0

  tmpdir=$(umask 077 && mktemp -d 2> /dev/null || true)
  [ -n "$tmpdir" ] || return 0
  tmp=$tmpdir/docker-disk.json
  printf '%s\n' "$report_json" > "$tmp"
  chmod 644 "$tmp" 2> /dev/null || true
  while IFS= read -r cid; do
    [ -n "$cid" ] || continue
    disk_safe_ref "$cid" || continue
    docker cp "$tmp" "$cid:/data/" > /dev/null 2>&1 || true
  done <<< "$targets"
  rm -f "$tmp" && rmdir "$tmpdir" 2> /dev/null || true
}

# One paced pass of Docker disk care. Runs at most once per HORNHOOF_DISK_EVERY seconds (default 1 hour) and skips while an
# update or worker node catch-up is active.
disk_care() {
  local every now stamp lab_age state_file images_json containers_json volumes_json vol_sizes_json
  local cache_bytes total=0 free=0 freed_i=0 freed_c=0 freed_v=0 freed_b=0 lab_res cleaned_json
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
  elif [ -n "${CONTROL:-}" ] && [ -d "$CONTROL" ] && [ -w "$CONTROL" ]; then
    state_file=$CONTROL/disk-cleaned.json
  else
    state_file=${TMPDIR:-/tmp}/hornhoof-disk-cleaned.json
  fi

  images_json=$(disk_inspect_images)
  containers_json=$(disk_inspect_containers)
  volumes_json=$(disk_inspect_volumes)
  vol_sizes_json=$(disk_df_volumes)
  cache_bytes=$(disk_df_build_cache)
  read -r total free <<< "$(disk_fs_space || printf '0 0')"
  plain_number "${total:-}" || total=0
  plain_number "${free:-}" || free=0

  freed_i=$(disk_clean_images "$images_json" "$containers_json")
  plain_number "${freed_i:-}" || freed_i=0
  lab_res=$(disk_clean_labs "$containers_json" "$volumes_json" "$vol_sizes_json" "$now" "$lab_age")
  read -r freed_c freed_v <<< "${lab_res:-0 0}"
  plain_number "${freed_c:-}" || freed_c=0
  plain_number "${freed_v:-}" || freed_v=0
  freed_b=$(disk_clean_build_cache "$cache_bytes" "$total" "$free")
  plain_number "${freed_b:-}" || freed_b=0

  cleaned_json=$(disk_update_cleaned "$state_file" "$now" "$stamp" "$freed_i" "$freed_c" "$freed_v" "$freed_b")
  disk_measure_and_deliver "$stamp" "$cleaned_json"
}
