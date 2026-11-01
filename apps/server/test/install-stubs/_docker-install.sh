# Docker's install script as the curl stub serves it: it puts the docker stub on the PATH.
cp "$STUB_SRC/docker" "$STUB_BIN/docker"
echo "get-docker" >> "$STUB_LOG"
