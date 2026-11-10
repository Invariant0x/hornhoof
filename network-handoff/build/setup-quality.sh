#!/bin/sh
# Builds Uncle Bob's quality tools into quality/, the way hornhoof/apps/node/Dockerfile's quality stage builds them.
# Everything, the Python and the caches too, stays inside ~/hornhoof-network.
set -eu
ROOT=/home/altera/hornhoof-network
Q=$ROOT/quality
SRC=$ROOT/hornhoof/apps/node/quality
CRAPPER_COMMIT=$(sed -n 's/^ARG CRAPPER_COMMIT=//p' "$ROOT/hornhoof/apps/node/Dockerfile")
DRYER_COMMIT=$(sed -n 's/^ARG DRYER_COMMIT=//p' "$ROOT/hornhoof/apps/node/Dockerfile")
MUTATOR_COMMIT=$(sed -n 's/^ARG MUTATOR_COMMIT=//p' "$ROOT/hornhoof/apps/node/Dockerfile")
TREE_SITTER="tree-sitter==0.26.0 tree-sitter-language-pack==1.22.1"
PY312=/home/altera/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12
export UV_CACHE_DIR="$Q/uv-cache" UV_PYTHON_INSTALL_DIR="$Q/python" UV_PYTHON_BIN_DIR="$Q/python/bin"
export TREE_SITTER_LANGUAGE_PACK_CACHE_DIR="$Q/grammars" PIP_NO_CACHE_DIR=1
ub=$Q/ub
mkdir -p "$ub" "$Q/bin" "$Q/grammars"
# a-host has this Python from uv already. The image on home-api starts without it, and gets the same version at the same path.
[ -x "$PY312" ] || UV_PYTHON_INSTALL_DIR=/home/altera/.local/share/uv/python uv python install --no-bin 3.12.14
fetch() { mkdir -p "$2"; curl -fsSL "https://codeload.github.com/$1/tar.gz/$3" | tar -xz --strip-components=1 -C "$2"; }
fetch unclebob/crapper "$ub/crapper" "$CRAPPER_COMMIT"
fetch unclebob/dryer "$ub/dryer" "$DRYER_COMMIT"
fetch unclebob/mutator "$ub/mutator" "$MUTATOR_COMMIT"
patch --forward --directory="$ub/mutator" --strip=1 < "$SRC/mutator-worker-modules.patch"
for tool in crapper dryer mutator; do
  uv venv --quiet --seed --python "$PY312" "$ub/$tool/.venv"
  extra=""; [ "$tool" = mutator ] && extra="$ub/crapper"
  # shellcheck disable=SC2086
  "$ub/$tool/.venv/bin/pip" install --quiet --no-cache-dir $TREE_SITTER $extra "$ub/$tool"
  printf '#!/bin/sh\nTREE_SITTER_LANGUAGE_PACK_CACHE_DIR=%s\nexport TREE_SITTER_LANGUAGE_PACK_CACHE_DIR\nexec %s "$@"\n' "$Q/grammars" "$ub/$tool/$tool" > "$Q/bin/$tool"
  chmod 755 "$Q/bin/$tool"
  "$Q/bin/$tool" --help > /dev/null
  echo "ok: $tool"
done
"$ub/mutator/.venv/bin/python" "$SRC/test_mutator_workers.py"
"$ub/crapper/.venv/bin/python" -c "import tree_sitter_language_pack as p; p.download(['clojure', 'go', 'java', 'javascript', 'python', 'rust', 'tsx', 'typescript'])"
echo "ok: grammars"
uv python install --no-bin 3.14 2>&1 | tail -1 || true
[ -x "$Q/py312/bin/python" ] || uv venv --quiet --seed --python "$PY312" "$Q/py312"
"$Q/py312/bin/pip" install --quiet --no-cache-dir coverage==7.17.1
echo "ok: py312"
ls "$Q/python"
