# syntax=docker/dockerfile:1
# The updater: swaps Hornhoof's images when someone updates from the web app. It holds the Docker socket.
FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c
RUN apk add --no-cache bash curl jq gzip
COPY apps/updater/updater.sh /usr/local/bin/hornhoof-updater
ENTRYPOINT ["hornhoof-updater"]
