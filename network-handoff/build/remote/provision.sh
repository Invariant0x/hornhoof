#!/bin/bash
# Turns a container of the Dockerfile's base image into hnb-build:1. host.sh commits the result. Runs as root inside that
# container, with the base's hornhoof and network-build mounted read-only at the same paths as on the build machine.
set -euo pipefail

ROOT=/home/altera/hornhoof-network
HOME_DIR=/home/altera
DOCKERFILE=$ROOT/hornhoof/apps/node/Dockerfile
UV_VERSION=0.12.6
UV_SHA256=8681d8921e7d520fb368991dcf5f9c1905b80f5bf2a265a0ed085c8d8e342477
PY312=$HOME_DIR/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12
PY314=$ROOT/quality/python/cpython-3.14-linux-x86_64-gnu/bin/python3.14

from_dockerfile() { sed -n "s/^ARG $1=//p" "$DOCKERFILE"; }

install_system_tools() {
  apt-get update
  apt-get install -y --no-install-recommends git ca-certificates curl ripgrep jq file tmux procps python3 python3-venv \
    python-is-python3 patch openssl rsync
  rm -rf /var/lib/apt/lists/*
}

# The version and checksum are the Dockerfile's, so both images carry the same tool.
install_shellcheck() {
  local version sha
  version=$(from_dockerfile SHELLCHECK_VERSION)
  sha=$(from_dockerfile SHELLCHECK_AMD64_SHA256)
  curl -fsSL "https://github.com/koalaman/shellcheck/releases/download/v$version/shellcheck-v$version.linux.x86_64.tar.gz" -o /tmp/shellcheck.tar.gz
  echo "$sha  /tmp/shellcheck.tar.gz" | sha256sum -c -
  tar -xzf /tmp/shellcheck.tar.gz --no-same-owner -C /usr/local/bin --strip-components=1 "shellcheck-v$version/shellcheck"
  rm -f /tmp/shellcheck.tar.gz
  shellcheck --version
}

# From the official dind image, pulled by digest by host.sh: same version as the inner Docker, compose and buildx with it.
install_docker_cli() {
  tar -xf /ctx/docker-cli.tar --no-same-owner -C /
  docker --version
  docker compose version
  docker buildx version
}

# Not recursive: the trees mounted read-only under $ROOT are not this image's and cannot be changed.
prepare_home() {
  mkdir -p "$HOME_DIR/.local/bin" "$ROOT"
  chown 1000:1000 "$HOME_DIR" "$HOME_DIR/.local" "$HOME_DIR/.local/bin" "$ROOT"
}

install_uv() {
  curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/uv.tar.gz
  echo "$UV_SHA256  /tmp/uv.tar.gz" | sha256sum -c -
  tar -xzf /tmp/uv.tar.gz --no-same-owner --strip-components=1 -C "$HOME_DIR/.local/bin"
  rm -f /tmp/uv.tar.gz
  chown -R 1000:1000 "$HOME_DIR/.local"
}

as_builder() {
  setpriv --reuid=1000 --regid=1000 --clear-groups env HOME="$HOME_DIR" "PATH=$HOME_DIR/.local/bin:$PATH" "$@"
}

build_quality_tools() {
  as_builder sh "$ROOT/network-build/setup-quality.sh"
  as_builder rm -rf "$ROOT/quality/uv-cache" "$HOME_DIR/.cache"
}

check_the_image() {
  node --version
  as_builder "$PY312" --version
  as_builder "$PY314" --version
  as_builder "$ROOT/quality/py312/bin/python" -c 'import coverage; print("coverage", coverage.__version__)'
  as_builder "$ROOT/quality/bin/crapper" --help > /dev/null
  as_builder "$ROOT/quality/bin/dryer" --help > /dev/null
  as_builder "$ROOT/quality/bin/mutator" --help > /dev/null
  as_builder touch "$HOME_DIR/.write-check"
  as_builder rm "$HOME_DIR/.write-check"
}

install_system_tools
install_shellcheck
install_docker_cli
prepare_home
install_uv
build_quality_tools
check_the_image
echo "provision: done"
