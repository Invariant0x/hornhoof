#!/bin/sh
# SHA-256 values from v0.71.1's frp_sha256_checksums.txt release asset.
set -eu
cd "$(dirname "$0")"
bin_dir="$(pwd)/.bin"
if [ -x "$bin_dir/frps" ] && [ -x "$bin_dir/frpc" ]; then exit 0; fi

case "$(uname -s)" in
  Darwin) frp_os=darwin ;;
  Linux) frp_os=linux ;;
  *) echo 'frp tests support macOS and Linux only' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) frp_arch=amd64 ;;
  arm64 | aarch64) frp_arch=arm64 ;;
  *) echo 'frp tests support amd64 and arm64 only' >&2; exit 1 ;;
esac
case "$frp_os-$frp_arch" in
  darwin-amd64) checksum=8acb59b6fb998cc8d209d1373d90bf70fa5ec3efeb4dfbc7bda6ce3abd78cb45 ;;
  darwin-arm64) checksum=d15d0324b99e14619c9aa46e37f6db588c06a09be4bc6f7948890b6b61077842 ;;
  linux-amd64) checksum=1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803 ;;
  linux-arm64) checksum=8edf590b0c396fa42f9c147121a76af83cfc2002b08f5aef0ea1008c43482019 ;;
esac

mkdir -p "$bin_dir"
download_dir=$(mktemp -d "$bin_dir/download.XXXXXX")
trap 'rm -rf "$download_dir"' 0
trap 'exit 1' 1 2 15
archive="frp_0.71.1_${frp_os}_${frp_arch}"
curl -fsSL --retry 2 --connect-timeout 15 --max-time 120 \
  -o "$download_dir/frp.tgz" \
  "https://github.com/fatedier/frp/releases/download/v0.71.1/$archive.tar.gz"
if command -v sha256sum > /dev/null 2>&1; then
  printf '%s  %s\n' "$checksum" "$download_dir/frp.tgz" | sha256sum -c -
else
  printf '%s  %s\n' "$checksum" "$download_dir/frp.tgz" | shasum -a 256 -c -
fi
tar -xzf "$download_dir/frp.tgz" -C "$download_dir" "$archive/frps" "$archive/frpc"
install -m 755 "$download_dir/$archive/frps" "$bin_dir/frps"
install -m 755 "$download_dir/$archive/frpc" "$bin_dir/frpc"
