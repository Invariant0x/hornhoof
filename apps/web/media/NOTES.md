# Media Rendering Notes (App Behavior Without `src` Changes)

Per the project rules, `apps/web/src`, `apps/server`, `apps/node`, and `packages` were not modified. The points below record places where the existing UI shapes how a scene is presented from data alone:

1. **`tree.gif` agent card interaction (`apps/web/src/screens/TreeView.tsx`)**
   Clicking an agent's lane or mark in `TreeView` calls `openAgent(pick.agentId)`, which opens `AgentWindow` on the right rather than the inline `<FloatingCard className="tv-card">` (that floating card only opens for `main`, `turn`, `merge`, and `review` items that have no `agentId`). In `scenes/tree.spec.ts`, the tree runs at `83%` zoom so labels and task numbers fill the canvas width, then clicks `Iris`'s row and presses `Card` inside `Iris`'s window to display `Card: Iris` alongside the tree before closing back to the opening frame.

2. **`terminal.gif` side panel width at `1440x900` (`apps/web/src/ui/SidePanels.tsx`, `apps/web/src/theme.css`)**
   At a `1440px` viewport, `.orch` leaves roughly `584px` of free space to the left of `.xterm`, and each side panel uses `--panel-width: 400px`. One open panel (`Card: Iris`) stands completely clear of `.xterm`, while two open panels (`Task` and `Card`) reach `224px` over the left edge of `.xterm` and show the `"Back to terminal"` button. `scenes/terminal.spec.ts` keeps `Card: Iris` open while `terminal.rec` streams in full view, then opens `Task` (`#221`) beside it for the closing seconds.

3. **`home.gif` household yes/no requests (`apps/web/src/ui/Requests.tsx`)**
   Requests with `kind: 'approval'` always display `"<Agent> asks you to approve a commit"` together with a commit hash badge. Because Oak Lane home is a family household rather than a software team, its two confirmation prompts ("Router firmware 7.2 is ready: update tonight?" and "3 unknown browser extensions on Mia's laptop: remove?") are modeled as `kind: 'choice'` requests with clear action buttons (`"Yes, update tonight at 23:30"` and `"Yes, remove all 3 extensions"`).

4. **`machines.gif` inline card height at `1440x900` (`apps/web/src/screens/Machines.tsx`)**
   `Machines` expands a machine's card inline as a detail row (`<tr className="det">`) inside the table. For `studio-server` (`Company server here`), the full expanded detail row (including `Resources`, `Running now`, `Plans on this machine`, `Agent programs`, and `Connection to the server`) is roughly `980px` tall, slightly taller than the `848px` `.body` scroll area at `1440x900`. `scenes/machines.spec.ts` starts at `scrollTop = 0` so the pool summary bar (`10 of 10` online, `112` cores, `146.4 of 296 GB`, `55%` busy) stands completely in view, then opens `studio-server` and scrolls smoothly in two stages across the upper (`Running now` and `Plans on this machine`) and lower (`Agent programs` and `Connection to the server`) sections before closing and returning smoothly to `scrollTop = 0`.

5. **`setup.gif` template grid count (`apps/web/src/screens/Setup.tsx`)**
   The setup screen renders `Start empty` followed by the nine named templates with mini org charts (`Project team`, `Startup`, `Studio with products`, `Full company`, `Cybersecurity company`, `Marketing agency`, `Research group`, `Online store`, `Home`). `scenes/setup.spec.ts` types `Moonfern`, scrolls across the templates, and picks `Startup`.
