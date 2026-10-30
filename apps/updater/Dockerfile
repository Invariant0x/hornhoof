# syntax=docker/dockerfile:1
# The updater: swaps Hornhoof's images when someone updates from the web app. It holds the Docker socket.
FROM docker:27-cli
RUN apk add --no-cache bash curl jq gzip
COPY apps/updater/updater.sh /usr/local/bin/hornhoof-updater
ENTRYPOINT ["hornhoof-updater"]
