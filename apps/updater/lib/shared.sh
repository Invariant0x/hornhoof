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
    cd -P -- "./$temporary" && [ "$(physical_dir)" = "${here%/}/$temporary" ] && [ -O . ] || exit 1
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

# facts <path>: the inode, the number of names and the owner of what is at the path itself, a link not followed.
facts() {
  stat -c '%i %h %u' -- "$1" 2> /dev/null || stat -f '%i %l %u' -- "$1" 2> /dev/null
}

# take_here <name> [command [args]], in the folder the shell entered: the command, cat by default, reads that file on its
# standard input. The file first gets a second name in a private folder made beside it, on the same file system, which
# opens nothing. It is read by that name only when that is what was at the name: a regular file, the same one, with one
# name more than it had, and root's or the folder owner's. Anything else, or a second name that cannot be made, is
# refused, and that is said. Nothing at the name fails quietly. The kernel lets a user give a file a second name only
# when it may read and write it (fs.protected_hardlinks), so the app and the keeper cannot bring a file of root's here.
take_here() (
  local file="$1" here owner before after temporary status=0
  shift
  [ "$#" -gt 0 ] || set -- cat
  [ -L "$file" ] || [ -e "$file" ] || exit 1
  here=$(physical_dir) && owner=$(facts .) && owner=${owner##* } && temporary=$(mktemp -d .take.XXXXXXXX) || exit 1
  (
    cd -P -- "./$temporary" && [ "$(physical_dir)" = "${here%/}/$temporary" ] && [ -O . ] || exit 1
    trap 'rm -f -- ./taken' EXIT
    if ! before=$(facts "../$file") || ! hard_link "../$file" ./taken 2> /dev/null || [ -L ./taken ] || [ ! -f ./taken ] ||
      ! after=$(facts ./taken) || [ "${after%% *}" != "${before%% *}" ] || ! same_file "$before" "$after" "$owner"; then
      if [ -L "../$file" ] || [ -e "../$file" ]; then printf 'Refused %s: it is not a plain file.\n' "${file##*/}" >&2; fi
      exit 1
    fi
    "$@" < ./taken
  ) || status=$?
  rmdir -- "./${temporary:?}" 2> /dev/null || true
  exit "$status"
)

# same_file <facts before> <facts after> <folder owner>: the second name is of the file that was looked at, which has
# one name more now, and is root's or the folder owner's.
same_file() {
  local links=${1#* } now=${2#* }
  links=${links%% *}
  now=${now%% *}
  [ "$now" = "$((links + 1))" ] && { [ "${2##* }" = 0 ] || [ "${2##* }" = "$3" ]; }
}

# take <path> [command [args]]: take_here for a file of a shared folder, named by its path.
take() (
  entered "${1%/*}" || exit 1
  take_here "${1##*/}" "${@:2}"
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

# keeper_dir <folder>: a folder of a shared folder for the keeper alone, made when it is missing: mode 700, and the
# keeper's. Its mode and owner change only once it is entered, so a link in its place changes nothing it points to.
keeper_dir() (
  entered "${1%/*}" || exit 1
  [ -L "./${1##*/}" ] || [ -e "./${1##*/}" ] || mkdir -- "./${1##*/}" 2> /dev/null || true
  entered "$1" && owned . 700
)

# remove_in <folder> <name>...: files of a shared folder go. A link goes itself, never what it points to, and a folder
# stays.
remove_in() (
  entered "$1" || exit 0
  shift
  local name
  for name in "$@"; do rm -f -- "./${name:?}" 2> /dev/null || true; done
)
