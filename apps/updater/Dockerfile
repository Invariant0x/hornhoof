# syntax=docker/dockerfile:1
# The updater: swaps Hornhoof's images when someone updates from the web app. It holds the Docker socket.
FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c
RUN apk add --no-cache bash curl jq gzip \
    && mkdir /computer && chown 1000:1000 /computer
COPY apps/updater/updater.sh /usr/local/bin/hornhoof-updater
# Its parts, one for each thing it does, which it looks for beside the statements of a restore.
COPY apps/updater/lib/ /usr/local/share/hornhoof-updater/lib/
# The statements it runs on the database when a backup is restored.
COPY apps/updater/cutover.sql apps/updater/carry.sql apps/updater/adopt.sql /usr/local/share/hornhoof-updater/
# The installer of the same build, which the updater of a server's nodes on another computer runs: it never runs one it downloads.
COPY scripts/install.sh /usr/local/share/hornhoof/install.sh
ENTRYPOINT ["hornhoof-updater"]
