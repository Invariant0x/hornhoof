#!/bin/sh
# SHA-512 values from v2.11.8's caddy_2.11.8_checksums.txt release asset.
set -eu
cd "$(dirname "$0")"
bin_dir="$(pwd)/.bin"
if [ -x "$bin_dir/caddy" ]; then exit 0; fi

case "$(uname -s)" in
  Darwin) caddy_os=mac ;;
  Linux) caddy_os=linux ;;
  *) echo 'Caddy tests support macOS and Linux only' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) caddy_arch=amd64 ;;
  arm64 | aarch64) caddy_arch=arm64 ;;
  *) echo 'Caddy tests support amd64 and arm64 only' >&2; exit 1 ;;
esac
case "$caddy_os-$caddy_arch" in
  mac-amd64) checksum=946399a20f1c10d82ab593680ab975879c49af6741d8be20a30199469a762c802a112183ee2c40ae78980bdbbbf3b335461ad0aa12d9780ff1634e9a41361872 ;;
  mac-arm64) checksum=0c6992b1bb40629b6090d72cdc4a3f3722a7f6b667606db9fe67bfea0e42e9c40736d10925d406bf103628a5e906e59300d616a0709bc8855d9e85efbcfece81 ;;
  linux-amd64) checksum=c863699eee84c6b410573de2ec67af81d07eb054f9020bb98f3c6cb256fea4be2fd1acfbd39110c649c3338282593bba3d3ed6424d91b7f5675e8b877a8999e9 ;;
  linux-arm64) checksum=6a285426268c8f987e0c459f61dc5af3c25e663955c0e4dddc6e187722b7cdd15e4233ff0e570a4ee17b3c68d59e2a61ce96d2f6be55ea58eead6a334859557c ;;
esac

mkdir -p "$bin_dir"
download_dir=$(mktemp -d "$bin_dir/download.XXXXXX")
trap 'rm -rf "$download_dir"' 0
trap 'exit 1' 1 2 15
version=2.11.8
curl -fsSL --retry 2 --connect-timeout 15 --max-time 120 \
  -o "$download_dir/caddy.tgz" \
  "https://github.com/caddyserver/caddy/releases/download/v$version/caddy_${version}_${caddy_os}_${caddy_arch}.tar.gz"
if command -v sha512sum > /dev/null 2>&1; then
  printf '%s  %s\n' "$checksum" "$download_dir/caddy.tgz" | sha512sum -c -
else
  printf '%s  %s\n' "$checksum" "$download_dir/caddy.tgz" | shasum -a 512 -c -
fi
tar -xzf "$download_dir/caddy.tgz" -C "$download_dir" caddy
install -m 755 "$download_dir/caddy" "$bin_dir/caddy"
