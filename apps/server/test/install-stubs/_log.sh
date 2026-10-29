# Shared by the installer stubs: log the call, then act on the STUB_* switches.
# STUB_LOG gets one line per call; STUB_SRC holds the stubs, STUB_BIN is the PATH folder; STUB_STATE keeps flags between calls.
printf '%s %s\n' "$(basename "$0")" "$*" >> "$STUB_LOG"
