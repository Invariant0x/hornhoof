# syntax=docker/dockerfile:1
# The node: runs the agent programs (Claude Code, Codex, Kimi Code, Antigravity CLI) for one subscription, or for the company's API keys with --builtin.
# Build steps that prepare JavaScript or browser downloads run on the builder's own platform. The final PostgreSQL
# smoke runs in the target image so an unsupported runtime cannot pass the image build.
# Our package files with our own versions set aside, which each release moves and nothing installed reads, and the
# lockfile's Playwright version: the stages that install take only these, so a release reuses the layers they made.
FROM --platform=$BUILDPLATFORM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/node/package.json apps/node/
COPY apps/web/package.json apps/web/
COPY scripts/release/workspace-versions.mjs /tmp/workspace-versions.mjs
RUN node --input-type=module -e "(await import('/tmp/workspace-versions.mjs')).setAside('.')" \
  && node -p "require('./package-lock.json').packages['node_modules/@playwright/test'].version" > /playwright-version

FROM --platform=$BUILDPLATFORM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
WORKDIR /app
COPY --from=manifests /app/ ./
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/node apps/node
RUN npm run build -w @hornhoof/protocol && npm run build -w @hornhoof/node

# The node's production modules: no native code among them.
FROM --platform=$BUILDPLATFORM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS deps
WORKDIR /app
COPY --from=manifests /app/ ./
RUN npm ci --omit=dev --workspace apps/node --workspace packages/protocol && npm cache clean --force \
  && rm -rf node_modules/.package-lock.json node_modules/@hornhoof/server node_modules/@hornhoof/web

# Browsers for agents: Playwright with Chromium, Firefox and WebKit for the target at the repository lockfile's version, and the Debian packages they need.
# Playwright picks the download by the machine it runs on; the override names the target instead.
FROM --platform=$BUILDPLATFORM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS browser
ARG TARGETARCH
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
COPY --from=manifests /playwright-version /tmp/playwright-version
RUN npm install -g "playwright@$(cat /tmp/playwright-version)" \
  && rm -f /tmp/playwright-version \
  && npm cache clean --force
COPY apps/node/browser-packages.cjs /opt/browser-packages.cjs
RUN target="debian12-$(case "$TARGETARCH" in amd64) echo x64 ;; *) echo "$TARGETARCH" ;; esac)" \
  && PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="$target" playwright install chromium firefox webkit \
  && node /opt/browser-packages.cjs /usr/local/lib/node_modules/playwright/node_modules/playwright-core/lib/coreBundle.js "$target" > /opt/browser-packages \
  && chmod -R a+rX /opt/ms-playwright

# Uncle Bob's quality tools (0BSD): crapper for CRAP scores, dryer for duplicates, mutator for mutation testing. Each keeps
# its virtualenv next to it, as its launcher expects; mutator also gets crapper, whose names it uses. With them, ECC's
# rules for each language (MIT), without its common layer and hooks, which assume ECC's own agents. All at pinned
# commits. The grammars the tools parse with come along, so they run without fetching anything.
FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS quality
# Fixed timestamp so pip wheel archives and Python bytecode headers stay byte-for-byte identical across builds.
ARG SOURCE_DATE_EPOCH=315532800
ENV TREE_SITTER_LANGUAGE_PACK_CACHE_DIR=/opt/hornhoof/grammars
ARG CRAPPER_COMMIT=6fd92c4c9bcc56efb64a2f8743d5a2993bcfd42d
ARG DRYER_COMMIT=66ff6d21a42c04afcad89c78a80066176d1294b0
ARG MUTATOR_COMMIT=a5a0cb803b66e0cdb8bf471b3b08af701d424a41
ARG ECC_COMMIT=91b5f6a371f7b06d2c3e0c208147c559e11f022c
ARG TREE_SITTER="tree-sitter==0.26.0 tree-sitter-language-pack==1.22.1"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl patch python3 python3-venv && rm -rf /var/lib/apt/lists/*
COPY apps/node/quality/ /tmp/hornhoof-quality/
RUN set -e; ub=/opt/hornhoof/ub; mkdir -p $ub /opt/hornhoof/bin /opt/hornhoof/rules /tmp/ecc; \
  fetch() { mkdir -p "$2"; curl -fsSL "https://codeload.github.com/$1/tar.gz/$3" | tar -xz --strip-components=1 -C "$2"; }; \
  fetch unclebob/crapper $ub/crapper $CRAPPER_COMMIT; \
  fetch unclebob/dryer $ub/dryer $DRYER_COMMIT; \
  fetch unclebob/mutator $ub/mutator $MUTATOR_COMMIT; \
  patch --directory=$ub/mutator --strip=1 < /tmp/hornhoof-quality/mutator-worker-modules.patch; \
  patch --directory=$ub/mutator --strip=1 < /tmp/hornhoof-quality/mutator-outcomes.patch; \
  patch --directory=$ub/crapper --strip=1 < /tmp/hornhoof-quality/crapper-coverage-report.patch; \
  for tool in crapper dryer mutator; do \
    python3 -m venv $ub/$tool/.venv; \
    $ub/$tool/.venv/bin/pip install --no-cache-dir $TREE_SITTER $([ $tool = mutator ] && echo $ub/crapper) $ub/$tool; \
    printf '#!/bin/sh\nexec %s "$@"\n' $ub/$tool/$tool > /opt/hornhoof/bin/$tool; chmod 755 /opt/hornhoof/bin/$tool; \
    /opt/hornhoof/bin/$tool --help > /dev/null; \
  done; \
  $ub/crapper/.venv/bin/python /tmp/hornhoof-quality/test_crapper_coverage.py; \
  $ub/mutator/.venv/bin/python /tmp/hornhoof-quality/test_crapper_coverage.py; \
  $ub/mutator/.venv/bin/python /tmp/hornhoof-quality/test_mutator_workers.py; \
  $ub/mutator/.venv/bin/python /tmp/hornhoof-quality/test_mutator_outcomes.py; \
  $ub/crapper/.venv/bin/python /tmp/hornhoof-quality/test_part_paths.py CrapperPaths; \
  $ub/dryer/.venv/bin/python /tmp/hornhoof-quality/test_part_paths.py DryerPaths; \
  $ub/mutator/.venv/bin/python /tmp/hornhoof-quality/test_part_paths.py MutatorPaths; \
  $ub/crapper/.venv/bin/python -c "import tree_sitter_language_pack as p; p.download(['clojure', 'go', 'java', 'javascript', 'python', 'rust', 'tsx', 'typescript'])"; \
  fetch affaan-m/ECC /tmp/ecc $ECC_COMMIT; \
  cp -R /tmp/ecc/rules/. /opt/hornhoof/rules/; cp /tmp/ecc/LICENSE /opt/hornhoof/rules/LICENSE; rm -rf /tmp/ecc; \
  cd /opt/hornhoof/rules; rm -rf common README.md */hooks.md; find . -name '*.md' -exec sed -i '/^See skill:/d' {} +; \
  printf 'Rules for each language from affaan-m/ECC at %s, under its MIT license (LICENSE).\nHornhoof left out its common layer and hooks, which assume ECC agents, and its pointers to ECC skills.\n' $ECC_COMMIT > README.md; \
  chmod -R a+rX /opt/hornhoof

FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
ARG TARGETARCH
ARG GH_VERSION=2.103.3
ARG GH_AMD64_SHA256=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
ARG GH_ARM64_SHA256=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63
ARG SHELLCHECK_VERSION=0.11.0
ARG SHELLCHECK_AMD64_SHA256=b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6
ARG SHELLCHECK_ARM64_SHA256=68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc
COPY --from=browser /opt/browser-packages /opt/browser-packages
# procps gives agents ps and free, python-is-python3 the python that scripts call, and python3-pil Pillow for image checks.
# zip packs what unzip unpacks; python3-yaml, python3-pip and python3-pytest give Python scripts YAML, pip and the usual test runner.
# tini runs first in the container and ends the processes left without a parent, which the node never waits for.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl gpg ripgrep jq file tmux tini procps util-linux unzip zip binutils patch iproute2 time python3 python3-venv python-is-python3 python3-pil python3-yaml python3-pip python3-pytest $(cat /opt/browser-packages) \
  && install -d /usr/share/keyrings \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/keyrings/postgresql-pgdg.asc \
  && GNUPGHOME="$(mktemp -d)" && export GNUPGHOME \
  && gpg --batch --show-keys --with-colons /usr/share/keyrings/postgresql-pgdg.asc > /tmp/pgdg-key \
  && test "$(awk -F: '$1 == "fpr" { print $10 }' /tmp/pgdg-key)" = B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8 \
  && rm -rf "$GNUPGHOME" /tmp/pgdg-key && unset GNUPGHOME \
  && printf '%s\n' 'deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/postgresql-pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
  && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod 755 /usr/sbin/policy-rc.d \
  && apt-get update -o APT::Update::Error-Mode=any \
  && apt-get install -y --no-install-recommends postgresql-common \
  && printf '%s\n' 'create_main_cluster = false' 'start_conf = manual' > /etc/postgresql-common/createcluster.conf \
  && apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/* \
  && flock --version \
  && unzip -v \
  && zip -v \
  && python3 -c 'import yaml' \
  && python3 -m pip --version \
  && python3 -m pytest --version \
  && /usr/bin/time --version \
  && strings --version \
  && patch --version \
  && ss --version \
  && objdump --version \
  && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
  && case "$arch" in amd64) sha="$GH_AMD64_SHA256"; sc_arch=x86_64; sc_sha="$SHELLCHECK_AMD64_SHA256" ;; arm64) sha="$GH_ARM64_SHA256"; sc_arch=aarch64; sc_sha="$SHELLCHECK_ARM64_SHA256" ;; *) exit 1 ;; esac \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" -o /tmp/gh.tar.gz \
  && echo "$sha  /tmp/gh.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/gh.tar.gz --no-same-owner -C /usr/local/bin --strip-components=2 "gh_${GH_VERSION}_linux_${arch}/bin/gh" \
  && rm -f /tmp/gh.tar.gz \
  && gh --version \
  && curl -fsSL "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.${sc_arch}.tar.gz" -o /tmp/shellcheck.tar.gz \
  && echo "$sc_sha  /tmp/shellcheck.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/shellcheck.tar.gz --no-same-owner -C /usr/local/bin --strip-components=1 "shellcheck-v${SHELLCHECK_VERSION}/shellcheck" \
  && rm -f /tmp/shellcheck.tar.gz \
  && shellcheck --version
# Wireless pairing needs a newer adb than bookworm's default. Debian's signed backport supplies native amd64 and arm64.
RUN printf '%s\n' 'deb https://deb.debian.org/debian bookworm-backports main' > /etc/apt/sources.list.d/hornhoof-adb.list \
  && apt-get update -o APT::Update::Error-Mode=any \
  && apt-get install -y --no-install-recommends -t bookworm-backports adb=1:34.0.5-12~bpo12+1 \
  && rm -rf /var/lib/apt/lists/*
ENV PATH=/usr/lib/postgresql/17/bin:$PATH
COPY apps/node/service-runtime-smoke.mjs /app/apps/node/service-runtime-smoke.mjs
RUN node /app/apps/node/service-runtime-smoke.mjs
COPY --from=quality /opt/hornhoof/ub /opt/hornhoof/ub
COPY --from=quality /opt/hornhoof/rules /opt/hornhoof/rules
COPY --from=quality /opt/hornhoof/grammars /opt/hornhoof/grammars
ENV TREE_SITTER_LANGUAGE_PACK_CACHE_DIR=/opt/hornhoof/grammars
COPY --from=quality /opt/hornhoof/bin/ /usr/local/bin/
# Seed outside /data and readable by every job user; runtime browsers live on /data/browsers across container updates.
ENV NODE_PATH=/usr/local/lib/node_modules
COPY --from=browser /opt/ms-playwright /opt/ms-playwright
COPY --from=browser /usr/local/lib/node_modules/playwright /usr/local/lib/node_modules/playwright
RUN chmod 755 /usr/local/lib/node_modules/playwright/cli.js && ln -s ../lib/node_modules/playwright/cli.js /usr/local/bin/playwright
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/node/package.json apps/node/package.json
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/apps/node/dist apps/node/dist
# git asks this for a repository's password; the node gives each turn its token in HH_GIT_PASSWORD.
COPY --chmod=755 apps/node/git-askpass /app/git-askpass
# Agents send screenshots for people and files for a task with hh-attach, and download a task's files with hh-fetch; the
# node gives each turn its address and token.
COPY --chmod=755 apps/node/hh-attach.cjs /usr/local/bin/hh-attach
COPY --chmod=755 apps/node/hh-fetch.cjs /usr/local/bin/hh-fetch
# Agents of every department read pages that scripts build with hh-browse, in the image's own Playwright and Chromium,
# through a proxy of each call that opens only public addresses.
COPY --chmod=755 apps/node/hh-browse.cjs /usr/local/bin/hh-browse
COPY --chmod=755 apps/node/hh-xlsx.cjs /usr/local/bin/hh-xlsx
# Agents run in tmux sessions; their hooks and status line tell the node how a turn goes through hh-hook.
COPY --chmod=755 apps/node/hh-hook.cjs /usr/local/bin/hh-hook
COPY apps/node/hh-hook-send.cjs /usr/local/bin/hh-hook-send.cjs
# The terminal's private, bounded raw output survives programs leaving their alternate screen.
COPY apps/node/hh-capture.cjs /app/apps/node/hh-capture.cjs
COPY apps/node/hh-fs.cjs /app/apps/node/hh-fs.cjs
RUN mkdir -p /data && chown node:node /data
# Agent programs run their commands in login shells, where Debian's /etc/profile sets PATH again: the tools folder goes
# back in front, so an agent finds codex, claude, kimi and agy by name, and Playwright finds /data/browsers.
RUN printf '%s\n' \
  'case ":$PATH:" in *:/data/tools/bin:*) ;; *) PATH=/data/tools/bin:$PATH ;; esac' \
  'case ":$PATH:" in *:/usr/lib/postgresql/17/bin:*) ;; *) PATH=/usr/lib/postgresql/17/bin:$PATH ;; esac' \
  ': "${PLAYWRIGHT_BROWSERS_PATH:=/data/browsers}"' \
  ': "${PLAYWRIGHT_SKIP_BROWSER_GC:=1}"' \
  'export PATH PLAYWRIGHT_BROWSERS_PATH PLAYWRIGHT_SKIP_BROWSER_GC' > /etc/profile.d/hornhoof-tools.sh
# Agent programs are installed into /data/tools at first use, keep their sign-in in /data/home, and share browsers in /data/browsers.
# Set last, so nothing the build writes lands in /data.
ENV PATH=/data/tools/bin:$PATH HOME=/data/home PLAYWRIGHT_BROWSERS_PATH=/data/browsers PLAYWRIGHT_SKIP_BROWSER_GC=1
# Personal nodes run as node. The built-in node overrides the user to root in compose.yaml, to run each company key as its own user.
USER node
VOLUME /data
# The node build, which the node says in its hello: the last commit that changed this image's files, never the commit of
# the build itself, so an unchanged image keeps its digest.
ARG HORNHOOF_NODE_BUILD=
ENV HORNHOOF_NODE_BUILD=$HORNHOOF_NODE_BUILD
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/apps/node/dist/main.js"]
CMD ["run"]
