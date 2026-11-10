# Writes one private file, atomically. Sourced by setup-relay.sh.
# Usage: write_private <dest> <mode> [group]   (content on stdin)
# The destination ends with <mode> (and <group> when given); the content is replaced only
# when it changed, and an unchanged destination still gets its group and mode fixed in
# place (its inode is kept). Prints "changed" or "unchanged". Every step is checked: any
# failure returns non-zero and never prints "changed". The body runs in a subshell, so the
# caller's variables (dest, mode, group, tmp) are left alone.
write_private() (
  dest=$1
  mode=$2
  group=${3:-}
  tmp=$dest.new
  rm -f "$tmp" || return 1
  # The temp file is created already private, so a secret is never readable by others,
  # not even for a moment while the content arrives.
  ( umask 077 && : > "$tmp" ) || return 1
  cat > "$tmp" || { rm -f "$tmp"; return 1; }
  if [ -n "$group" ]; then
    chgrp "$group" "$tmp" || { rm -f "$tmp"; return 1; }
  fi
  chmod "$mode" "$tmp" || { rm -f "$tmp"; return 1; }
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp" || return 1
    if [ -n "$group" ]; then
      chgrp "$group" "$dest" || return 1
    fi
    chmod "$mode" "$dest" || return 1
    echo unchanged
  elif mv -f "$tmp" "$dest"; then
    echo changed
  else
    rm -f "$tmp"
    return 1
  fi
)
