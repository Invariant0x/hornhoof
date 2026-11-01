# Homebrew's install script as the curl stub serves it: it puts the brew stub on the PATH.
cp "$STUB_SRC/brew" "$STUB_BIN/brew"
echo "homebrew-install" >> "$STUB_LOG"
