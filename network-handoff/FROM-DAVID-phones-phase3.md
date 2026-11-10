# Phones as workers (phase 3): Ivan's decision, 2026-11-06

For whoever designs phase 3 of the network spec ("phones as workers"). Not for phase 1 or 2.

## Decision

An Android app (APK) with one screen is the phone node. Not a browser page, not Termux by hand.

- **Inside the app: the node's own Linux.** The app carries the rootfs of the same arm64 node image and runs it through proot inside the app's sandbox, as a foreground service with a notification. No root, no Docker. The Android app sandbox plays the part of the container: the agent cannot leave the app.
- **What works there:** Claude Code, Codex, Kimi and other agent programs, git, Node.js, apt, npm, pip, headless Chromium with --no-sandbox. File-heavy work (npm ci, big git trees, test suites with many files) runs about 1.5 to 3 times slower than on a computer.
- **What does not:** Docker, mounts, system services, network and firewall settings, ptrace tools (debuggers, strace), ports under 1024. The machine reports these limits as its capabilities, and Hornhoof does not send it work that needs them.
- **A WebView in the same app** gives a real Android Chromium for UI checks on a real device when a check asks for one.
- **Joining:** Machines tab, "Add machine", Android: a QR code and the APK link; scan, and the phone joins like any computer. The node inside updates with the usual Update button; the APK itself rarely changes.
- **Release:** APK in GitHub Releases with every version, open source with a reproducible build. Google Play later, if its rules allow an app that runs Linux inside.
- **Power and heat:** works on a charger; the phone reports battery and temperature, and Hornhoof gives it less work when it throttles. A Samsung S24 class phone takes test parts too, with less memory (Android keeps 3 to 4 GB of 8) and lower sustained speed.
- **Browser-only workers** (a page kept open) are dropped as the main path. A browser tab is at most a later extra.

Phones never take the server and never hold copies of the data, as the spec already says.
