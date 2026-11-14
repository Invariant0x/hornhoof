# A machine of the lab: a computer with its own Docker, on which install.sh runs as it does on a person's computer.
# Pinned by digest, so every run of the lab starts from the Docker this was tried with.
FROM docker:28.5.2-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac
# What install.sh and the updater use and the image lacks; iptables is for the lab's cuts of a machine's network.
RUN apk add --no-cache bash curl jq coreutils iptables
