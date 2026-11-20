# shellcheck shell=bash
# The folders this updater shares with the app and the keeper: the control folder, the computer volume and the folders
# the keeper reads in them. Both run as UID 1000 and can put a link or a named pipe in the place of any file there at any
# moment. The updater runs as root, so it never opens a file of theirs by its name: through a link it would write over,
# or read out, a file only root may touch, such as the install's .env, and a pipe nobody writes would stop it for good.
# It writes a file in a private folder and renames it into place, and reads one by a second name it gives it there.

# The directory the shell is really in, asked of the system. Bash sets PWD from the path it resolved before it entered,
# so a link swapped in between would go unseen there, and its own pwd -P reads that same path again.
physical_dir() {
  env pwd -P 2> /dev/null
}

# enter_shared <folder>: into the control folder or the computer volume, which the updater's own settings name, or a
# folder below one of them by what it really is: no link may stand in for it.
enter_shared() {
  local dir="${1%/}" name here
  case "$dir" in
    "${CONTROL%/}" | "${COMPUTER_CONTROL%/}") cd -P -- "$dir" 2> /dev/null || return 1 ;;
    "${CONTROL%/}"/?* | "${COMPUTER_CONTROL%/}"/?*)
      name=${dir##*/}
      case "$name" in . | ..) return 1 ;; esac
      enter_shared "${dir%/*}" && here=$(physical_dir) || return 1
      [ ! -L "./$name" ] && cd -P -- "./$name" 2> /dev/null && [ "$(physical_dir)" = "${here%/}/$name" ]
      ;;
    *) return 1 ;;
  esac
}

# entered <folder>: enter_shared, which says so when something other than a folder stands at that place.
entered() {
  enter_shared "$1" && return 0
  if [ -L "$1" ] || { [ -e "$1" ] && [ ! -d "$1" ]; }; then printf 'Refused %s: it is not a plain folder.\n' "${1##*/}" >&2; fi
  return 1
}

# Enter only a staging directory at the expected path, owned by this updater and private.
enter_stage() {
  local mode
  cd -P -- "./$2" && [ "$(physical_dir)" = "${1%/}/$2" ] && [ -O . ] || return 1
  mode=$(stat -c '%a' . 2> /dev/null || stat -f '%Lp' . 2> /dev/null) && [ "$mode" = 700 ]
}

# move_over <file> <name>: rename a file over a name in the same folder, replacing a link there instead of following it.
move_over() {
  if [[ "$OSTYPE" == darwin* ]]; then
    mv -fh -- "$1" "$2"
  else
    mv -fT -- "$1" "$2"
  fi
}

# put_in_place <name> <kind> <how> <writer> [args], in the folder the shell entered: what the writer prints is written in
# a private folder made there and then renamed onto the name. The updater never opens the name to write it, so a link or
# a pipe in its place can neither redirect the write nor stop it. how: once fails when anything is at the name already;
# over replaces whatever file, link or pipe is there; keeper does too, with a file of mode 600 that is the keeper's
# alone, as owned makes it. A writer that fails leaves the name as it was, and this fails with the writer's code.
put_in_place() (
  local file="$1" kind="$2" how="$3" here temporary target status=0
  shift 3
  if [ "$how" = once ]; then [ ! -L "$file" ] && [ ! -e "$file" ] || exit 1; fi
  target="../$file"
  if [[ "$OSTYPE" == linux* ]]; then
    # Keep the destination in the entered directory even if the private folder is moved.
    exec 9< . || exit 1
    target="/proc/self/fd/9/$file"
  fi
  here=$(physical_dir) && temporary=$(mktemp -d ".$kind.XXXXXXXX") || exit 1
  (
    enter_stage "$here" "$temporary" || exit 1
    trap 'rm -f -- "./${kind:?}"' EXIT
    if [ "$how" = keeper ]; then umask 077; else umask 022; fi
    set -o noclobber
    "$@" > "./$kind" || exit
    if [ "$how" = keeper ]; then owned "./$kind" 600 || exit 1; fi
    if [ "$how" = once ]; then [ ! -L "$target" ] && [ ! -e "$target" ] || exit 1; fi
    move_over "./$kind" "$target"
  ) || status=$?
  rmdir -- "./${temporary:?}" 2> /dev/null || true
  exit "$status"
)

# publish <path> <how> <writer> [args]: put_in_place for a file of a shared folder, named by its path. The private
# folder and the file in it are named after the file.
publish() (
  entered "${1%/*}" || exit 1
  put_in_place "${1##*/}" "${1##*/}" "$2" "${@:3}"
)

# hard_link <file> <name>: a second name for a file. For a link it is a second name of the link itself, never of what it
# points to, which macOS has to be told.
hard_link() {
  if [[ "$OSTYPE" == darwin* ]]; then
    ln -P -- "$1" "$2"
  else
    ln -- "$1" "$2"
  fi
}

# facts <path>: the inode, the number of names, the permissions and the owner of what is at the path itself, a link not
# followed.
facts() {
  stat -c '%i %h %a %u' -- "$1" 2> /dev/null || stat -f '%i %l %Lp %u' -- "$1" 2> /dev/null
}

refuse_file() {
  printf 'Refused %s: it is not a plain file.\n' "${1##*/}" >&2
  return 1
}

# take_here <name> [command [args]], in the folder the shell entered: the command, cat by default, reads that file on its
# standard input. The file first gets a second name in a private folder made beside it, on the same file system, which
# opens nothing. It is read by that name only when that is what was at the name: a regular file, the same one, with one
# name more than it had, and root's or the folder owner's. Anything else, or a second name that cannot be made, is
# refused with a diagnostic. A missing name fails quietly.
take_here() (
  local file="$1" here source owner before after temporary status=0
  shift
  [ "$#" -gt 0 ] || set -- cat
  [ -L "$file" ] || [ -e "$file" ] || exit 1
  here=$(physical_dir) && owner=$(facts .) || { refuse_file "$file"; exit 1; }
  source="${here%/}/$file"
  if [[ "$OSTYPE" == linux* ]]; then
    exec 9< . || { refuse_file "$file"; exit 1; }
    source="/proc/self/fd/9/$file"
  fi
  temporary=$(mktemp -d .take.XXXXXXXX) || { refuse_file "$file"; exit 1; }
  (
    enter_stage "$here" "$temporary" || { refuse_file "$file"; exit 1; }
    trap 'rm -f -- ./taken' EXIT
    if ! before=$(facts "$source") || ! hard_link "$source" ./taken 2> /dev/null || [ -L ./taken ] || [ ! -f ./taken ] ||
      ! after=$(facts ./taken) || [ "${after%% *}" != "${before%% *}" ] || ! same_file "$before" "$after" "${owner##* }" ||
      { [ -n "${TAKE_ALONE:-}" ] && ! alone "$before" "${owner##* }"; }; then
      refuse_file "$file"
      exit 1
    fi
    "$@" < ./taken
  ) || status=$?
  rmdir -- "./${temporary:?}" 2> /dev/null || true
  exit "$status"
)

# hardlinks_protected: Linux lets a user give a second name only to a file that user owns or may read and write
# (fs.protected_hardlinks=1, as systemd sets it; the kernel's own default is 0).
hardlinks_protected() {
  local protected
  read -r protected 2> /dev/null < /proc/sys/fs/protected_hardlinks && [ "$protected" = 1 ]
}

# same_file <facts before> <facts after> <folder owner>: the second name is of the file that was looked at, which has
# one name more now, and is root's or the folder owner's. A file of root's on Linux had that one name only, so no alias
# of another is read. Where anyone may link any file, it is taken only when everyone may read it anyway, as what root
# publishes in a shared folder: one only root may read could be another of root's files under the name.
same_file() {
  local links=${1#* } now=${2#* } mode owner=${2##* }
  links=${links%% *}
  mode=${now#* }
  mode=${mode%% *}
  now=${now%% *}
  [ "$now" = "$((links + 1))" ] || return 1
  if [ "$owner" = 0 ] && [[ "$OSTYPE" == linux* ]]; then
    [ "$links" = 1 ] || return 1
    hardlinks_protected || case "$mode" in *[4567]) ;; *) return 1 ;; esac
  else
    [ "$owner" = 0 ] || [ "$owner" = "$3" ]
  fi
}

# take <path> [command [args]]: take_here for a file of a shared folder, named by its path.
take() (
  entered "${1%/*}" || exit 1
  take_here "${1##*/}" "${@:2}"
)

# alone <facts> <folder owner>: a file with no other name, the folder owner's, as the keeper writes one.
alone() {
  local links=${1#* }
  [ "${links%% *}" = 1 ] && [ "${1##* }" = "$2" ]
}

# take_alone <path> [command [args]]: take, only for a file alone at its name, so it is no other file of the folder
# owner's and no second name of it was made to change it by.
take_alone() (
  TAKE_ALONE=1
  take "$@"
)

# quiet <command> [args]: a command, with nothing said of what it cannot read, as for what take gives it: a file it
# cannot read gives nothing. What take refuses is still said.
quiet() {
  "$@" 2> /dev/null
}

# installer_control <folder>: the one file of the control folder an installer that this updater runs reads, the machine's
# addresses, taken into a folder of the updater's own, which the installer is given as its control folder.
installer_control() {
  mkdir -p -- "$1" && rm -f -- "$1/addresses.json" || return 1
  take "$CONTROL/addresses.json" > "$1/addresses.json" || rm -f -- "$1/addresses.json"
}

# keeper_dir <folder>: give the keeper ownership only of a directory created inside private staging.
# A folder already at the shared name must already belong to the keeper.
keeper_dir() (
  local name="${1##*/}" here temporary target owner actual
  entered "${1%/*}" || exit 1
  owner=$(facts "$CONTROL") || exit 1
  if [ ! -L "./$name" ] && [ ! -e "./$name" ]; then
    here=$(physical_dir) && temporary=$(mktemp -d .keeper.XXXXXXXX) || exit 1
    target="${here%/}/$name"
    if [[ "$OSTYPE" == linux* ]]; then
      exec 9< . || exit 1
      target="/proc/self/fd/9/$name"
    fi
    (
      enter_stage "$here" "$temporary" || exit 1
      trap 'rmdir -- ./keeper 2> /dev/null || true' EXIT
      mkdir -- ./keeper && owned ./keeper 700 &&
        { [ -e "$target" ] || [ -L "$target" ] || move_over ./keeper "$target"; }
    ) || true
    rmdir -- "./${temporary:?}" 2> /dev/null || true
  fi
  entered "$1" && actual=$(facts .) || exit 1
  if [ "${actual##* }" != "${owner##* }" ]; then
    printf 'Refused %s: it is not a keeper folder.\n' "$name" >&2
    exit 1
  fi
  chmod 700 .
)

# remove_in <folder> <name>...: files of a shared folder go. A link goes itself, never what it points to, and a folder
# stays.
remove_in() (
  entered "$1" || exit 0
  shift
  local name
  for name in "$@"; do rm -f -- "./${name:?}" 2> /dev/null || true; done
)

# device <path>: the file system what is at the path is on.
device() {
  stat -c '%d' -- "$1" 2> /dev/null || stat -f '%d' -- "$1" 2> /dev/null
}

# clear_here [depth]: empties the folder the shell entered by what it really is. A folder in it is entered the same way,
# by what it really is and only on the same file system, emptied in a shell of its own, and removed; anything else goes
# itself, a link too, never what it points to. Nothing is ever deleted by a path that leads through a folder, so a folder
# swapped for a link meanwhile, even by a process that holds it open, is never followed: the link stays, as does a folder
# that is no longer what it was. All else goes, and this fails when anything stayed. A tree more than 16 folders deep is
# left whole below that, as none of the updater's own is.
clear_here() {
  local depth=${1:-0} here dev item status=0
  [ "$depth" -lt 16 ] || return 1
  here=$(physical_dir) && dev=$(device .) || return 1
  for item in ./* ./.[!.]* ./..?*; do
    [ -L "$item" ] || [ -e "$item" ] || continue
    if [ ! -L "$item" ] && [ -d "$item" ]; then
      (cd -P -- "$item" 2> /dev/null && [ "$(physical_dir)" = "${here%/}/${item#./}" ] && [ "$(device .)" = "$dev" ] && clear_here "$((depth + 1))") &&
        rmdir -- "$item" 2> /dev/null || status=1
    else
      rm -f -- "$item" 2> /dev/null || status=1
    fi
  done
  return "$status"
}

# remove_folders <name>...: folders of the control folder go with everything in them, as a wipe removes them. Each is
# first renamed, which follows no link, into a private folder of the updater's own made beside it, where the app and the
# keeper cannot reach it by its path, and is emptied there by clear_here; a link at the name goes the same way, itself.
# A private folder an earlier pass could not empty is emptied too. Fails when anything stayed, so the wipe tries again.
remove_folders() (
  local name here private target status=0
  entered "$CONTROL" && here=$(physical_dir) || exit 1
  if [[ "$OSTYPE" == linux* ]]; then exec 9< . || exit 1; fi
  for name in "$@"; do
    [ -L "./$name" ] || [ -e "./$name" ] || continue
    private=$(mktemp -d .remove.XXXXXXXX) || { status=1; continue; }
    target="../$name"
    # Keep the source in the entered folder even if the private folder is moved.
    if [[ "$OSTYPE" == linux* ]]; then target="/proc/self/fd/9/$name"; fi
    (enter_stage "$here" "$private" && move_over "$target" ./gone) || status=1
  done
  for private in ./.remove.*; do
    [ ! -L "$private" ] && [ -d "$private" ] && [ -O "$private" ] || continue
    (enter_stage "$here" "${private#./}" && clear_here) && rmdir -- "$private" 2> /dev/null || status=1
  done
  exit "$status"
)
