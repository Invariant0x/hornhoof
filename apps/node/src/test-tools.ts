import type { Command } from '@hornhoof/protocol';

/* The tools of a language as part of a product's harness. A product gets them when its repository names that language, once
   per architecture, and no other product does, so the machines' image holds no compiler a company does not use. Each comes from
   where it is published, and what comes is checked against the digest published beside it. PHP's builds alone have none, and come
   by TLS only. */
export const TOOLS = '.hornhoof/tools';
export const TOOL_ORDER = ['c', 'go', 'rust', 'java', 'maven', 'gradle', 'php', 'ruby'] as const;
export type ToolId = typeof TOOL_ORDER[number];
export type Tool = { id: ToolId; install: Command[]; paths: string[]; inputs?: string[]; env?: Record<string, string>; bin: string[] };
/* What a repository asks of a tool. ownFile: the projects that say their version in a file of their own, which the tool obeys
   there. noDefault: all that use it do, and nobody chose a version, so no other is needed. */
export type ToolAsk = { version: string | undefined; packages: string[]; ownFile: { root: string; path: string }[]; noDefault: boolean };

const at = (program: string, ...args: string[]): Command => ({ program, args, cwd: '.' });
const script = (text: string, ...args: string[]): Command => at('sh', '-c', `set -eu\n${text}`, 'sh', ...args);
const noBuild = (tool: string) => `*) echo "${tool} has no build for $(uname -m)." >&2; exit 1 ;;`;

/* Debian's own signed packages, unpacked where they can be moved, with no need to be root. */
const C_PATH = `${TOOLS}/c`;
const C_PACKAGES = ['gcc', 'g++', 'make', 'libc6-dev'];
const C_WRAPPER = String.raw`#!/bin/sh
here="$(dirname "$(dirname "$(readlink -f "$0")")")"; triple="$(uname -m)-linux-gnu"; name="$(basename "$0")"
[ "$name" = make ] && exec "$here/root/usr/bin/make" "$@"
export LD_LIBRARY_PATH="$here/root/usr/lib/$triple$` + '{LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"' + String.raw`
case "$name" in
  cc|gcc) PATH="$here/root/usr/bin:$PATH" exec "$here/root/usr/bin/$triple-gcc" --sysroot="$here/root" "$@" ;;
  c++|g++) PATH="$here/root/usr/bin:$PATH" exec "$here/root/usr/bin/$triple-g++" --sysroot="$here/root" "$@" ;;
  *) exec "$here/root/usr/bin/$name" "$@" ;;
esac`;
const C_INSTALL = String.raw`root="$PWD/$1"; shift
work="$TMPDIR/apt"; mkdir -p "$work/lists/partial" "$work/cache/archives/partial" "$work/debs" "$root/root" "$root/bin"
fetch() { apt-get -q -o Dir::State::lists="$work/lists" -o Dir::Cache="$work/cache" -o Dir::State::status=/dev/null -o Debug::NoLocking=1 -o APT::Sandbox::User="$(id -un)" "$@"; }
fetch update
names="$(fetch install --print-uris -y --no-install-recommends "$@" | sed -n "s/^'[^']*' \([^_]*\)_.*/\1/p")"
(cd "$work/debs" && fetch download $names)
for deb in "$work"/debs/*.deb; do dpkg-deb -x "$deb" "$root/root"; done
rm -rf "$root/root/usr/share/doc" "$root/root/usr/share/man" "$root/root/usr/share/locale" "$work"
cd "$root/root"
find . -type l -lname '/*' | while read -r link; do
  target="$(readlink "$link")"
  if [ -e ".$target" ]; then ln -sfn "$(realpath --relative-to="$(dirname "$link")" ".$target")" "$link"; else rm -f "$link"; fi
done
ln -s "root/usr/lib/$(uname -m)-linux-gnu" "$root/lib"
cat > "$root/bin/cc" <<'WRAPPER'
${C_WRAPPER}
WRAPPER
chmod +x "$root/bin/cc"
for name in gcc c++ g++ make ar as ld nm ranlib strip objcopy objdump; do cp "$root/bin/cc" "$root/bin/$name"; done`;
const cTool = (_version: string, ask: ToolAsk): Tool => ({
  id: 'c', install: [script(C_INSTALL, C_PATH, ...new Set([...C_PACKAGES, ...ask.packages]))],
  paths: [C_PATH], bin: [`${C_PATH}/bin`],
  /* What it holds of what a program links against, for a language that runs on those libraries. */
  ...(ask.packages.length ? { env: { LD_LIBRARY_PATH: `${C_PATH}/lib` } } : {}),
});

const GO_PATH = `${TOOLS}/go`, GO_ENV = `${TOOLS}/go.env`;
const GO_INSTALL = `case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; ${noBuild('Go')} esac
file="go$1.linux-$arch.tar.gz"
curl -fsSL "https://go.dev/dl/$file" -o "$TMPDIR/$file"
echo "$(curl -fsSL "https://dl.google.com/go/$file.sha256")  $TMPDIR/$file" | sha256sum -c -
mkdir -p "$2"
tar -xzf "$TMPDIR/$file" -C "$2" --strip-components=1
rm -f "$TMPDIR/$file"`;
const goTool = (version: string): Tool => ({
  id: 'go', paths: [GO_PATH, GO_ENV], env: { GOENV: GO_ENV }, bin: [`${GO_PATH}/bin`],
  /* The version stays the one chosen; paths stay out of what it builds, so its build cache holds wherever a part lies. */
  install: [script(GO_INSTALL, version, GO_PATH), at('go', 'env', '-w', 'GOTOOLCHAIN=local', 'GOFLAGS=-modcacherw -trimpath')],
});

const RUSTUP_HOME = `${TOOLS}/rustup`, CARGO_TOOLS = `${TOOLS}/cargo`;
const RUSTUP_VERSION = '1.29.3';
const RUSTUP_INSTALL = `machine="$(uname -m)"
case "$machine" in x86_64) sum=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55 ;; aarch64) sum=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282 ;; ${noBuild('Rust')} esac
curl -fsSL "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/$machine-unknown-linux-gnu/rustup-init" -o "$TMPDIR/rustup-init"
echo "$sum  $TMPDIR/rustup-init" | sha256sum -c -
chmod +x "$TMPDIR/rustup-init"
CARGO_HOME="$PWD/$1" "$TMPDIR/rustup-init" -y --no-modify-path --default-toolchain none
rm -f "$TMPDIR/rustup-init"`;
function rustTool(version: string, ask: ToolAsk): Tool {
  const own = ask.ownFile.map(({ root }): Command => ({ program: 'rustup', args: ['toolchain', 'install', '--no-self-update'], cwd: root }));
  const common = ask.noDefault ? [] : [at('rustup', 'toolchain', 'install', version, '--no-self-update', '--profile', 'minimal', '--component', 'rustfmt', '--component', 'clippy'), at('rustup', 'default', version)];
  return { id: 'rust', paths: [RUSTUP_HOME, CARGO_TOOLS], env: { RUSTUP_HOME }, bin: [`${CARGO_TOOLS}/bin`], inputs: ask.ownFile.map(({ path }) => path), install: [script(RUSTUP_INSTALL, CARGO_TOOLS), ...common, ...own] };
}

const JAVA_PATH = `${TOOLS}/java`;
const JAVA_INSTALL = `case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=aarch64 ;; ${noBuild('Java')} esac
info="$TMPDIR/jdk.json"
curl -fsSL "https://api.adoptium.net/v3/assets/latest/$1/hotspot?architecture=$arch&image_type=jdk&os=linux&vendor=eclipse" -o "$info"
curl -fsSL "$(jq -r '.[0].binary.package.link' "$info")" -o "$TMPDIR/jdk.tar.gz"
echo "$(jq -r '.[0].binary.package.checksum' "$info")  $TMPDIR/jdk.tar.gz" | sha256sum -c -
mkdir -p "$2"
tar -xzf "$TMPDIR/jdk.tar.gz" -C "$2" --strip-components=1
rm -f "$TMPDIR/jdk.tar.gz" "$info"`;
const javaTool = (version: string): Tool => ({ id: 'java', paths: [JAVA_PATH], env: { JAVA_HOME: JAVA_PATH }, bin: [`${JAVA_PATH}/bin`], install: [script(JAVA_INSTALL, version, JAVA_PATH)] });

const MAVEN_PATH = `${TOOLS}/maven`;
/* Each project keeps what Maven downloads apart, named by the one variable Maven's own settings read. */
const MAVEN_INSTALL = `base="https://repo1.maven.org/maven2/org/apache/maven/apache-maven/$1"; file="apache-maven-$1-bin.tar.gz"
curl -fsSL "$base/$file" -o "$TMPDIR/$file"
echo "$(curl -fsSL "$base/$file.sha512" | cut -d' ' -f1)  $TMPDIR/$file" | sha512sum -c -
mkdir -p "$2"
tar -xzf "$TMPDIR/$file" -C "$2" --strip-components=1
sed -i 's|^</settings>|<localRepository>\${env.HORNHOOF_MAVEN_REPOSITORY}</localRepository></settings>|' "$2/conf/settings.xml"
rm -f "$TMPDIR/$file"`;
const mavenTool = (version: string): Tool => ({ id: 'maven', paths: [MAVEN_PATH], bin: [`${MAVEN_PATH}/bin`], install: [script(MAVEN_INSTALL, version, MAVEN_PATH)] });

const GRADLE_PATH = `${TOOLS}/gradle`;
const GRADLE_INSTALL = `file="gradle-$1-bin.zip"; base=https://services.gradle.org/distributions
curl -fsSL "$base/$file" -o "$TMPDIR/$file"
echo "$(curl -fsSL "$base/$file.sha256")  $TMPDIR/$file" | sha256sum -c -
mkdir -p "$TMPDIR/gradle" "$(dirname "$2")"
python3 -m zipfile -e "$TMPDIR/$file" "$TMPDIR/gradle"
mv "$TMPDIR"/gradle/gradle-* "$2"
chmod +x "$2/bin/gradle"
rm -rf "$TMPDIR/$file" "$TMPDIR/gradle"`;
const gradleTool = (version: string): Tool => ({ id: 'gradle', paths: [GRADLE_PATH], bin: [`${GRADLE_PATH}/bin`], install: [script(GRADLE_INSTALL, version, GRADLE_PATH)] });

const PHP_PATH = `${TOOLS}/php`;
const COMPOSER_VERSION = '2.11.1';
/* PHP publishes no builds for Linux, and static-php-cli's hold the extensions most projects use and need nothing else. */
const PHP_INSTALL = `case "$(uname -m)" in x86_64|aarch64) arch="$(uname -m)" ;; ${noBuild('PHP')} esac
base=https://dl.static-php.dev/static-php-cli/common
case "$1" in
  *.*.*) version="$1" ;;
  *) version="$(curl -fsSL "$base/?format=json" | jq -r '.[].name' | sed -n "s/^php-\\($1\\.[0-9]*\\)-cli-linux-$arch\\.tar\\.gz$/\\1/p" | sort -V | tail -1)" ;;
esac
[ -n "$version" ] || { echo "No build of PHP $1 was found." >&2; exit 1; }
mkdir -p "$2"
curl -fsSL "$base/php-$version-cli-linux-$arch.tar.gz" | tar -xz -C "$2"
composer="https://getcomposer.org/download/${COMPOSER_VERSION}/composer.phar"
curl -fsSL "$composer" -o "$2/composer"
echo "$(curl -fsSL "$composer.sha256sum" | cut -d' ' -f1)  $2/composer" | sha256sum -c -
chmod +x "$2/composer"`;
const phpTool = (version: string): Tool => ({ id: 'php', paths: [PHP_PATH], bin: [PHP_PATH], install: [script(PHP_INSTALL, version, PHP_PATH)] });

const RUBY_PATH = `${TOOLS}/ruby`;
export const RUBY_PACKAGES = ['libssl-dev', 'libyaml-dev', 'zlib1g-dev', 'libffi-dev', 'libgmp-dev'];
/* Ruby publishes its source and no builds that run from any folder on these machines, so it is built once here. */
const RUBY_INSTALL = `index="$TMPDIR/ruby-index"; prefix="$PWD/$2"
curl -fsSL https://cache.ruby-lang.org/pub/ruby/index.txt | awk -F'\\t' '$2 ~ /\\.tar\\.gz$/' > "$index"
case "$1" in
  *.*.*) version="$1" ;;
  *) version="$(cut -f1 "$index" | sed -n "s/^ruby-\\($1\\.[0-9]*\\)$/\\1/p" | sort -V | tail -1)" ;;
esac
line="$(awk -F'\\t' -v name="ruby-$version" '$1 == name' "$index")"
[ -n "$line" ] || { echo "No source of Ruby $1 was found." >&2; exit 1; }
curl -fsSL "$(printf '%s' "$line" | cut -f2)" -o "$TMPDIR/ruby.tar.gz"
echo "$(printf '%s' "$line" | cut -f4)  $TMPDIR/ruby.tar.gz" | sha256sum -c -
mkdir -p "$TMPDIR/ruby"
tar -xzf "$TMPDIR/ruby.tar.gz" -C "$TMPDIR/ruby" --strip-components=1
cd "$TMPDIR/ruby"
./configure --prefix="$prefix" --enable-load-relative --enable-shared --disable-install-doc CC=gcc > "$TMPDIR/ruby-build.log" 2>&1 || { tail -40 "$TMPDIR/ruby-build.log" >&2; exit 1; }
make -j"$(nproc)" install >> "$TMPDIR/ruby-build.log" 2>&1 || { tail -40 "$TMPDIR/ruby-build.log" >&2; exit 1; }
cd - > /dev/null
rm -rf "$TMPDIR/ruby" "$TMPDIR/ruby.tar.gz" "$index" "$TMPDIR/ruby-build.log"`;
const rubyTool = (version: string): Tool => ({ id: 'ruby', paths: [RUBY_PATH], bin: [`${RUBY_PATH}/bin`], install: [script(RUBY_INSTALL, version, RUBY_PATH)] });

/* What a tool is when nothing names its version: the newest stable one when this was written, the same on every machine. */
export const TOOL_DEFAULTS: Record<ToolId, string> = { c: '', go: '1.27.3', rust: '1.99.1', java: '25', maven: '3.9.11', gradle: '9.9.0', php: '8.5', ruby: '4.0' };
const MAKERS: Record<ToolId, (version: string, ask: ToolAsk) => Tool> = { c: cTool, go: goTool, rust: rustTool, java: javaTool, maven: mavenTool, gradle: gradleTool, php: phpTool, ruby: rubyTool };
export const makeTool = (id: ToolId, ask: ToolAsk): Tool => MAKERS[id](ask.version ?? TOOL_DEFAULTS[id], ask);
