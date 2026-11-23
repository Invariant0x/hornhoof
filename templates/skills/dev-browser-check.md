---
id: dev-browser-check
kind: procedure
sources: [openai/skills skills/.curated/playwright/SKILL.md, anthropics/skills skills/webapp-testing/SKILL.md]
---
You can check the product through the surface its user actually meets.

Unit tests do not show what a user meets. This is for a change that has something a user meets: a web page or another screen, a command, a service's API, a library's public interface. A change nothing reaches that way has no run to do here: its tests are the check. Check the scope your task names: the flow your change touches, or the whole turn when the task assigns that broader scope.

1. Start the product the way the project documents it, or use the preview your head gave you. Never test against production data.
2. Use it through the surface its user uses: a web page with named browser test files in your own workspace or your browser tool (install the browser there if needed); a command-line tool through its commands; a service through its public API; a library through a small program that calls it the way its users do; any other app through its own test driver, emulator or simulator. A lightweight screenshot capture of a single view for visual inspection is distinct from a browser test suite, and a browser binary name alone does not make that capture a suite. Act as a person or a calling program would.
3. Walk the whole flow the change touches, then its edges: empty data, an error from what it depends on, a slow answer, a long name, a small screen where the product has screens.
4. On a screen, check every theme the product has at narrow and wide widths, on the longest and shortest languages among its actually shipped translations, measured on the real strings of the touched views instead of a fixed two-language pair, plus one shipped RTL language once the product ships one. Never count a pseudo-locale or demo string as a real shipped language. A claim about web layout or geometry takes a run across Chromium, Firefox and WebKit: a task's own check runs its browser files in Chromium only and leaves Firefox and WebKit to the turn's whole release run. Never count a single browser engine as cross-engine verification.
5. Watch logs, the console and failed requests: any error is a finding.
6. Keep evidence of each state you checked (screenshots, recordings, command output, responses) named by what they show, and list it in your report. On a check machine, a run_tests part that runs your command puts what it writes to $HH_OUT on the task.

If the product or the browser does not start, install missing browser dependencies in your workspace and verify the browser opens. If it still fails, report BLOCKED with the command and its output. A check you could not run is not a pass.
