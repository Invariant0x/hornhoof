# Changelog

Newest releases come first. Each release starts with `## [X.N.P] - YYYY-MM-DD` and is one short list in English: one
line per entry under `### Fixed`, `### Added` and `### Changed`, in that order, with no summary and no translation. A
step people must take before updating is the first entry under Changed, starting with "Before you update:". The middle
number is the turn; the last counts releases between turns. Releases before 0.31.0 keep their older form.

## [Unreleased]

### Fixed

- When the server cannot be reached, restarts or installs an update, the page no longer shows a missing page, "Insufficient permissions" or "Hornhoof is not responding": a layer over the page says "No connection to the server" or "Server is updating" in the person's language, asks the server again with a growing wait, and once it answers every screen and the live stream come back with no reload, also for a page opened or reloaded during the outage. An answer of a hop in front of the server that is not Hornhoof's, such as a 404 page of the public link's relay, is read as a lost connection; what the server itself says is missing still reads as missing.
- A browser that opens a page while the front or the keeper has no server behind it gets a plain page in English and Russian that says the same, opens by itself once the server answers and makes no request outside itself, instead of an unstyled line of text. The statuses stay 502 and 503, never 404.
- The head of Design, named on a task's tracked work to check a screen's final look, can now read that task and its files and comment on it until the check ends, and the task's holder can message that head about it.
- An employee's open terminal stays connected when idle or on a personal-plan fallback machine: the server sends WebSocket keepalive pings and checks fallback placement consistently, the window keeps the terminal mounted across brief node drops, and unavoidable reconnects or program restarts recover without flashing the loader or losing scrollback history and reading position.
- An employee's program that waits between turns no longer starts anew when the terminal showing it loses its connection for a moment: the node keeps it for 30 seconds after its last view went, so the view that comes back finds it. A view ended because its person may no longer see the agent holds it no longer, and a program whose agent moved to another plan still goes at once.
- A merge of a copy's database no longer stops with "No merge rule for public.world_layouts": the company's city and the CEO's orders to move its buildings merge like a person's map, and two cities that differ keep the leading one and go to the orchestrator.
- A task reaches Failures only for a cause that needs a person: a command Hornhoof refuses before it starts ends as refused, with the refusal told to its agent at once as a hint, and neither it, a stopped run, a turn that retries by itself after an overloaded provider or a usage limit, nor a turn replaced because its task moved on marks a task, the agent card or the map as failed; a stuck agent asking for help and a turn that failed with nothing to take it on now do, each until it is answered or a turn goes well, and the failure card says what to do. Refusals kept as failed runs become refused when the update runs.

## [0.42.0] - 2026-11-23

### Fixed

- In the tracker list, the slow-loading notice and load error no longer push the held rows down: they appear over the top rows while the rows underneath stay in place, and a short list keeps room for the notice.
- On a page right to left, the tracker's graph is drawn mirrored too: its root at the right, each level further to the left, the lines of what a task waits for on the left with their words beside the waiting task, and its zoom at the right as on the other canvases.
- People and Machines hold the room of their data while it comes, with the same loading ring and Retry: their table heads, and Machines' pool and search, stand at once, and nothing above the rows moves when they come. Once Machines showed its filter buttons in a tab, its next load there holds their room too.
- The map, a department with its tree and speed, and an employee's window show the same loading indicator where their data will stand. The map is drawn only once the company and the person's own arrangement came, so its blocks no longer jump into place. A department opened at its own address keeps back, the plate of its name and its tools while its company comes, so a failure there has a way out. Their loads say why they failed, or that they take longer than usual, as the tracker's do. None of them says it is empty, such as a conversation with no messages yet, while something it shows is still on its way.
- A summary Claude writes of a compacted conversation, or an entry only its transcript shows, no longer counts as the delivery of an operator's assignment it repeats word for word, and a new session's log the node cannot look at for any reason but that it is not there yet gives no receipt.
- A bar over the map, such as an update's, no longer pushes the map and an open department down: they reach the top of the window under the header and the bars, and what they show starts under the bars. Windows and cards open 8 px under the bars, and a card opened over a department 8 px under its name, however many lines the name takes.
- On the map and in an open department the menu, the bars and the bottom bar are separate glass blocks with no shadow and no band between them, so the map shows around them to the top and the bottom of the window, the department's schema too. The chosen tab stands on a solid backing. The department's name and the windows that open there stand 8 px under the menu or the last bar on every screen. When a bar comes or goes the name and the map or the schema slide to their new place in 200 ms, at once with less motion. On a phone every bar after the first folds to one line with More.
- In a page that reads right to left, the glow of the map's hub stands around the hub instead of at the map's right edge.
- An Antigravity turn that launches a subagent keeps the employee's main conversation as its session, ignores hooks from child conversations, and resumes the main conversation with its Hornhoof tools on the next turn.
- An Antigravity turn that fails with `UNAUTHENTICATED (code 401)` because its program kept an hour-old access token is no longer lost as an unknown failure: the program starts anew with the saved sign-in and the turn is tried once more with no person involved, and a second refusal right after that is a sign-in failure with a clear reason for Operations.
- When the updater cannot remove its copy of a loaded dump, or the folder it kept it in, it says so and the restore ends done or undone as before; a failed or interrupted write of that warning no longer stops the updater, though an output that stays closed can still stop it at its next line.
- An upload whose table is 8 GiB or more, which tar writes with a base-256 size, is read correctly and accepted within the upload limit.

### Added

- A machine's card shows its disk and Hornhoof's share of it part by part, the largest first, with the employees' working folders of each of its nodes and the copies of company databases it holds, each counted once inside the volumes, and a machine short of space gives its owner and the CEO one card with the numbers, what it already removed and what it did not remove because a person needs to check it; the card goes by itself once there is room.
- Each node looks after its disk every ten minutes: it removes what can come back (left-over check files, the working copies of finished tasks once everything in them is on GitHub and all they ignore is dependencies, builds, caches or test output, the installed dependencies of those that stay, and terminal recordings a stopped node left), deduplicates ignored `node_modules` across clones through a per-user read-only hard-link package store (`PNPM_STORE_DIR` / `npm_config_cache` plus content-addressed CAS with automatic GC), reports its disk and Hornhoof's share by part, and while it is still short of space takes no new checks or builds, with the reason; turns go on. The threshold is the larger of a share of the disk and an amount, 10% and 20 GB by default (`HORNHOOF_DISK_SHARE`, `HORNHOOF_DISK_GB`). Unsaved work and files git ignores that no remote has are never touched and are named in the report.
- Each machine's updater cleans Hornhoof's own Docker leftovers once an hour outside active updates: old Hornhoof images (keeping the two newest per repository and any image in use, without force), day-old leftover test stands (`hornhoof.lab`) and stale port-lock containers, and Docker build cache unused for 72 hours when Docker's disk is low or the cache exceeds its limit (10% or 10 GB by default). Node volumes, database volumes and non-Hornhoof resources are never touched. The updater hands Hornhoof's Docker sizes and recent removals to each running node to include in its disk report.

## [0.40.3] - 2026-11-21

### Fixed

- An updater on an older installation whose shared control folder kept the setgid bit (`2755`) no longer refuses its own staging folders silently: it clears setgid on private staging and keeper folders so heartbeats and update requests work again, and re-running the installer clears setgid on an existing control volume and its subdirectories.

## [0.40.2] - 2026-11-21

### Fixed

- On a heavily loaded machine a node no longer refuses an agent's own hooks as callers outside its terminal, so finished turns end: it checks a caller the moment its call arrives, each hook waits for the node as long as its program allows, and a caller that left before its check is refused under that reason.
- Reading a task no longer spends GitHub's request limit: what GitHub said of whether a department's task branches are in main is kept, one read asks it of 10 branches at most, and once GitHub answers that the account's limit is used up nothing more is asked until its reset.

## [0.40.1] - 2026-11-21

### Fixed

- An employee's program waits two minutes for Hornhoof's tools to connect as it starts, not 30 seconds: Claude Code (`MCP_TIMEOUT`, unless the node was started with one), Codex and Kimi Code. One that still gave up before Hornhoof answered ends its turn as one without tools, which Hornhoof repeats, and the next turn starts it again in its session, where it connects.

## [0.40.0] - 2026-11-20

### Fixed

- Stop ends any turn an employee's node runs, not only one a person typed: the program stops as on Escape and the turn ends as stopped at once, even when the node never heard the program say its turn ended, and that end is told once.
- Map cards and the department screen show every word in any language: cards grow together, far zoom moves nothing, words break with hyphens and the hint keeps its own room.
- People on the map show their whole name and title in any language: their chips wrap with hyphens and each row grows to its tallest chip.
- On a phone the map opens with names readable and a department opens on its head card; both scroll to an edge and stop clear of the floating buttons, and nothing scrolls under them.
- Japanese names and titles on the map's people chips break between phrases, so no single character is left alone on a line.
- When one employee's plate on the work tree grows with new words, the lanes under it move down without drawing their chips again.
- The map opens readable: on a phone its people chips' names are 11 px or more, as its cards' names are on any screen. A map that fits whole at that size opens as Show everything shows it, never larger than 100%, and one that does not opens with the hub in the middle across.
- A node that waits for its work to end before an update holds new turns for at most 45 minutes (`NODE_UPDATE_WAIT_MS`): then it updates, and each turn it cut runs once more after the restart. The orchestrator hears once when a wait passes half an hour.
- A tab whose session ended goes to the sign-in screen at once, and a tab nobody is signed in on reloads by itself once Hornhoof runs another version.
- After the sign-in code, a plan's card and its sign-in window show that it is connecting, with its steps, the step its machine is at and the time since the code, until it is ready, for every program. A minute with no new step (`SIGNIN_SLOW_MS`) says it takes longer than usual; at 10 minutes (`SIGNIN_CONNECT_MS`) it fails and says why and what to do, each with Retry and Stop.
- The tracker, the task card, the plans screen and a plan card's tokens hold the room of their data while it comes, with one loading ring from 400 ms, and nothing already shown moves when it comes. At 10 seconds a load says it takes longer than usual, at 30 seconds it gives up and says why, and an error says why at once, each with Retry. A section says that it has nothing only once all of it came.
- On a page right to left, the map's zoom and Put back stand at the right, mirrored as the rest of the layout is.
- On a page right to left, the zoom of a department's schema and tree stands at the right too, and the department's line of what happened, its actions and its Speed and About drawer stand mirrored with it; an agent window keeps its place, and the tracker's graph, still drawn from the left, keeps its zoom at the left, clear of its tasks.
- A plan with separate limits for groups of models, as Antigravity's Gemini and its Claude and GPT models, keeps each group's limits: a used-up group holds only the turns and fallbacks on its own models, and the plan's card shows every group with what it used and when it resets.
- In a page that reads right to left, an English line of a bar over the map ends with its full stop instead of starting with it, and the bar stays mirrored.
- A number on a plan's card stays on one line with its unit or the word it goes with, as "14 h", "1 online" or "Input 0", in every language; a reset still wraps between its parts.
- A release no longer counts as checked a commit that turnkey work was built on but its employee did not make: Hornhoof notes where the turn branch was as the work starts, refuses a start named under it, lists work whose start it has no record of for a person, and a tag named like main never stands for main.
- Stop ends a turn even when its machine never reports the end: Hornhoof closes the turn itself at most a minute and a half after Stop, and the employee's waiting messages go out.
- The updater can no longer be made to overwrite files of the installation, such as its secrets: it does not follow what the app puts in the folders they share, gives an installer it runs a folder of its own, and unpacks from an upload or a restore only plain files whose own header it read, at most 1000 of them.
- A restore whose dump is a named pipe gets an answer instead of waiting for ever, an archive with data after its end fails as unreadable, and removing a loaded dump's copy never stops the updater.
- The updater keeps answering while it carries an employee's computer commands.
- A Kimi Code turn that goes on after words were steered into it keeps its job and its tools, and a turn Kimi starts on its own no longer leaves the next turn waiting silently behind it.
- A department's schema opens clear of the top bar at every width, and on a screen wider than 760 px the tracker's list, board and graph make room beside an open task card instead of lying under it.

### Added

- People who see the whole company have a tracker section Waiting for people: every decision they see and every task that waits for a person, each saying whom it waits for.

### Changed

- In the tracker's list, the status dot of a task an employee works on right now has a filled core that breathes slowly, every such dot together; for a person who asked for less motion the core is full and still, and a screen reader hears "In work, working now".
- The map runs to the bottom of the screen, with the version as small muted text in its bottom end corner, clear of its buttons and of the bars along a phone's bottom; other screens keep the version in the row below them.
- Waiting for me lists only what waits for you: a question asked of another person by name waits for that person alone. A person's filter names them in the page title, with no chip of its own.
- A release that brings commits no check covered is recorded only once a person approves a card that lists exactly those commits, shown next to Approve, whatever the commit rule and even under autonomous release. A hand-in's base must already be on main or the open turn, and turnkey work counts only from the commit its holder checked.

## [0.39.5] - 2026-11-20

### Added

- A run_tests part that runs a command gets an empty folder in $HH_OUT, and the plain files it leaves there, such as a browser check's pictures, go on the run's task as test-<run>-<part>-<name>, as run_work's do, whether its tests passed or failed.

## [0.39.4] - 2026-11-20

### Fixed

- A node no longer refuses the hooks of an agent's own program as callers outside its terminal after the program gave up on one, so its Hornhoof tools stay connected.

## [0.39.3] - 2026-11-19

### Fixed

- On a phone, a department's head card no longer opens under the department's name: it starts 8 px below it, with or without a banner over the map.

## [0.39.2] - 2026-11-19

### Fixed

- A department opened while a banner shows over the map now fills the screen instead of splitting it with the map.

## [0.39.1] - 2026-11-19

### Fixed

- The phone readiness check keeps the screen visibly bright, at about 40% of the phone's own brightness range, and never lowers a brightness a person set higher.

## [0.39.0] - 2026-11-19

### Fixed

- A version whose tag reaches GitHub with main still gets its images built, published and released: a version counts as out only once its images are published, and as released once its tag has a release.
- When GitHub or the image registry answers with an error or cannot be reached, a release stops and says why, and leaves the latest images and the releases as they are.
- Review stays required after a return from Tests, and no one who produced a task's candidates reviews it.
- Revoked node and assistant keys stay revoked after a restore.
- A starting node closes the last node's terminal server before it listens.
- During an update, the shell's bars and the map's controls stand clear of the header and of each other.
- Text typed on a phone goes in paced lines, and a failed text says where it stopped.

### Added

- The node image carries an Arabic font, so its browsers draw joined Arabic.
- Network join tickets are signed and work once.

### Changed

- A computer can run several test parts at once when its memory and cores fit their workers, with an optional upper limit in `MAX_RUNS_PER_HOST`.
- Test parts renew their time budget as they produce output or results. The node stops a silent part using its files' recorded times, or when the part reaches an explicit upper limit.
- A release commit that changes only the package versions and the release notes takes the passed test mark of the commit before it, so GitHub builds its images without running the whole test suite again.
- A plan's card in Subscriptions & API shows its settings and fallback plans across the whole card, numbers the fallback plans and shows each model's whole name, and keeps one filled button among its actions, with Remove set apart at the end.
- On a Russian screen, task stages carry Russian names.
- A silence alarm goes to an available fallback when the head of Operations is busy.

## [0.34.7] - 2026-11-19

### Fixed

- The + beside Tasks makes a task on every tracker page, Waits for me and My tasks included, and asks which department gets it.

### Changed

- The task list has no Goal column any more: the task takes two thirds of the line, and its goal shows on the task card.

## [0.34.6] - 2026-11-19

### Fixed

- The count beside Waits for me matches what the page shows under it, questions for the people you decide for and kept cards included.

## [0.34.5] - 2026-11-19

### Fixed

- Department cards, the head card, role frames and the hint show every word and grow taller instead of cutting text.

## [0.34.4] - 2026-11-19

### Fixed

- On a phone, the section tabs stay one even row of icons when their words do not fit, with the Tasks count on its icon.
- On a phone, the department's tools stand in one row of icons with Hire at the end, and its hint wraps instead of being cut.
- Development instructions keep the independent Security check before shared integration in every ability that can integrate changes.
- Development instructions keep release checks tied to the exact commit and record why test selection had to use a fallback.
- Review instructions tell reviewers to flag tests that cap the length of agent instructions or skills.
- Agents check the sender of quoted text and keep secrets out of messages and notes.
- Agent replies go through the channel that reaches the intended person or employee.
- Agents check shell paths before overwriting or deleting files and ask the CEO only for irreversible deletion.
- Questions include shared and per-option materials that people can inspect before answering.
- Agents record browser challenges and continue with other pages without bypassing the challenge.
- Agents track remote checks and delegated work as active work and wait only when a person needs to act.
- The watchdog alerts the department head when work can start and an eligible employee is free.
- The orchestrator uses department names from the screen, includes the default staff, and applies permitted staffing changes directly.
- Staffing instructions explain how Operations keeps its required roles and how eligible subscriptions are assigned.
- The orchestrator checks employee changes and leaves active work running when applying instruction edits.
- The orchestrator uses the owner's tools and verifies the result when changing company resources or fixing a blocker.
- The orchestrator routes small additions before the final check and lets the department release the exact checked commit.
- Operations templates assign access, recovery and shared changes to the people who can carry them out.
- Design and household templates adapt handoffs, reminders and checks to the work.
- Marketing, Sales and Business Development templates use the department's own terms and choose evidence for each decision.
- Finance and Support templates route decisions to the people responsible and describe what each check needs to prove.
- Development templates keep evidence tied to the checked version and distinguish product failures from faults in checks.
- Work templates keep running work visible and assign repairs and checks to the people who own them.
- Company templates explain who can act, when to ask a person and how to keep sign-ins private.
- Video production assigns the checks for each cut and adapts its rules to the look, length and destination in the brief.
- Tracking work tells the employee it depends on once and brings the task holder back at the next check or when that employee can no longer do the work.
- Routine company changes can go ahead directly, and agents can send a question to the person who can answer it.
- The orchestrator handles reversible merge choices, and only proposed permanent deletions appear among the CEO's requests.
- Agents ask for missing sign-ins through the vault, and one-shot workers and judges treat outside material as evidence.
- Tasks wait for a person's answer, while running work gets a scheduled progress check.
- Task handoffs and setup messages describe the actual checking route, release rules and staffing.
- Agents can page through their open tasks, and the company watchdog can inspect stalled work across departments.
- When a watchdog reads another department's task, the passwords, tokens and home folder paths in it stay hidden.
- Agents can give out work and ask necessary questions without a quota per turn.
- Pull requests from forks run without access to private runners or installer credentials.

### Added

- Set up a Video studio or add Video production to plan, make, finish and check videos. Marketing and Design use the same video production laws.
- Video production has a colorist and a sound designer who finish the whole video together before the final check.
- Video production offers a separate pipeline for films and series, with scenes made in parallel from shared references.

### Changed

- The task tracker follows its approved design again: one line per task, the design's columns, subtasks as a tree, the design's left panel, board and graph, and a task card that opens over the list.
- Goals have their own page in the tracker's left panel instead of cards above task lists.
- Everything you can create in the tracker opens from its + next to Tasks.
- Video briefs choose how shots are made, and the crew keeps usable drafts and recordings.
- Video directors own one story line, the shot plan, performances and the final cut.
- Video crews plan coverage, light and sound for the chosen look and keep continuity records that explain deliberate breaks.
- Video crews review each cut and play the exported master before delivery.
- Video crews compare the routes the company already has, recommend the cheapest that fits the brief, and record the chosen route and cost within each order's spending limit.
- Video operators follow each model's prompt guide and use accepted shots to compare tools.
- Design teams use approved references and model guides when generating pictures, recommend the cheapest fitting route and check the exact images at their intended size.
- The compatible assistant uses a generic name in People and in the documentation.
- Public examples use invented names and machines, and internal test records are removed from the source tree.

## [0.34.3] - 2026-11-19

### Fixed

- A machine check waiting for its slot, or running under one, no longer stops after five minutes with only the word "terminated".

### Changed

- Tests no longer fail for being slow: a test fails only on a wrong result, and a real hang is ended by the run's own limit.

## [0.34.2] - 2026-11-19

### Fixed

- Departments open on their staff schema again, with one-shot calls as diamonds in their stage cards.
- Tracker column headings keep their words whole instead of breaking them letter by letter.
- Goal cards show their progress bar across the card and the count on one line under it.

## [0.34.1] - 2026-11-18

### Fixed

- A Mac node checks a hook caller's owner with lsof and ps, answers a slow owner lookup with a retry, and logs why it refused a call.
- On a phone, the tracker's lists drawer reaches the right edge with no empty scrollbar room beside it.
- Tracker lists give task titles more room, task cards use smaller headings, department stages drop repeated links and use matching status wording, and pipeline names wrap beside their chevrons.
- The README animations show the current map, department routes, tracker, task cards and agent windows.
- Task list rows line up the subtask arrow, status and details with the first line of the title, and show the task number and wait note underneath.
- Task lists give titles more room by sizing the other columns to their content and using smaller text on desktop.
- On phones, task details stack under the title and long text wraps within the list.
- Removed computer access details from agent windows, including the orchestrator's window.
- The file link check no longer fails about one run in sixteen, because it now changes a character of the signature that always counts.
- Telegram sends only the finished answer and its files, in the language you write to the bot.

### Added

- The Media workflow captures the current map, Startup department, tracker list, task card and agent window at desktop and phone widths in light and dark.
- Departments open on their products, linked routes, permanent agents and one-shot call places, even before a model is set up.
- Starter kits and new templated departments start with every route, and the Startup kit includes its first product.

### Changed

- The company map shows only employee squares again, in their original status colors and with their usual blinking.
- The company map has no worker kinds legend.
- The department structure shows live squares for permanent agents and diamonds for one-shot calls, with names and plain descriptions.
- One-shot stages use diamonds in the tracker and task routes.
- Generalists use squares and keep their label.
- Task cards show the title, key facts and links to related tasks together at the top.
- The long task description opens with More when it is too long to show at once.
- The task log shows the latest four steps, including waits, and lets you open earlier steps.
- A question appears below the log when you can answer it from the card.
- The title menu holds task actions, details, materials and the full log.

## [0.34.0] - 2026-11-18

### Fixed

- Checks launched within a run part share its machine slot, cancelled parts clear their waiting checks, and a part that stops producing output or making progress alerts Operations once.
- When a node starts a new process and reconnects, its old process's check slots free up immediately.
- People listed one under another (in Russian on a wide screen, in every language on a phone) are as high in Chromium, Firefox and Safari: a name leaves no room under its line, and each label sits on the line of its value.
- Removing an employee ends its waiting turns and prevents new inbox turns; a program delivery with a missing target ends once instead of retrying forever, while temporary delivery failures still retry.
- Product test runs resend an unanswered environment description request after a minute or when its node reconnects, and a failed socket write stays retryable under the same request id.
- Looking up green test results uses an index on the release and one array of fingerprints; a failed lookup or description save reports the database transaction limit or a server failure instead of blaming the node's evidence.
- The orchestrator acts with the company owner's rights through named tools, the generic API and HTTP, in any turn and between turns.
- Permanently deleting a person records the CEO's yes for that person and resumes unfinished cleanup on retry.
- The orchestrator can see personal assistants and their conversations while each assistant takes orders from its person.
- The orchestrator can read and settle ordinary merge conflicts, and only a direct CEO choice can pick a permanent deletion.
- A department head can enable a skill that grants only department tracker work.
- The orchestrator receives machine setup commands and can read the same pending cards as the owner.
- Restoring a backup keeps permanently removed people and their assistants off the company lists and clears sign-in details that the backup still held.
- Assignment changes made by a department head show the head and the person whose authority it used.
- Editing an employee card preserves a tracker nudge that arrives during the edit.
- One-shot batches save the wake with their delivery claim so a failed write can be retried.
- Agent terminals, recordings, and output tails stay readable after vault calls, with only known secret values masked.
- Sensitive tool history shows the entry, site, and login with passwords and codes masked.
- A cancelled turn in the phone queue no longer delays lending to the next waiting turn.
- Tasks and goals keep their recorded responsible person if they close while responsibility is being passed on.
- A failed tracker upgrade notice no longer stops other hiring notices from being sent.
- Operator screens and replies hide short known credentials before they leave a node, using the same masking rules as the server.
- The tracker says what a task waits for, including the test run number when known, and the task card shows who set an external wait and when it is due to end.
- A person's waiting list shows only the tasks that need their answer, and the page title names the same person.
- Company phone checks wait until a phone is idle and run less often, so they do not interrupt an agent using the screen.
- Company phones stay awake with the screen set to its lowest manual brightness to save battery.
- Tracker screenshots can render at phone widths with the version footer hidden.
- The version and build appear in their own footer below every screen.
- Failed test and work runs keep the run number with its label and give the cause in plain language.
- The selected department uses the full sidebar row, and department, pipeline, and board card text wraps at spaces when possible.
- The board shows Failures and Stopped columns only when they have tasks and keeps each person's name together when it fits.
- In Turns and releases, each question button sits directly under its task's wait time.
- Wait lines name the person before the elapsed time and show only the time when the status already says the task waits for you.
- Task lists, boards, cards, and turns show who needs to act, what work is running, when a timer fires, and why work failed.
- The tracker counts failures separately and counts each task needing your answer once.
- Tracker boards keep all columns in one row when they fit and stack every column in order when space runs short.
- Pipeline board headings all start at the same edge, with the count after the name.
- The task lists panel sits against the start edge below app navigation and fills the available height.
- Tracker goal links get more room and underline on hover or keyboard focus.
- Long titles, names, and actions wrap inside tracker rows, cards, and turns at narrow widths.
- A part of a test run takes as many Vitest workers as the machine's free memory holds, at 2.5 GiB each, and the processors its load leaves free, so a machine short of memory no longer runs half its cores of workers into swap.
- A test run of a release goes out in as many parts as keep each within three quarters of its time limit by what its files took before, at once on free machines and one after another on one, so a run whose tests pass no longer runs into the limit with everything in one part; a part stopped at its limit no longer makes its machine look faster to the next plan.
- A department that keeps no repository gets no turn, and a turn whose department's work is all done or cancelled, with no result accepted into it and nothing in its branch that main lacks, closes by itself with no version and says why; a turn holding accepted work still closes only by its release.
- The `turns` tool lists a result accepted into a turn whose parent task is in no turn, such as a member of a coordination task.
- A program operator who answers No to a protected question, such as Claude Code's check before a removal, can report it as `denied`, as on a permission question; a `denied` report with no denial recorded says so plainly instead of refusing access to the case.
- A company phone shows "Phone not connected" as soon as its computer's adb stops listing it, or lists it unauthorized or offline, with a line on what to do: plug it in by USB, or turn on Wireless debugging and add it again with its address; Watch screen is off until it is back, and while its computer is offline. Agents see the same in `phones`, `phone_acquire` lends no such phone, and the phone is available again by itself once adb lists it.
- Right to left, the tracker keeps the order of a goal's name and of its progress in words, of a person's task in the left panel, and of each value with its name in a narrow list, "Executor: Hana".
- Right to left, every phrase of a goal's card, of Turns and releases with its list for later turns, and of the goal board keeps its order: a goal's name with its number, a task with its number, and each sentence with its full stop at its end.
- A goal's or a task's history never shows a name from the code for what changed: an edit it has no words for reads "Ivan changed the goal" or "Ivan changed the task".
- An update deletes an old copy of the database only once it has ended on a database that works, and never the copy it goes back to, whatever time the clock gave the others; a copy cut short by a restart no longer counts as one of the three it keeps.
- The public link's settings the updater kept beside the newest copy that has them stay after that copy goes, since a link taken on a build that went back may be in no other place.
- An employee on its program's Default model can hand in work and be chosen to check it: it counts as the model its program last ran on, which Codex turns now record too; a model with no known strength is still refused.
- A browser or password manager no longer fills the Hornhoof email and password into Add phone or any other form with a key, token or site password: the pairing code is a field for six digits, keys and tokens are masked text, and only Log in, an invite, Setup and the password question offer the saved Hornhoof sign-in.

### Added

- Every new department starts with a ready pipeline, and the orchestrator can add a different one or make it the default.
- The orchestrator offers to set up a ready pipeline for work such as video editing when someone first gets started.
- The orchestrator greets new people with practical offers for their starter kit, including Telegram and a personal assistant, and starts the work they pick.
- Everyone can write to the orchestrator from the company Telegram bot or through their personal assistant.
- Connected company phones have their working settings restored automatically, and Machines shows anything that still needs attention.
- People and agents can set task priority, which appears on the task card and orders tasks within each list group.
- The map uses squares for employees, diamonds for generalists and ghost outlines for one-shot calls, with a legend for all three.
- Declared one-shot stages show their places before a call begins and distinguish running calls from waiting calls.
- Every starter kit shows its one-shot places on the map before a subscription is connected.
- Owners of one-shot stages get guidance on briefing the calls and using their answers and the judge's verdict.
- Worker marks also appear in the department staff list, employee card and tracker, and the task route marks its one-shot stages.

### Changed

- Before you update: migration 0152 drops the 24 tables External messaging left in the database, every `outbound_*` table, `support_tickets`, `support_classifications` and every `model_check*` table, with their rows: mailbox sign-ins, contacts, letters, support tickets and checks made by a model. Take out what you still need first; the database copy the update saves before it migrates keeps them, and the machine keeps the last three such copies. No other table changes.
- Connected machines give the orchestrator standing computer access, including machines that already hold their owner's key.
- The orchestrator can give computer access to all company employees or to a named employee for a task and withdraw it when the work ends.
- Each machine owner can close or reopen computer access from the machine card.
- The update clears old computer access requests and removes the approval cards.
- Restoring a backup keeps each owner's machine access setting and clears employee grants.
- Server task and conversation modules have explicit dependency boundaries, with a check that prevents circular imports.
- Raw task evidence is kept in task attachments, browser captures stay in test output, and the module inventory names its release and how to reproduce it.
- Work needs no approval when its department has set no rule, including commits, spending and new kinds of work.
- Main acceptance and releases follow the department's commit rule and keep the checks on the exact commit.
- Department heads can change autonomous release for the people they answer to, and the orchestrator can change it for the owner.
- The approval and release guides explain when to ask and which checks prove the exact commit.
- Employees can save full assignments, skill overrides and notebook notes, and agent cards no longer show an instruction budget.
- Turns carry the full instructions and notebook, with skills delivered as files.
- Employees can send messages and file improvements throughout a turn.
- People can send distinct feedback without a personal hourly quota, and retries do not count the same submission twice.
- One-shot calls and their judges run until they finish or are stopped, unless the caller sets a time limit.
- Home device helpers carry out reversible cleanup and settings changes allowed by the household rules.
- The task list shows compact rows with links to goals and collapsible status groups, with an add button where the department can take tasks.
- Task rows show what they wait for and which tasks from other departments need them.
- Task lists distinguish status, priority, people, departments and executor programs by shape and color.
- The task sidebar shows company people and wait counts, with shortcuts to due dates, department goals and work outside a pipeline.
- The tracker puts the current place, person picker and search in one header, followed by views and compact filters.
- The tracker can show tasks by due date and department goals, and new tasks on a pipeline keep that pipeline.
- Expand a task from the arrow next to its title to see its subtasks in the same list columns.
- On narrow screens, tracker rows stack their facts and show the full names behind the initials.
- New tasks in every department follow routes with one-shot stages, and Review and Security in Development each use three calls and a judge; tasks created earlier keep their route.
- Status and pipeline boards use more compact cards, with smaller titles and details and more room for the question button label.
- Skills no longer hold the company's own work for a person: agents sign in and sign up themselves with the vault, publishing and sending wait for nobody, the orchestrator gives access, subscriptions and machines to whoever asked and may approve an exact commit for the owner, and a department's own people decide its outbound work and its design system. Only paying, signing and deleting for good wait for a person.
- A new agent program or one-shot call waits only after its machine's system killed a program for want of memory, until a report without one; Hornhoof's own memory and processor thresholds for agents are gone, and the machine's card and the agent's window say so in one line.
- Nodes take turns from 0.5.0 on, and every node gets an agent's skills as files.
- The node's provider and terminal code no longer load each other in a ring: each provider owns how its program runs in a terminal, and people's terminal views and a session's privacy have their own modules outside the terminal host.

## [0.32.1] - 2026-11-17

### Fixed

- The tracker in the light skin draws a chosen card, a chosen node and a node under the pointer with a border people can see; a due day reads day before month right to left; a side panel gives its words the same width in Chromium, Firefox and Safari; and a link of two letters is 44 px wide to press.
- Employees on gpt-6.2-sol or gpt-6.2-astra can hand in their work and be chosen to check others' work, as on gpt-6.1-sol and gpt-6-astra.
- A test run of a release keeps the results of tests a change does not reach: a script that belongs to no suite, as the updater's, ties the tests that use it to its own folder instead of the whole repository, and a log file counts as data.

## [0.32.0] - 2026-11-17

### Fixed

- The mutation suite judges a mutant by test counts that read the same whether or not an AI agent runs it, so a test that quotes a runner error no longer reads as a failed baseline on Hornhoof's test machines. This release went out before that check was run again on them; every other part of its whole test run passed.
- `message_employee` counts an employee's recent messages through an index instead of reading every one of them.
- No false "assignment words not recorded" case while a program runs a tool with those words in it.
- A program operator case whose question went away by itself closes on its own and reaches nobody; the operator reports `cleared` for a program back at work, and a report on a case already closed says how it closed.
- A parent task closes once every child is done or cancelled, also a child closed by hand in the database; its report names the children closed without an accepted result.
- A department whose repository had no version tag yet closes its turn on its first release tag, such as v1.4.0 or v2026.11.0, and each repository goes on from its own last tag, whatever the version of Hornhoof or of another department.
- When main was tagged by hand with no recorded release, a refused result says why the turn is still open and which step unblocks it.
- An update that waits for the agents to finish survives a restart or a change of leader, and always ends with the update or a reason it was called off: by a person, or because Hornhoof could not pass it on.
- An agent's tools secret no longer appears on a program's command line, where any process of its machine could read it.
- Drawing a program's screen for the operator no longer holds up the server; a picture that cannot be drawn answers "Look again".
- Vault passwords an operator types into a program are masked on its screen and in the log.
- The Machines screen no longer brings back a cancelled command, or drops a new one, when a look that began before the change arrives late.
- A later test run of a release reuses only the green results of that same release, so no file is green that the release did not prove, and `release_turn` takes only a whole run of the product's tests that its department or the orchestrator asked for.
- At Tests, a candidate can take in the open turn of its own department as it takes in main.
- A node installs an agent program again, at most twice, when it does not start after an install or an update, and the machine says so or shows the last line the program said.
- An update that comes while a node still checks a program waits for that check and then installs.
- A plan's sign-in note says why a sign-in ended early, with the program's exit code and last line.
- A check whose machine check slot ends stops with all of its processes before the slot goes to the next check, and fails with 128 plus the signal instead of passing.
- Letters taken into an agent's turn that failed go back to its inbox unread, unless its program had already worked in that turn.
- Every employee reaches the orchestrator with `message_employee`, with no false `recipient_unknown`, and a message to a person's own assistant is refused with that reason and a word to write to the orchestrator.
- A message about a task closed moments ago is delivered, naming the task and waking no work on it, instead of being refused with `task_invalid`.
- A turn that ends before its program starts holds the agent's next turns in one case for the program operator instead of failing them one after another, and a node that cannot write its work folder takes no turns until a write works again.

### Added

- The orchestrator has a `shell` tool that runs any command in the server's own container.
- The orchestrator's `database` tool runs as Hornhoof itself: it reads and changes every table, every column and the schema.
- The orchestrator closes any task in any state, done or cancelled with a reason, with `close_task` or `POST /api/tasks/:id/close`; open work under it is cancelled, and closing it as done accepts no result.
- Goals split into department goals and smaller goals, each with a why, a person who answers for it, a date and a target; progress comes from the target or from the tasks done under it.
- Every task has one person who answers for it, a short why and a due date; when that person leaves, their open tasks and goals pass to the one who decides for the department.
- Every status change of a task is kept, and its card shows how long it stands, how long it was worked on and whom it waits for.
- Department pipelines map who hands work to whom in stages owned by a role or an employee; a task stands in the stage of whoever holds it.
- The Tasks tab is a tracker: the person's own work first, the same work as a list, a board and a graph, one card for tasks and goals, and "View as" for the CEO and the CEO's delegate.
- Every department and company template has a product manager who keeps titles, whys, goals, the people who answer and pipelines clear, and never gives out or moves work.
- Agents read `goals`, set goals and pipelines with `set_goal` and `set_pipeline`, a product manager tidies a task of its department with `tidy_task`, and task tools take a goal, the person who answers, why, due date, pipeline and stage.
- People's routes for goals and pipelines, `PATCH /api/tasks/:id` on the task's version, `GET /api/tasks?responsible=`, and `parent` in `POST /api/tasks`.
- Secrets in saved text, such as labelled passwords, private keys, passwords in links and known token formats, are stored as [hidden], and machine join codes stay out of saved conversations.
- Hide secret on a task replaces a selected value of 8 characters or more with [hidden] in every stored copy of the company, for the CEO, the CEO's delegate and people who run the task's department.
- Each machine's card in Machines opens access to the orchestrator or to every agent of the company for 1 hour, 8 hours or a day, after a separate confirmation for every agent, says who opened it and until when, and closes it; access ends by itself, personal assistants get none, and an agent's window keeps only its terminals, with its notes stacked at its foot.
- The CEO deletes a person or an assistant from People for good: their sessions, keys, machines and personal plans end, and old tasks still name them.
- Any agent starts one-shot calls of its program, as many at once as the machine's memory holds, and hears every answer once; a route can mark a stage one-shot with a fan-out and a judge, and the calls show on the map and in the task's history.
- Agents send and read their department's mail from their own machine with the new ability Mail from your machine, and mark each step in the department's git.
- The orchestrator and every head get the ability Ways of working, which says when work goes to standing employees, a turnkey member, the department's route of stages or one-shot calls, and when to send a person to their assistant or call on the program operator.
- A head can set the owner of a later stage of a task in advance with `echelonStage` in `update_task`; when an employee is removed, its later stages pass to another eligible employee, and the head hears of any stage left with nobody.
- A test or work run that waits for a machine says which run holds the machine's check slot and which runs are ahead of it.
- The program operator is called to a thinking program whose screen stood still for three minutes, and passes the program's own windows, such as a poll, a folder's trust, an update, a full context or a sign-in from the vault, as the agent's owner would.
- On a Linux machine, an agent's TypeScript, Vitest, ESLint, Jest and Playwright runs wait their turn for the machine's check slot and then run in the agent's own shell; with no slot to be had they run at once.
- Machines shows "Checks paused" with the reason while a stopped check's processes do not end, and new checks wait until they are gone.
- Before an agent's turn, its machine removes the agent's git worktrees of done or cancelled tasks, so their dependencies no longer fill the disk. A worktree stays while it has changes that are not committed or commits that are not on the remote, and the machine's log says why.

### Changed

- Before you update: put each department's mailbox sign-ins into the vault and its letters and recipient lists into its git, as External messaging is gone (its tables stay in the database).
- External messaging is removed: agents write to people themselves, from a department mailbox or through the company's phones, and mark each step in the department's git.
- Only an irreversible deletion waits for the CEO's yes; a message, a price or a publication asks nobody unless the department sets its own rule.
- A head runs its own department in any turn with the rights of whoever runs it, its named owner or else the CEO, with no fresh word from a person; a spend or other work with no rule of its own asks only for a kind nobody approved yet.
- An employee's card history names the head that made a change and on whose authority.
- The orchestrator is refused nothing: it sets up assistants, sends files, and reaches plans and computer events like the owner.
- Security and code review never count what the orchestrator can see or do as a finding.
- The orchestrator's prompt and the setup screen say plainly that it can do anything and change its own system.
- `release_turn` takes any commit of the turn branch with its own green whole run, so the branch keeps taking work during a release; what came after that commit goes into the next turn.
- Turnkey work joins the turn branch as soon as its holder finishes it, and autonomous release counts the holder's own review, security check and tests as covering it.
- Agents give the proof of their checks in `submit` or `report`, and commit no raw logs and no commit that only records proof or a note.
- `release_turn` names the version tag of the department's own repository that the next version follows, and a version scheme tied to turn numbers belongs only to the repository it was approved for.
- Agents' commits never name Claude as co-author, and the release check stops a commit that does before it reaches a turn or main.
- Agents write a path they delete as "${VAR:?}" or literally, so Claude Code's own check does not stop the command for a person's approval.
- The README shows release 0.32.0, with moving pictures of the tracker, one-shot calls and skins, and the ways of working with an example each.
- The old board of the Tasks tab and a department's own task list are gone; "Department tasks" opens the tracker at that department.
- A company or department notebook takes any number of notes and characters; each note is still 300 characters at most, and an agent's instructions carry as much of the notebook as its program reads and say where they cut it.
- An agent's waiting messages and its unread inbox come to it in one turn, and turns that waited for a busy machine go as soon as it has room for them.
- A new program counts half a gigabyte of a machine's memory instead of a gigabyte, as agents' heavy checks now run one after another.
- Migration 0138 adds goals, pipelines and the tracker's task fields; on first start the server names who answers for every open task and hires one product manager into each top-level department.
- Migrations 0137 and 0139 to 0144 come with this release and convert nothing old: an index for counting messages, and the tables and columns of kept update waits, removed people, one-shot calls, machine access for all agents, hidden secrets and who changed an employee.

## [0.31.0] - 2026-11-17

### Fixed

- The first result of a new turn is no longer refused because its `turn-N` branch was missing; the server makes it.
- A program with no screen no longer raises false `node_silent` alarms while its turn is working.
- An update no longer cuts short a turn that streams its work without a screen.
- A held turn whose program is gone ends as interrupted, and the next turn goes out.
- No more false "assignment words not recorded" cases when Claude Code starts a turn for its own notice.
- Releasing a hold calls a program busy exactly when `program_screen` does.
- A machine taken off the company's checks no longer lends its built-in node to test and work runs.
- Feedback, Machines and the line about where Hornhoof runs no longer break when a page reloads during a read.
- The glow and focus ring of a card follow its cut corner, with no dark triangle there.
- The map's zoom label, such as 115%, is no longer cut off.
- Kimi attaches task files through its node when its turn has no local token.
- A database copy's first sync survives a slow link, and its drops no longer wait on the leader.
- The leader frees at its next sweep the slots and origins of tables whose first copy broke off.
- No test harness build is taken from the built-in node of a machine taken off the company's checks.
- External messaging is a button on the department screen, where whoever runs its messaging finds the channels.
- The machine next to install the server's build takes no new work, so what runs there ends and it installs.
- The orchestrator and the heads get onto a node whose updater went away before stopping it, within 3 minutes.
- `program_screen` shows a busy employee's program from its running turn, without a false `no_program`.
- The reason `outbound_changed` reads in plain words, in English and Russian, like the server's other reasons.
- A test run whose parts have all ended closes after a server restart, and the minute check closes runs left open.
- `message_employee` no longer says a message did not reach an employee whose turn could not go out at once.
- A program's idle connection to its node's bridge lasts 72 s, so tool calls no longer break with ECONNRESET.
- External messaging keeps each sentence in its own direction in right-to-left languages.
- A node that waits for an update takes no new turns, so it updates as soon as the turns it runs end.
- A session between machines stays open while bytes arrive and ends after 30 s of silence, so slow links keep copies.
- A program that slept starts again for the next turn instead of waiting on turns from its old log.
- Right-to-left: isolated phrases follow their block's alignment, and short sentences keep their period at the end.
- An agent still gets a phone screen's elements when its picture is too large to send.
- `npm run deps` and the author check install again when `node_modules` came from another lockfile.
- A closed operator case no longer fails a turn whose program took later words, so a working program keeps its turn.
- The map's agent count reads as one phrase right to left, and on a phone its hint stands above the bottom buttons.
- An address whose consent was taken back says it gets no more messages, and the heading counts only consent in force.
- Tests owners can repair test files or return source fixes without cancelling the task.
- A Tests owner's repair is taken on the candidate's own base, without a new main or a full run's ids.
- Vault values an agent uses stay out of turn records, replays, terminal recordings and phone runs.
- A program's hooks are accepted from its own terminal even when the shell that sent them lost its parent.
- A failed tmux lookup makes a program's hooks retry instead of refusing them for good.
- A Claude, Codex, Kimi or Antigravity turn whose end was lost ends when its finished answer stays for two minutes.
- Kimi's changing toolbar tips no longer restart the watch of an unchanged finished answer.
- A job whose program exited and whose result was lost fails after two minutes, and its queue goes on.
- An operator who looked at a program can still type within 30 seconds while Hornhoof looks at it too.
- The orchestrator's SQL no longer reads secret tool answers, assistant event payloads or delivery addresses.
- `send_telegram_file` sends only a file its agent may read, found by its exact id and never by its name.
- After a node restarts, only the program it started anew counts as active, not the ones from before.
- A window opened as a node restarts no longer pushes the agent's program out of its pane, so its hooks are accepted.
- Percentages on Machines and plans use the text font, so the percent sign no longer reads like a slash and a dot.
- Right to left, plan limits keep each phrase and number with its unit whole, and the trust stripe starts the line.
- A head's answer to a question no longer shows "decided by the orchestrator".
- A forged internal header with multibyte characters gets 401 instead of a server error.
- An interrupted `hh-fetch` download keeps the earlier file whole and writes the new one only once it is complete.
- A file upload stops once it passes the remaining quota instead of being read in full, and leaves no partial file.

### Added

- The orchestrator reads and marks any employee's inbox, with a reason that goes into the employee's log.
- The CEO and the CEO's delegate mark any employee's letters with `POST /api/agents/:id/inbox/mark`.
- `failures` shows `next` for each blocked task, taken from its holder's last report.
- Employees download the files of any company task with `hh-fetch`, but never a personal assistant's.
- A task's allowed paths can be globs, and test files and folders are always allowed beside them.
- An employee on a personal plan at its limit goes on to a fallback plan with room, and back after the reset.
- An employee's card shows its fallback plan, and a person sets the order of a plan's fallback plans.
- A personal assistant sends agents files of any type with `POST /api/assistant/files` and a message's `files`.
- A `reply` to an assistant carries the files the agent attached, and the assistant downloads any file its owner sees.
- Settings, Passwords keeps the company's site sign-ins, each with its login, password and one-time code.
- Agents take a sign-in with `vault_entry`, which gives the current one-time code, and save one with `vault_save`.
- A catalog revision opens whole, as a message would read, with its changes from the one in use marked word by word.
- Company phones: an owner lends an Android phone to the company's assistants through Wireless debugging.
- An owner watches a lent phone's live screen and takes it back with Stop; a task keeps its phone recordings.
- Each channel of a department to its contacts takes an address, with the person's consent to its purpose.
- Who runs a department sees its channels' addresses and takes back consent on the web, logged without the address.
- Each file in a `reply` comes with a link its owner opens on a phone for 7 days, with no sign-in.
- Agents and assistants give files of any size; one over 50 MB stays 30 days on the disk of the machine that took it.
- Such a file is outside copies and backups and is lost with its machine; the task card and the chat say so by name.
- The orchestrator finds and calls any Hornhoof tool with `find_tool` and `use_tool`, and any route with `api`.
- An agent on a lent phone presses Back and Home and types any text, Russian, emoji and new lines too.
- A node uses a phone plugged by cable into its machine, through a socket its administrator puts in the phone folder.
- The orchestrator searches and reads the source and logs of the very Hornhoof build that runs.
- A node's record (`update_wait_since`), Machines and Versions say since when it waits for an update.
- `create_task` takes an `architectAgentId` that names the task's architect.

### Changed

- A machine its owner opened stays open to the orchestrator in all its turns while access lasts, not just one.
- Commands on a machine are refused when the turn's last words come from someone without rights or unknown.
- A message to a busy or reconnecting employee waits for its next turn instead of being lost.
- A message that cannot be delivered names a reason code, the recipient and the task.
- Personal assistants are hidden from Operations' SQL reads and from the program operator.
- The full release check runs in two to four parts of up to an hour each.
- Release test profiles also reuse green results proved at commits main already holds.
- A full machine of the company keeps its place whatever its memory, free disk or disk speed.
- Machines always says why a machine has no place.
- A machine's card stands in three blocks, and its connection history reads as plain lines.
- Install commands read left to right in any language, and their flags never break.
- Machines filters start with All and a count, with chips of at least 44 px.
- Table headers and row buttons are 44 px in every table.
- A field you must correct has a pink frame, and the Feedback title error clears as you type.
- Subscriptions show how each is paid as a sign by its short name, with the orchestrator under it.
- Token counts and the names of token tiles stay in one piece and read left to right in any language.
- The assistant API is contract 3: `byOwnAgent` in `reply` and `reply_end` says whether its own agent sent it.
- `run_tests` runs only on `main`, `turn-N` and `release-` branches; others get `tests_not_release` with the reason.
- A release's first run runs every test and later runs only what failed or changed; Tests and reviewers check locally.
- Publishing or taking back a catalog revision acts only on the revision the person was shown.
- A refusal tells an assistant's owner why in plain words, in Russian or English as `Accept-Language` asks.
- Agents answer an assistant as one person to another, and its own agent says plainly when a file did not arrive.
- A node's wait for an update never gives up, and leaders no longer enter a waiting node after three minutes.
- `NODE_DRAIN_MS` and `NODE_UPDATE_RETRY_MS` are gone.
- Type checks run TypeScript 7, several times faster; the `typescript` package stays 5.9 for its API.
- A turnkey task's independent parts run in parallel with the program's helpers, and heavy checks run one at a time.
- `hh-attach` and `hh-fetch` pass a file through the node as it is read, so a big file needs the new node.
- The orchestrator acting for the owner is refused nothing the CEO or an employee may do; heads keep their limits.
- Department messaging lists a channel's addresses apart from its buttons, under a heading that counts them.
- An agent sees each phone screen as a JPEG of at most 1568 px, so a screen with a photo reaches it whole.
- The orchestrator's `api` reads every page `view` did, and `view` is gone.
- The orchestrator's SQL reads every table and every column except keys; its write rights do not change.
- A decision the orchestrator takes as the owner shows "decided by the orchestrator" in the task's questions and log.
- The build's types and release checks get 4096 MB of memory instead of 2048, so they no longer run out of it.
- Tasks skip redundant handoffs while keeping required Security checks and candidate history.

## [0.29.2] - 2026-11-16

The orchestrator does everything in the company in any turn, as its owner, and limits a company wants are written in
its notebook: what is not forbidden is allowed. It also connects one more mail account to a channel with the settings of
an account the company has, so no password passes through it.

### Changed

- The orchestrator took a decision only for the person its turn answered: after an employee's message, a notice of
  Hornhoof or a person who runs one department, it could not write to the database, change people, resources, cards,
  approvals, wait dates or channels, and asked for a confirmation instead. Now it goes as the CEO or the CEO delegate who
  wrote into its turn, or else as the company's owner, whoever asked. Machines keep their own rule: a command runs only
  where the machine's owner opened it. A department's head is unchanged. Known limits: a decision the orchestrator takes
  as the owner names the owner in the task's log, not the person or employee who asked; only a company with no active
  owner still waits for the CEO's word.
- The skills of the orchestrator and the notebook say so: limits are written in the company's notebook, and the rest is
  done without asking anyone to confirm it.

### Added

- outbound_account_add connects one more mail account to a channel with the settings of an account the company already
  has, sending from its own address, like news@ next to hello@; the settings go from one account to the other inside
  Hornhoof and never through a model. outbound_account_bind makes an employee the one who writes from an account. Both
  are the orchestrator's; a new password or another server a person still gives on the channel's screen.

### Russian

Оркестратор делает в компании все в любом ходе, как ее владелец, а ограничения компания пишет в своем блокноте: что не
запрещено, то разрешено. Еще он подключает к каналу рассылки новый почтовый ящик с настройками ящика, который у
компании уже есть, и пароль через него не проходит.

- Оркестратор принимал решение только за того человека, кому отвечал его ход: после сообщения сотрудника, уведомления
  Hornhoof или человека, который ведет один отдел, он не мог писать в базу, менять людей, ресурсы, карточки, правила
  согласований, сроки ожидания и каналы и вместо этого просил подтверждения. Теперь он действует как CEO или
  заместитель CEO, если тот писал в ход, а иначе как владелец компании, кто бы ни попросил. У машин свое правило:
  команда идет только там, где владелец машины ее открыл. Руководители отделов работают как раньше. Известные пределы:
  в журнале задачи решение, принятое как владелец, записано за владельцем, а не за тем, кто попросил; только компания
  без действующего владельца по-прежнему ждет слова CEO.
- Навыки оркестратора и блокнота говорят то же: ограничения записаны в блокноте компании, остальное делается без
  просьб о подтверждении.
- outbound_account_add подключает к каналу еще один почтовый ящик с настройками ящика, который у компании уже есть, со
  своим адресом отправителя, например news@ рядом с hello@; настройки переходят из ящика в ящик внутри Hornhoof и не
  проходят через модель. outbound_account_bind назначает сотрудника, который пишет с ящика. Оба инструмента у
  оркестратора; новый пароль или другой сервер по-прежнему вводит человек на экране канала.

## [0.29.1] - 2026-11-16

A program no longer closes under a turn it has just begun, an update that waits for the agents no longer stops the
company's work without end, a machine that alone can lead keeps its lease when its disk writes slowly, a copy no longer
fills the server's replication slots after an update, a node's updater keeps its wait while the server is away for a
moment, and parts of test runs no longer stop when a machine's connection drops for a moment.

### Before you update

- Migration 0129 comes with this release. It lets `node_id` of `node_connections` be empty, so the connections of a
  machine's built-in node can go into its connection history. It is one change of the table, it changes no rows, and
  nothing needs doing before or after the update.

### Changed

- The server log now names a machine's built-in node by the machine it runs on, as in machine "home-api", node
  "builtin", instead of machine "built-in". A built-in node of a server with no machine of a company is still named
  machine "built-in", node "builtin".

### Fixed

- A node could close or put to sleep an agent's program at the moment the program began a new turn: Codex takes the
  words it held once its turn is over, and Kimi Code takes the words it queued and tells of them through its hook late.
  The turn then stood running with no program, the agent's next turns waited behind it and live words found no
  program, until a person stopped it, as the programs of Operations on a Mac showed on 15 and 16 November. The node now
  looks for a new turn right before it closes a program or puts it to sleep and keeps a program that began one, and a
  turn that opens on a program already asleep ends as one whose program is gone, so the next turn starts the program
  again in its session.
- An update asked for when the agents finish held every new turn of the company until no agent worked, and a turn whose
  machine had stopped reporting never let it go. A turn whose node said nothing of its program for ten minutes is no
  longer waited for, and the wait has a deadline: 30 minutes, or `idleWaitMinutes` from 1 to 240. If the agents have
  not finished by then, the update is called off: nothing running stops, the turns start again, and the orchestrator
  and the update banner say why. The banner, the answer to the request and `check_updates` name the turns the update
  waits for and until when. Known limits: right after a server restart a long turn counts from its start until its node
  reports again; only agents' turns can be lost, so other running work still holds the wait; and the wait lives in the
  server's memory, so a restart drops it and the update has to be asked for again.
- A part of a test run stopped with "Machine check queue lease was lost." when its machine's connection dropped for a
  moment, or when the server handled the machine's reports late. A machine now keeps its check slots for 90 seconds
  after a drop and takes them back once it returns, and its parts go on; the server counts a machine as present while
  anything it sends arrives. A machine silent for 90 seconds still loses its slots, and a part run again on another
  machine takes no result from the first one. The connections of each machine's built-in node now go into the
  connection history with no node of their own. Known limits: a machine back between 90 seconds and 3 minutes reports
  its part as failed, and the part does not run again; after a server restart the slots still end and their parts stop;
  a node and a server of different versions get no slot back after a drop, and an older node's slot stays taken for up
  to 3 minutes; the machine's connection screen does not show the built-in node yet.
- A machine that is the only one able to lead (no other copy has finished) no longer ends its own lease, the app's
  sessions and the public link for 20 to 30 s when its disk writes slowly: a late tick ends nothing there, and its link
  keeps running when a lease ends. The keeper's statements now wait twice the measured fsync p99 (2 to 5 s), and where
  another finished copy could lead, a tick may come three times that late (6 to 9 s) before the lease ends. Known
  limits: a renewal that cannot be written for a whole lease (10 s) still ends the lease and the sessions; the disk's
  p99 is known about 3.5 minutes after the keeper starts, and until then the old 2 s and 6 s apply.
- A machine that keeps a copy and was still taking its first copy when the company server updated with a new column (as
  autonomous_release in 0.29.0) no longer goes round in a circle and fills the server's replication slots. It takes the
  server's new schema before it follows, an attempt it gives up drops its slots on the server, and attempts given up in
  a row wait longer each time, from 10 minutes up to 2 hours. Known limits: with the server out of reach at that moment,
  the slot is left to the server's own cleanup, as before. A copy that was already whole is still made again after an
  update with migrations.
- The node updater keeps a node's place in its wait when the server is away for a moment: only a Hornhoof server's own
  404 means a server from before node waits; any other answer is retried after 1, 2, 4, 8, 16 and then every 30 seconds,
  for 5 minutes. A node is marked restarting only once an updater is told it is free, so a restart that never came no
  longer keeps the orchestrator and the heads off their node for 10 minutes: they come back past their 3-minute limit,
  and the hold ends with the 2-minute lease of a wait. Known limits: a restart the updater was told of but never began
  still holds the node up to 10 minutes; a restarting wait saved by an earlier build keeps its 10 minutes once.
- A machine took every turn sent into a program that already ran there, however loaded it was: on 16 November seven
  employees tested and ran browsers at once on a machine of 8 processors and 12 GB, it ran out of memory and swap, and
  each of their turns took hours. An employee's turn now waits while its machine works past what it carries, with less
  free memory than one more program needs or a load over the last minute above one and a half times its processors, and
  goes on by itself once the machine has room. The turns that waited go one with each report of the machine, every 20
  seconds, so they do not fall on it at once. Nothing that runs is stopped, a machine where no turn runs takes one all
  the same, and the orchestrator's and the heads' turns go on. The agent's window says the machine is busy.

### Russian

Программа больше не закрывается под ходом, который она только что начала, обновление, ждущее агентов, больше не
останавливает работу компании без конца, машина, которая одна может быть лидером, держит аренду при медленном диске,
копия после обновления сервера больше не забивает его слоты репликации, обновлятор узла держит ожидание, пока сервер на
миг недоступен, а части тестовых прогонов больше не обрываются, когда связь машины на миг пропадает.

- Перед обновлением: в выпуске миграция 0129. Она разрешает пустой `node_id` в `node_connections`, чтобы подключения
  встроенного узла машины попадали в ее историю подключений. Это одно изменение таблицы, строки она не меняет, и ни до,
  ни после обновления ничего делать не нужно.
- Журнал сервера теперь называет встроенный узел машины по машине, на которой он работает, например machine
  "home-api", node "builtin", а не machine "built-in". Встроенный узел сервера без машины компании по-прежнему
  называется machine "built-in", node "builtin".
- Узел мог закрыть программу агента или усыпить ее в тот самый миг, когда она начинала новый ход: Codex берет слова,
  которые придержал, когда его ход закончен, а Kimi Code берет слова из своей очереди и сообщает о них через хук с
  опозданием. Тогда ход висел running без программы, следующие ходы агента ждали за ним, а живые слова не находили
  программу, пока человек его не останавливал; так было у программ Операций на Mac 15 и 16 ноября. Теперь узел прямо
  перед тем, как закрыть или усыпить программу, проверяет, не начался ли новый ход, и оставляет программу, которая его
  начала, а ход, открывшийся у уже спящей программы, завершается как ход без программы, и следующий ход снова запускает
  программу в ее сеансе.
- Обновление, которое попросили провести, когда агенты закончат, держало каждый новый ход компании, пока не замрет
  последний агент, а ход, машина которого перестала отчитываться, не отпускал его никогда. Ход, узел которого десять
  минут ничего не сообщал о своей программе, больше не ждут, а у ожидания есть срок: 30 минут или `idleWaitMinutes` от
  1 до 240. Если агенты к этому сроку не закончили, обновление отменяется: ничего из идущего не останавливается, ходы
  снова запускаются, а оркестратор и баннер обновления говорят почему. Баннер, ответ на запрос и `check_updates`
  называют ходы, которых ждет обновление, и до какого времени. Известные пределы: сразу после перезапуска сервера
  долгий ход считается с его начала, пока его узел снова не отчитается; потерянными могут быть только ходы агентов,
  поэтому другая идущая работа по-прежнему держит ожидание; ожидание живет в памяти сервера, поэтому перезапуск его
  сбрасывает, и обновление нужно попросить снова.
- Часть тестового прогона обрывалась с «Machine check queue lease was lost.», когда связь ее машины на миг пропадала
  или сервер поздно обрабатывал отчеты машины. Теперь машина держит свои места для проверок 90 секунд после обрыва и
  забирает их обратно, как только вернется, а ее части идут дальше; сервер считает машину на месте, пока от нее
  приходит что угодно. Машина, молчащая 90 секунд, по-прежнему теряет свои места, а часть, запущенная заново на другой
  машине, не берет результата у первой. Подключения встроенного узла каждой машины теперь попадают в историю
  подключений без своего узла. Известные пределы: машина, вернувшаяся позже 90 секунд, но раньше 3 минут, сообщает о
  своей части как о проваленной, и часть заново не запускается; после перезапуска сервера места все равно кончаются, и
  их части останавливаются; узел и сервер разных версий после обрыва места обратно не получают, а место старого узла
  остается занятым до 3 минут; экран подключений машины встроенный узел пока не показывает.
- Машина, которая одна может быть лидером (других готовых копий нет), больше не заканчивает свою аренду, не обрывает
  сеансы приложения и не снимает публичную ссылку на 20-30 с, когда ее диск медленно пишет: поздний тик там ничего не
  заканчивает, а ссылка работает и после конца аренды. Запросы хранителя теперь ждут вдвое дольше измеренного fsync p99
  (от 2 до 5 с), а если вести может другая готовая копия, тик может опоздать втрое против этого срока (от 6 до 9 с),
  прежде чем аренда закончится. Известные пределы: если продление не удается записать за всю аренду (10 с), аренда и
  сеансы все равно заканчиваются; p99 диска известен примерно через 3,5 минуты после старта хранителя, до этого
  действуют прежние 2 с и 6 с.
- Машина с копией, которая еще снимала первую копию, когда сервер компании обновился с новым столбцом (как
  autonomous_release в 0.29.0), больше не ходит по кругу и не забивает слоты репликации на сервере. Она берет новую
  схему сервера до того, как следовать за ним, брошенная попытка убирает свои слоты на сервере, а попытки подряд ждут
  все дольше, от 10 минут до 2 часов. Известные пределы: если сервер в этот момент недоступен, слот убирает сам сервер,
  как и раньше. Целая копия после обновления с миграциями по-прежнему делается заново.
- Обновлятор узла держит место узла в ожидании, когда сервер на миг недоступен: старым сервер считается только по
  собственному ответу 404 Hornhoof, а любой другой ответ обновлятор повторяет через 1, 2, 4, 8, 16 и затем каждые 30
  секунд, всего 5 минут. Узел помечается restarting только когда обновлятору сказано, что он свободен, поэтому
  несостоявшийся перезапуск больше не держит оркестратора и глав вне их узла 10 минут: они возвращаются после своего
  предела в 3 минуты, а ожидание снимается по 2-минутной аренде. Известные пределы: перезапуск, о котором обновлятору
  сказали, но который не начался, по-прежнему держит узел до 10 минут; ожидание restarting, сохраненное прежней сборкой,
  один раз держит свои 10 минут.
- Машина брала каждый ход в уже запущенную на ней программу, как бы она ни была загружена: 16 ноября семь сотрудников
  одновременно гоняли тесты и браузеры на машине с 8 процессорами и 12 ГБ, у нее кончились память и своп, и каждый их
  ход шел часами. Теперь ход сотрудника ждет, пока машина работает сверх своих сил, то есть свободной памяти у нее
  меньше, чем нужно еще одной программе, или нагрузка за последнюю минуту выше полутора на каждый процессор, и
  продолжается сам, когда место освобождается. Дождавшиеся ходы идут по одному с каждым отчетом машины, раз в 20 секунд,
  чтобы не навалиться разом. Ничего из идущего не останавливается, машина, на которой не идет ни одного хода, все равно
  берет один, а ходы оркестратора и глав идут как раньше. Окно агента говорит, что машина загружена.

## [0.29.0] - 2026-11-15

A department runs its own outbound messages and its own work without the CEO, Settings is one window in four groups
behind a short account menu, and status words in tables no longer break letter by letter.

### Before you update

- Migrations 0127 and 0128 come with this release. 0127 adds an empty table `outbound_setup_events`, the log of who set
  up a department's messages. 0128 moves autonomous release from the company to each department: every department
  starts with it off, and the company's switch is removed. Before you update a server, check whether the company had
  it on with `SELECT autonomous_release FROM companies;`. If it says true, turn it on again for the top-level
  departments after the update with `UPDATE departments SET autonomous_release = true WHERE parent_id IS NULL;`.

### Added

- The people who run a department, and its head on their word, connect the department's mail account or webhook, make
  its channels, set their daily limits and whether a direct message goes without a yes to each one, stop and reopen
  them, publish or take back catalog revisions, and read the log of who set up what and through which head. It shows
  under External messaging in Settings for each department they run, and on the department's screen under About the
  department. A password or key goes to the server once and never comes back, and a head never reads it. Limits,
  consent, content checks, prices and public posts keep asking as before.
- The people who run a department, and its head on their word, also run its keys, its autonomous release, its approval
  policies, its description and its work without the CEO.
- An assistant's program can download the files its own agent attached, and the agent offers to call another assistant
  only while its assistant has a skills address.

### Changed

- The account menu keeps Improvements, Versions, Settings, About and Log out. Settings opens on Profile, your own name,
  and holds four groups: Appearance & language, with the skins two by two and the language in one list; Integrations,
  with Google Sheets and the company's GitHub key on one card each; External messaging; and Company & access, with the
  public link and the backups. Writing to Hornhoof developers is inside About. Each group has its own address under
  `/settings`, and the old addresses `/profile`, `/themes`, `/outbound` and `/feedback` are gone.
- Settings keeps its heading and Done at the top and scrolls only its body.
- The account menu, About, Settings, Subscriptions & API, a department's approvals and its outbound setup look as Design
  checked them: buttons, fields and lists 44 px high, actions at the end of a row, pink buttons that stop or remove, no
  number arrows in fields, and the same widths in Chromium, Firefox and WebKit.

### Fixed

- The turn tag on the orchestrator's circle on the map is readable again while decisions wait: it no longer takes the
  amber glow as its background.
- Status words in tables no longer break letter by letter, so Ready no longer shows as Read over y on Subscriptions &
  API. No column is narrower than its longest word, and a table that does not fit by whole words shows its rows as
  entries.
- On Machines, the open card of your own machine keeps the button that makes it a full machine of the company inside
  the card, and showing the install command no longer turns the wide table of machines into entries.

### Russian

Отдел сам ведет свои внешние рассылки и свою работу без CEO, Настройки стали одним окном из четырех групп за коротким
меню учетной записи, а слова статусов в таблицах больше не рвутся по буквам.

- Перед обновлением: в выпуске миграции 0127 и 0128. 0127 добавляет пустую таблицу `outbound_setup_events`, журнал
  того, кто настраивал рассылки отдела. 0128 переносит автономный выпуск с компании на каждый отдел: у всех отделов он
  сначала выключен, а переключатель компании убран. Перед обновлением сервера проверьте, был ли он включен у компании:
  `SELECT autonomous_release FROM companies;`. Если ответ true, после обновления снова включите его отделам верхнего
  уровня: `UPDATE departments SET autonomous_release = true WHERE parent_id IS NULL;`.
- Те, кто ведет отдел, и глава отдела по их слову подключают почтовый ящик или вебхук отдела, создают его каналы,
  задают дневные лимиты и то, уходит ли личное сообщение без «да» на каждое, останавливают и снова открывают каналы,
  публикуют и отзывают версии каталога и читают журнал того, кто что настроил и через какого главу. Это есть во
  «Внешних рассылках» в Настройках для каждого отдела, который человек ведет, и на экране отдела в разделе «Об
  отделе». Пароль или ключ уходит на сервер один раз и обратно не возвращается, а глава его никогда не читает. Лимиты,
  согласие, проверки текста, цены и публичные посты спрашивают, как и раньше.
- Те, кто ведет отдел, и глава по их слову также сами ведут его ключи, автономный выпуск, правила одобрений, описание
  и работу без CEO.
- Программа ассистента может скачать файлы, которые приложил его собственный агент, а агент предлагает позвать другого
  ассистента, только пока у его ассистента есть адрес навыков.
- В меню учетной записи остались Улучшения, Версии, Настройки, О программе и Выход. Настройки открываются на Профиле, с
  вашим именем, и состоят из четырех групп: «Оформление и язык», где скины стоят по два в ряд, а язык выбирается из
  одного списка; «Интеграции», где у Google Sheets и ключа GitHub компании по своей карточке; «Внешние рассылки»; и
  «Компания и доступ», с публичной ссылкой и резервными копиями. Написать разработчикам Hornhoof можно внутри «О
  программе». У каждой группы свой адрес в `/settings`, а старых адресов `/profile`, `/themes`, `/outbound` и
  `/feedback` больше нет.
- Заголовок и «Готово» в Настройках стоят наверху, а прокручивается только содержимое.
- Меню учетной записи, «О программе», Настройки, «Подписки и API», одобрения отдела и настройка его рассылок выглядят
  так, как их проверил Дизайн: кнопки, поля и списки высотой 44 px, действия в конце строки, розовые кнопки остановки
  и удаления, без стрелок у числовых полей и с одинаковой шириной в Chromium, Firefox и WebKit.
- Плашка хода на круге оркестратора на карте снова читается, пока ждут решения: она больше не берет янтарное свечение
  себе в фон.
- Слова статусов в таблицах больше не рвутся по буквам, и Ready на «Подписках и API» больше не стоит как Read над y.
  Ни одна колонка не уже своего самого длинного слова, а таблица, которая не помещается целыми словами, показывает
  строки записями.
- На экране «Машины» в раскрытой карточке своей машины кнопка, которая делает ее полной машиной компании, остается
  внутри карточки, а показ команды установки больше не превращает широкую таблицу машин в записи.

## [0.24.2] - 2026-11-15

Opening access to a computer by its button lets the orchestrator work on that computer right away without asking the
person to write again in chat, and updating nodes removes the renamed `-old-*` node containers once the new ones run.

### Fixed

- Opening access to a computer by its button went into the orchestrator's inbox without the person's permission for that
  computer, so the woken turn refused to run commands there with "computer runs only in a turn that answers a person"
  until the person wrote again in chat. The orchestrator now runs commands on the opened computer in the turn woken by
  that click, and only on that computer until a person writes or presses Enter in the window; no other decision is
  opened.
- Replacing a node container during an update could leave the renamed `-old-*` container behind with automatic restart
  still on, restarting every minute with "This machine has no key yet" while the new node already ran. Renamed `-old-*`
  node containers now turn automatic restart off at once, are removed as soon as the new node container is running and
  not restarting, and are restored if the new container fails to start; updates also clean up leftover `-old-*`
  containers whose new node containers are healthy, without touching node volumes.

### Russian

Кнопка открытия доступа к компьютеру сразу дает оркестратору работать на этом компьютере без повторного сообщения
человека в чате, а обновление узлов удаляет переименованные старые контейнеры `-old-*`, как только новые узлы запущены.

- Нажатие кнопки открытия доступа к компьютеру уходило во входящий ящик оркестратора без полномочия открывшего человека,
  из-за чего разбуженный ход отказывался выполнять команды на этом компьютере с сообщением «computer runs only in a turn
  that answers a person», пока человек не напишет в чате еще раз. Теперь оркестратор выполняет команды на открытом
  компьютере сразу в ходе, разбуженном этим нажатием, и только на этом компьютере до нового сообщения человека или
  нажатия Enter в окне; никакие другие решения это нажатие не открывает.
- При подмене контейнера узла во время обновления переименованная старая копия `-old-*` могла остаться с включенным
  автоперезапуском и каждую минуту перезапускаться с ошибкой «This machine has no key yet», хотя новый узел уже штатно
  работал. Теперь у переименованных контейнеров `-old-*` автоперезапуск сразу выключается, они удаляются, как только
  новый контейнер узла запущен и не уходит в перезапуск, и возвращаются обратно, если новый контейнер не поднялся; кроме
  того, обновление подчищает оставшиеся от прошлых обновлений контейнеры `-old-*` для здоровых узлов, не трогая тома и
  данные.

## [0.24.1] - 2026-11-15

An update by the button from 0.23 to 0.24 goes through again: Hornhoof makes its networks again with the addresses they
had, and when the new build does not start, the build from before comes back.

### Before you update

- If an update to 0.24.0 ended with "No updater could start", the updater of that server is stopped and the button does
  nothing. Run the server install command on that computer again, as the message says, and Hornhoof moves to 0.24.1. Or
  start the stopped updater container again in Docker, then update by the button.

### Fixed

- An update by the button from 0.23 to 0.24.0 stopped with "No updater could start". The networks of a server set up
  before 0.24.0 have no fixed subnets, and Docker would not make them again while Hornhoof ran on them, so neither the
  new updater nor the old one started. The update now stops Hornhoof for a moment and makes the networks again with the
  subnets they had; the database and every other volume stay. It does so too when the settings name those subnets
  already and only Docker Compose's refusal shows that the networks were made the old way, once. If the new updater
  still does not start, the build from before starts again whole and the update goes back.
- Going back from 0.24 to a 0.23 build keeps the networks as they are, so the build from before starts on them.
- The update log says why Docker Compose refused to start an updater, in a few short lines and without the server's
  keys and passwords.
- The server install command run again on a server set up before 0.24.0 makes its networks again with the subnets they
  had, also when its settings name those subnets already: when Docker would not make a network again while the
  built-in node, the updater or an old tunnel are on it, the install tells the node, stops every container of Hornhoof
  and starts again, once. If something outside Hornhoof stays on those networks, it says which networks to free.

### Russian

Обновление кнопкой с 0.23 на 0.24 снова проходит: Hornhoof заново создает свои сети с прежними адресами, а если новая
сборка не запускается, возвращается прежняя.

- Перед обновлением: если обновление до 0.24.0 закончилось сообщением «No updater could start», обновлятор этого
  сервера остановлен, и кнопка ничего не делает. Запустите на этом компьютере команду установки сервера еще раз, как
  говорит сообщение, и Hornhoof перейдет на 0.24.1. Или снова запустите остановленный контейнер обновлятора в Docker,
  а потом обновите кнопкой.
- Обновление кнопкой с 0.23 на 0.24.0 останавливалось с «No updater could start». У сетей сервера, установленного до
  0.24.0, нет заданных подсетей, и Docker не пересоздавал их, пока на них работал Hornhoof, поэтому не запускался ни
  новый обновлятор, ни старый. Теперь обновление ненадолго останавливает Hornhoof и создает сети заново с прежними
  подсетями; база и все остальные тома остаются. Так же и тогда, когда в настройках эти подсети уже записаны и только
  отказ Docker Compose показывает, что сети созданы по-старому, один раз. Если новый обновлятор все равно не
  запускается, прежняя сборка запускается снова целиком, и обновление откатывается.
- Откат с 0.24 на сборку 0.23 оставляет сети как есть, и прежняя сборка запускается на них.
- В журнале обновления написано, почему Docker Compose отказался запустить обновлятор: несколько коротких строк, без
  ключей и паролей сервера.
- Команда установки сервера, запущенная еще раз на сервере, установленном до 0.24.0, создает его сети заново с
  прежними подсетями, и тогда, когда они уже записаны в настройках: если Docker не пересоздает сеть, пока на ней
  встроенный узел, обновлятор или старый туннель, установка предупреждает узел, останавливает все контейнеры Hornhoof
  и запускает их снова, один раз. Если на этих сетях остается что-то не от Hornhoof, она говорит, какие сети
  освободить.

## [0.24.0] - 2026-11-15

Agents run on any API that speaks the Anthropic or OpenAI protocol and are paid by the tokens they use, Hornhoof counts
each turn's tokens, a turn is now the release of its department, and Tasks shows the goals of every department on one
board.

### Before you update

- Migrations 0125 and 0126 come with this release. 0125 adds an empty table `turn_tokens` for each turn's tokens and
  the address and protocol of an API connection. 0126 makes turns releases: planned turns are removed and their tasks
  go to the head of their top-level department, or wait blocked where it has no head, and what each planned turn was
  for stays in the log of its tasks; an open turn keeps only the work accepted into its branch or done turnkey, and the
  rest goes on outside every turn; every top-level department gets one open turn; a department's work mode is removed.
  Going back to 0.23.6 means the database goes back to the copy made before the update, so changes made after the
  update are lost.
- An API on your own network, not on the internet, is reached only when its host is in `API_INTERNAL_HOSTS` in the
  server's `.env` file, as host names or addresses separated by commas.

### Added

- Subscriptions & API connects an API by its key: Claude API, OpenAI API, OpenRouter or a compatible API at its own
  address. Agents run on it in Claude Code or in Codex, by its protocol, and its models are loaded from the API or
  added by their id. The key is kept encrypted and only its last 4 characters are ever shown, and a connection serves
  any department or the orchestrator.
- Each turn's tokens are kept with the model it ran on. Subscriptions & API shows input, output and cache tokens for
  today, 7 days, 30 days and all time, and a card splits its 30 days by model. Each plan is marked as paid by
  subscription or by tokens, with a filter for that.
- The cards of the orchestrator and of an employee offer the APIs they may run on, with their models.
- Tasks shows the goals of every department as a board, each with its related tasks folded under it, in progress, by
  department, or by turns and releases. Tiles on top say at a glance what waits for your answer, what goes on now and
  what is ready for release. A question stands only where it waits for you, with a link on its row, and closed
  releases are folded. Another department's tasks are read-only there.
- An agent's program gets answers from Hornhoof's tools while no turn runs, such as when it connects or runs its
  checks.

### Changed

- A turn is the release of its department. Each top-level department always has one open turn, the release it gets
  ready; a task joins it as its result is accepted into the turn's branch, and the tag of the recorded release closes
  the turn. Work never waits for a turn, there are no planned turns, and the choice between work in turns and
  continuous work is gone.
- Every release runs the full test run, and a version tag that no recorded release names is reported. Autonomous
  release approves a turn's release too, asked only by the task that holds the verdict or a coordination task above it.
  A test environment manifest that still names `everyTurns` for its full run keeps working, and nothing runs by it.
- A route skips a check that nobody in the department can do instead of waiting for it, and a department that keeps a
  repository hands its documents in through it.
- The skills every agent gets describe tasks and turns as releases. A turnkey team does and releases its task end to
  end with its own review and security check. Independent Review and Security engineers work in echelon tasks, where a
  change affecting access, root, permissions or secrets passes an independent Security engineer before any shared
  branch.
- The README, the install guide and every package say what Hornhoof is, its MIT licence and where its code lives. A
  pull request from a fork never runs on a machine a repository variable names. Texts, tests and fixtures use neutral
  names.

### Russian

Агенты работают на любом API с протоколом Anthropic или OpenAI и оплачиваются по израсходованным токенам, Hornhoof
считает токены каждого хода, ход теперь это выпуск своего отдела, а «Задачи» показывают цели всех отделов на одной
доске.

- Перед обновлением: в выпуске миграции 0125 и 0126. 0125 добавляет пустую таблицу `turn_tokens` для токенов каждого
  хода, а также адрес и протокол подключения API. 0126 делает ходы выпусками: запланированные ходы удаляются, их задачи
  переходят к главе отдела верхнего уровня, а где главы нет, ждут как заблокированные, и то, для чего был каждый
  запланированный ход, остается в журнале его задач; в открытом ходе остается только работа, принятая в его ветку или
  сделанная под ключ, остальное идет дальше вне ходов; у каждого отдела верхнего уровня появляется один открытый ход;
  режим работы отдела убран. Откат на 0.23.6 возвращает базу к копии, сделанной перед обновлением, поэтому изменения
  после обновления пропадут.
- API в вашей собственной сети, а не в интернете, доступен только если его хост указан в `API_INTERNAL_HOSTS` в файле
  `.env` сервера: имена или адреса через запятую.
- «Подписки и API» подключают API по ключу: Claude API, OpenAI API, OpenRouter или совместимый API по своему адресу.
  Агенты работают на нем в Claude Code или в Codex, по его протоколу, а модели загружаются из API или добавляются по
  их id. Ключ хранится зашифрованным, видны только его последние 4 символа, а подключение служит любому отделу или
  оркестратору.
- Токены каждого хода хранятся вместе с моделью, на которой он шел. «Подписки и API» показывают входящие, исходящие и
  кешированные токены за сегодня, 7 дней, 30 дней и все время, а карточка делит свои 30 дней по моделям. Каждый план
  помечен как оплата подпиской или токенами, с фильтром по этому.
- Карточки оркестратора и сотрудника предлагают API, на которых они могут работать, с их моделями.
- «Задачи» показывают цели всех отделов доской, у каждой свернуты связанные задачи: в работе, по отделам или по ходам
  и выпускам. Плитки сверху сразу говорят, что ждет вашего ответа, что идет сейчас и что готово к выпуску. Вопрос стоит
  только там, где ждет вас, со ссылкой в своей строке, а закрытые выпуски свернуты. Задачи другого отдела там только
  для чтения.
- Программа агента получает ответы инструментов Hornhoof, пока ход не идет, например когда подключается или выполняет
  свои проверки.
- Ход это выпуск своего отдела. У каждого отдела верхнего уровня всегда есть один открытый ход, выпуск, который он
  готовит; задача входит в него, когда ее результат принят в ветку хода, а тег записанного выпуска закрывает ход.
  Работа никогда не ждет хода, запланированных ходов больше нет, и выбора между работой ходами и непрерывной работой
  тоже нет.
- Каждый выпуск проходит полный прогон тестов, а о теге версии, который не называет ни один записанный выпуск,
  сообщается. Самостоятельный выпуск одобряет и выпуск хода, и просит его только задача с вердиктом или задача
  координации над ней. Описание тестовой среды, где у полного прогона еще указан `everyTurns`, по-прежнему
  читается, и по этому числу ничего не запускается.
- Маршрут пропускает проверку, которую в отделе никто не может сделать, вместо того чтобы ждать ее, а отдел со своим
  репозиторием сдает документы через него.
- Навыки, которые получает каждый агент, описывают задачи и ходы как выпуски. Команда под ключ делает и выпускает свою
  задачу целиком сама, со своей проверкой кода и безопасности. Независимые проверяющие кода и безопасности работают в
  задачах с этапами, где изменение доступа, прав root, разрешений или секретов проходит независимого инженера
  безопасности до любой общей ветки.
- README, руководство по установке и каждый пакет говорят, что такое Hornhoof, его лицензию MIT и где лежит его код.
  Запрос на слияние из форка никогда не запускается на машине, которую называет переменная репозитория. Тексты, тесты и
  данные тестов используют нейтральные имена.

## [0.23.6] - 2026-11-14

A company runs on several machines of its own with encrypted backups and a link of its own, employees' letters wait in
an inbox, agents give people tables as real files and read pages that scripts build, and a person sends a finding to
Hornhoof's developers with one button.

### Before you update

- Migrations 0106 to 0124 come with this release. 0106 to 0119 add what keeps copies of the company's data on other
  machines, its backups and the lease of the machine that leads, and every write then goes through that lease. 0120
  adds an empty table `google_sheets` for a company's Google key, 0121 the autonomous release switch and its log, 0122
  and 0123 the feedback inbox and what became of sent findings, 0124 employees' inboxes. Going back to 0.23.5 means the
  database goes back to the copy made before the update, so changes made after the update are lost.
- The app image now carries the packages for certificates and the network, and the node image `hh-browse`, `hh-xlsx`,
  zip, PyYAML, pip and pytest, so both are larger.
- A server on a Mac that was updated with the Update button: run the install line once on that Mac. Until then other
  machines reach it only through its hornhoof.org link; after it they also find it on your own network. A server on
  Linux does this by itself.
- If the hornhoof.org link stops opening after the update, put `ACME_DIRECTORY=off` in the `.env` file in the
  `~/hornhoof` folder and run `docker compose up -d app` there. The link opens again within a minute.

### Added

- Letters from employees and Hornhoof wait in an employee's inbox, and a free employee takes all its unread letters in one
  turn instead of a turn for each. The agent window shows the inbox with its unread count; the CEO or the head of the
  department picks whether an employee, a department or the company gets letters through the inbox or each as its own
  turn. A person's words never wait there. The agent window keeps the newest 300 lines.
- A company keeps copies of its data on other machines of its own. One machine leads; Machines shows each machine's
  copy and its place in line, and "Move the server here" moves the server with the work kept. When the machine that
  leads stops answering, a copy that holds every change takes over; when a copy may lack changes, the CEO decides
  whether to go on from it or wait, and what both sides did is merged later, with real conflicts asked of a person.
- Encrypted backups every 6 hours and before each update, held on the machines chosen for them. The recovery file
  saved in Company settings restores the company on a new server if this one is lost, and what came after the backup
  can be brought back.
- The company's link at hornhoof.org gets a Let's Encrypt certificate of its own, so the connection is encrypted to the
  company's own machine.
- The owner of a machine opens the orchestrator's access to it for a day with a key only that owner holds. A turn whose
  machine goes out of reach keeps its work and goes on when the machine is back, and while an update installs Hornhoof
  takes no changes and says so.
- A person sends a bug, an improvement or an idea to Hornhoof's developers with one button. The window shows exactly
  what goes, with keys, addresses, email and private paths cleaned out. Findings about Hornhoof itself stay apart from
  the company's own, and the card of a sent finding shows when it went, its number, its GitHub issue and the version
  that fixed it.
- The CEO can turn on autonomous release: an exact commit for main then goes in without a card when it has a green full
  test run, an independent PASS from another employee and a fast-forward path from main. Each such commit is in the
  autonomous release log.
- Any agent hands a person a table as an `.xlsx` or `.csv` file in the task card or the chat, sends it to a person's
  Telegram, or makes a Google Sheet once a person who may change the whole company saved a Google key in Company
  settings. Without a key the agent says what to connect and attaches the `.xlsx`. A file goes only to an active person
  of the same company who may see it.
- Agents of every department read pages that scripts build with `hh-browse`, in the node's own browser, and only public
  addresses. A sign-in or a robot check is noted for a person, never got past.
- The task view lists a department's branches of accepted and handed-in tasks that are not in main, so work goes on from
  them.
- The agent and task cards name an employee's machine that is offline, and the employee moves to an online plan of its
  department in one click.
- A file dropped into an agent's window is attached to the chat instead of opening in a tab.

### Changed

- Operations stop and start any employee's turn again themselves, without asking a person. A person's own assistant's
  program is looked at, typed into and recovered only by its owner.
- Shared skills and tool descriptions say what to do about a missing command, a write answered with 502, 503 or 504, a
  message that ends a wait, and full compact windows. A release runs the full test suite once on its final commit, and
  the checks of a change run in the author's own workspace. The company view says which employees have text of their
  own over their role's.
- `failures` and `agents` show another department's blocked and failed work without its credentials or private paths.
- The orchestrator and heads hire, build and run their department in any turn of theirs for the last person who wrote
  to them, with that person's rights as they are now, so an answer that comes in a later turn no longer makes them ask
  the person to write again. The orchestrator installs a Hornhoof version the CEO or the delegate asked for in a later
  turn too. A person's own decisions, such as people, access, keys, plans, budgets and approval policy, still need the
  turn that answers that person.

### Fixed

- A company of about 120 agents no longer sends its tab into endless redraws, leaks or stalled frames, and its map stays
  on screen while the server is slow. A part of the page that redraws without end or breaks is stopped with a button to
  start it again, and while the page slows down animations and effects are turned off, with a button to turn them back
  on. In Safari the map moves smoothly, and a hidden map pauses.
- Answering a department head no longer makes the screen blink or turn grey.
- A turn whose program finished at its prompt is closed and the queue goes on in the same session, a running turn no
  live program holds is ended and Operations hear of a stalled queue, and words a person sent while a turn waited no
  longer cut that turn short.
- Task numbers and planned turns no longer collide when tasks are made at the same time, and the map's report and task
  moves no longer lock each other.
- A tab another person comes to no longer shows the company or the unsent answers of the one before.
- A node that is silent or stuck is updated without waiting forever, a stopped node is started again, and the updater
  ends the processes it left behind.
- Claude plans show their full limits again.
- The terminal keeps the reader's place when a program leaves its alternate screen.
- Operations hears of a plan hold once, and a department whose task is paused with a reason is no longer called quiet.

### Russian

Компания работает на нескольких своих машинах, с зашифрованными резервными копиями и своей ссылкой, письма сотрудникам
ждут во входящих, агенты отдают людям таблицы настоящими файлами и читают страницы, которые строят скрипты, а человек
одной кнопкой отправляет находку разработчикам Hornhoof.

- Перед обновлением: в выпуске миграции с 0106 по 0124. Миграции 0106-0119 добавляют то, что держит копии данных
  компании на других машинах, резервные копии и аренду ведущей машины, и дальше каждая запись идет через эту аренду.
  0120 добавляет пустую таблицу `google_sheets` для ключа Google компании, 0121 переключатель самостоятельного выпуска и
  его журнал, 0122 и 0123 входящие отзывы и судьбу отправленных находок, 0124 входящие сотрудников. Откат на 0.23.5
  возвращает базу к копии, сделанной перед обновлением, поэтому изменения после обновления пропадут. Образ сервера
  теперь содержит пакеты для сертификатов и сети, а образ узла `hh-browse`, `hh-xlsx`, zip, PyYAML, pip и pytest,
  поэтому оба больше.
- Сервер на Mac, обновленный кнопкой «Обновить»: один раз выполните на этом Mac строку установки. До этого другие
  машины находят его только по ссылке hornhoof.org, после этого и в вашей собственной сети. Сервер на Linux делает это
  сам. Если после обновления ссылка hornhoof.org перестала открываться, впишите `ACME_DIRECTORY=off` в файл `.env` в
  папке `~/hornhoof` и выполните там `docker compose up -d app`: ссылка снова откроется в течение минуты.
- Письма от сотрудников и Hornhoof ждут во входящих сотрудника, и свободный сотрудник берет все непрочитанные письма
  одним ходом, а не ходом на каждое. Окно агента показывает входящие с числом непрочитанных; CEO или глава отдела
  выбирает, получает ли сотрудник, отдел или компания письма через входящие или каждое отдельным ходом. Слова человека
  туда никогда не попадают. Окно агента хранит последние 300 строк.
- Компания держит копии своих данных на других своих машинах. Одна машина ведет; экран «Машины» показывает копию каждой
  машины и ее место в очереди, а «Перенести сервер сюда» переносит сервер с сохранением работы. Если ведущая машина
  перестала отвечать, ее место занимает копия, в которой есть все изменения; если в копии может не хватать изменений,
  CEO решает, продолжить с нее или ждать, а сделанное обеими сторонами потом сливается, и настоящие расхождения решает
  человек.
- Зашифрованные резервные копии каждые 6 часов и перед каждым обновлением хранятся на выбранных для них машинах. Файл
  восстановления, сохраненный в настройках компании, восстанавливает компанию на новом сервере, если этот потерян, а
  сделанное после копии можно вернуть.
- Ссылка компании на hornhoof.org получает свой сертификат Let's Encrypt, и соединение шифруется до машины самой
  компании.
- Владелец машины открывает оркестратору доступ к ней на сутки ключом, который есть только у него. Ход, машина которого
  пропала из сети, сохраняет работу и продолжается, когда машина вернулась, а пока ставится обновление, Hornhoof не
  принимает изменений и говорит об этом.
- Человек одной кнопкой отправляет разработчикам Hornhoof ошибку, улучшение или идею. Окно показывает ровно то, что
  уйдет, без ключей, адресов, почты и личных путей. Находки о самом Hornhoof отделены от находок компании, а карточка
  отправленной находки показывает, когда она ушла, ее номер, задачу на GitHub и версию, которая ее исправила.
- CEO может включить самостоятельный выпуск: точный коммит для main тогда проходит без карточки, если у него зеленый
  полный прогон тестов, независимый PASS другого сотрудника и путь перемотки от main. Каждый такой коммит записан в
  журнал самостоятельного выпуска.
- Любой агент отдает человеку таблицу файлом `.xlsx` или `.csv` в карточке задачи или в чате, отправляет ее в Telegram
  человека или создает Google-таблицу, когда человек с правом на всю компанию сохранил ключ Google в настройках компании.
  Без ключа агент говорит, что подключить, и прикладывает `.xlsx`. Файл получает только активный человек той же
  компании, которому его можно видеть.
- Агенты всех отделов читают страницы, которые строят скрипты, через `hh-browse` в браузере узла и только по публичным
  адресам. Вход или проверку на робота агент отмечает для человека и не обходит.
- Задача показывает ветки принятых и сданных задач отдела, которых нет в main, и работа продолжается от них.
- Карточки агента и задачи называют выключенную машину сотрудника, а перевод на работающую подписку отдела делается
  одним нажатием.
- Файл, брошенный в окно агента, прикладывается к чату, а не открывается во вкладке.
- Operations сами останавливают и снова запускают ход любого сотрудника, не спрашивая человека. Программу личного
  помощника человека смотрит, в нее пишет и ее восстанавливает только ее владелец.
- Общие навыки и описания инструментов говорят, что делать при отсутствующей команде, записи с ответом 502, 503 или
  504, сообщении, которое завершает ожидание. Выпуск проходит полный прогон тестов один раз на своем итоговом коммите,
  а проверки изменения идут в рабочей папке автора. Вид компании показывает, у каких сотрудников свой текст поверх роли.
- `failures` и `agents` показывают заблокированную и упавшую работу другого отдела без ключей и личных путей.
- Оркестратор и главы нанимают, строят и ведут свой отдел в любом своем ходе для последнего человека, который им
  написал, с его нынешними правами, так что ответ, пришедший в следующем ходе, больше не заставляет просить человека
  написать снова. Оркестратор ставит версию Hornhoof, о которой просил CEO или его делегат, и в следующем ходе. Решения
  самого человека (люди, доступы, ключи, подписки, бюджеты, правила одобрения) по-прежнему требуют хода, который
  отвечает этому человеку.
- Вкладка компании примерно из 120 агентов больше не уходит в бесконечную перерисовку, утечки и замершие кадры, а карта
  держится на экране при медленном сервере. Часть страницы, которая перерисовывается без конца или ломается,
  останавливается с кнопкой запустить ее снова, а пока страница тормозит, анимации и эффекты выключаются, с кнопкой
  включить их обратно. В Safari карта движется плавно, а скрытая карта стоит на паузе.
- Ответ главе отдела больше не заставляет экран моргать или сереть.
- Ход, программа которого закончила у своего приглашения, закрывается, и очередь идет дальше в той же сессии; ход,
  которого не держит ни одна живая программа, завершается, и Operations узнают о вставшей очереди; слова человека,
  отправленные, пока ход ждал, больше не обрывают этот ход.
- Номера задач и запланированные ходы больше не сталкиваются, когда задачи создаются одновременно, а отчет карты и
  перенос задач больше не блокируют друг друга.
- Вкладка, на которую пришел другой человек, больше не показывает компанию и неотправленные ответы предыдущего.
- Зависший или молчащий узел обновляется без бесконечного ожидания, остановленный запускается снова, а обновлятор
  завершает оставленные им процессы. Подписки Claude снова показывают полные лимиты. Терминал сохраняет место чтения,
  когда программа выходит из альтернативного экрана.

## [0.23.5] - 2026-11-13

Each department runs turns of its own, so the work of one department no longer waits for another's or piles up in one
turn of the whole company.

### Changed

- A turn belongs to one top-level department, with the work of its products and sub-units. Each department has at most
  one running turn and its planned ones wait in line behind it; turns of different departments run side by side.
  Turn numbers still count across the company, so each turn keeps its own branch.
- A new task with nothing above it joins the running turn of its own department, and none while that department runs no
  turn or works all the time. Work under a task stays in that task's turn.
- The head of a department lays out, adds to, renames and merges the turns of its own department, and reads its list
  for later turns; the orchestrator does it for every department. Both hear when a turn of the department is over.
- A new goal gets a new turn of the department that owns it, and work is added to a turn only for that turn's own goal,
  so a turn closes once its goal is done.
- A task may wait for a task of another turn or department once that turn has started.
- The map shows on each department's card its own turn, and the circle in the middle holds all running turns together.
  The Tasks screen lists in a department's table its own turns, and another department's only while it holds a task of
  this one. The report of a turn compares it with the earlier turns of the same department.
- The owner of a department, besides people with the whole company, picks how its planned turn runs.
- A department that is removed closes its turns, which stay in the history.
- The update gives every turn its department: a running or planned turn that of its first unfinished task, of a
  department that runs turns before one that works all the time, any other that of its first task. A running turn keeps
  only its own department's work; other departments' tasks in it go on outside turns, and nothing of them is lost. A planned turn with work of several departments is split into one planned turn for each, with the next free
  numbers. Each department's planned turn then starts by itself within a minute when the department runs none.

## [0.23.4] - 2026-11-13

Every employee pushes each commit and branch at once, and the head of the department decides what goes into the main
branch.

### Changed

- Every employee pushes each commit and each branch to the repository as soon as it is made, finished or not, so no work
  stays only on one machine. A push brings nothing into the main branch: which pushed branches go there and when, and
  how the repository is laid out, the head of the department decides.

### Fixed

- A server that stops no longer waits up to a minute for a connection that never asked anything.
- A head is no longer woken every quarter of an hour about a quiet department when its work is paused with a reason:
  a pause explains the quiet whatever the task's status.

## [0.23.3] - 2026-11-13

A person's assistant can write to its owner in their chat when asked in its window, and an assistant's program can hand
its whole conversation to a new session.

### Added

- When the owner asks their assistant in its window in Hornhoof to write to them in their chat, the assistant sends
  those words there in its own voice. The assistant's program gets them as a reply that answers no message of its own.
- An assistant's program can send, beside the new words, its whole conversation with the owner (`freshText`, up to
  200000 characters). The assistant's agent reads it in place of the new words when its session starts anew: a first
  session, a change of plan, machine or instructions, or a conversation the owner cleared in the terminal. A session
  that goes on reads only the new words. The assistant's `/me` now says `contract: 2`, so a program sends `freshText`
  only to a server that takes it.

### Changed

- The words an assistant's program sends may now be up to 50000 characters, up from 20000. Longer words are refused,
  not cut.

## [0.23.2] - 2026-11-13

Departments run themselves, everyone in a company sees the same company, the lines of the map can be bent, heads'
Telegram bots take files, and a machine whose sign-in was refused stops starting turns that cannot work.

### Added

- A click on a line of the company map puts a bend on it, drawn as a small circle. The line runs through its bends in
  straight pieces, a bend can be dragged or moved with the arrow keys, and a click on it takes it away. Each person's
  bends are kept with their own arrangement of the map, and "Put back as it was" clears them too.
- A head's Telegram bot, which answered anything but text with "I take only text messages for now", now passes on
  documents, archives, photos (an album as one message), voice, audio and video messages and still stickers as files
  the agent downloads, and moving stickers, contacts, places and polls as words. A voice message also gets its
  transcript when `TRANSCRIBE_URL` (any service that answers as OpenAI's `/v1/audio/transcriptions`), `TRANSCRIBE_KEY`
  and `TRANSCRIBE_MODEL` are set in `.env`. A file over the 20 MB Telegram gives a bot is named, and the person hears
  why. The agent is told to save the files it gets into its department's repository, as Hornhoof keeps them 30 days.

### Changed

- A department does what the people who run it decide, without the orchestrator or the CEO. Its head hires, moves,
  renames, changes and fires its employees, and changes its teams and products, in the turn that answers those people.
  The orchestrator no longer stands between a department's people and their head.
- Everyone in a company sees the whole company: every department, its structure, every employee with what they work on
  and how, the map's animations, each department's tasks, tree, speed and numbers. The window, conversation and terminal
  of an employee open only for the people of that employee's department, and a click on someone else's employee says so
  instead of showing an error. The orchestrator stays with those who run the whole company.
- In a department's scheme, every unit hangs from one line under the head, with no empty space beside it.

### Fixed

- When a provider refused a machine's sign-in, the machine kept starting turns that failed at once, each in its own
  terminal. It now stays signed out until the sign-in changes, also when the program reported the refusal as a failure
  or the sign-in was made in the program itself.
- The window of a person's own assistant no longer closes and opens again every time the company's picture refreshes.
- When two people wrote to one head's Telegram bot, the second person's words went into the turn that answered the
  first, and from then on every word of that turn went to both chats: one person got the answer to the other's
  question. A person's words now wait for a turn of their own when the running turn answers someone else in Telegram,
  or when they come from Telegram and the running turn is another person's. The head is also told that its answer goes
  to the writer alone.

## [0.23.1] - 2026-11-13

A machine whose agent program update was cut off half way can update it again, and the machine's log says why an update
or a sign-in failed.

### Fixed

- When a machine slept or shut down in the middle of updating Claude Code, Codex or Kimi Code, npm left a copy of the
  program aside, and every later update of that program failed at once with "Could not update". The node now clears
  that copy before it installs.
- The machine's log now says why a program update failed and how a sign-in's program ended, without any part of a token.

## [0.23.0] - 2026-11-12

The work of turns 19 to 23: themes, the forms of people, assistants, employees and plans on one layout, a chat that
opens on its newest message, and a fair count of turns after a machine comes back.

### Added

- Four themes in the account menu and in the settings: Light, Dark, Matrix and Cyberpunk. A person can also load a
  theme template of their own, a JSON file with colors, fonts and the cut of corners, and save or reset it.

### Changed

- The forms that add a person, an assistant, an employee, a plan or a key share one layout: the name of each field
  beside it, and above it on a narrow screen. Two cards with icons choose between a person and a personal AI assistant.
- A button that creates or saves says so while it works, without changing its width. A key is issued with
  "Issue key" and hidden with "Hide key" once it is copied. After switching between a person and an assistant, the
  arrow keys go on moving between the two.

### Fixed

- A chat opens on its newest message at once, without running through its history, and keeps the place of someone
  who scrolled up to read.
- Wake-ups a task collected while its machine was away go out in one turn when the machine is back. That turn counts
  neither toward the 8 turns without a hand-in nor toward quiet turns; the turns after it count as before, so a machine
  that drops around every turn cannot keep an agent from looking stuck.
- The agent's terminal no longer cuts off the last character on the right: every character fits its own cell.
- When the recorder of a terminal's output does not start, the node starts it once more before it reports a failure.

## [0.18.17] - 2026-11-12

An agent on Antigravity no longer loses Hornhoof's tools when a person's words reach it a moment before their turn
opens.

### Fixed

- Antigravity asks for Hornhoof's tools as it takes a person's words, a moment before Hornhoof opens their turn. The
  node now waits for that turn, as it does for other programs, instead of turning the program away and leaving it
  without tools until it starts again.
- A program turned away that way ends its turn saying it has no tools, and the next turn starts it again with them.

## [0.18.16] - 2026-11-12

An assistant's own agent now stays out of everyone else's sight, and lets go of its owner's plan when the assistant is
switched off.

### Fixed

- The CEO, the CEO delegate and the orchestrator no longer get another person's assistant's own agent on their live
  screens: not its words, its activity or how full it is, nor its name in other employees' messages.
- The number of employees at work on the map no longer counts an assistant's own agent, and neither does the card of a
  machine that went away.
- Switching an assistant off takes its own agent off its owner's plan. After switching it on, its owner picks a plan
  again.
- Picking a plan for an assistant from two screens at the same moment makes one agent for it, not two.
- While an update waits on a machine, an assistant's own agent waits as the workers do, and does not go in past the
  limit as the orchestrator and the heads do.
- When the assistant's program breaks off or stalls in the middle of a skill's answer, its agent reads a plain reason
  instead of a failed call.
- The refusals about an assistant's plan and its agent's card now show in Russian too.

## [0.18.15] - 2026-11-12

Moving the map no longer selects the words on it.

### Fixed

- A press, a drag or a double click on the map or the tree no longer marks a card's words, so a browser's translator
  or search does not pop up over them.

## [0.18.14] - 2026-11-12

A personal assistant can now have an agent of its own that thinks for it on a plan its owner picks, and that agent can
ask the assistant's program for the program's own skills.

### Added

- On the assistant's card in People, its owner picks one of their own personal plans, and the assistant gets its own
  agent on it. Only the owner sees that agent and writes to it, in its window or through the assistant; it takes no
  tasks, is not on the map, and the orchestrator does not change it.
- A message from the assistant without an agent goes to its own agent, which reads the program's words as they are and
  keeps its conversation between messages. `GET /api/assistant/me` says which agent that is and whether it can answer now.
- The assistant's card takes a skills address. The assistant's own agent asks the program for its skills there with a
  signed call, and reads the answer.
- For an AvaClone assistant with an events or skills address, Copy for the assistant adds the signing secret, which the
  program checks Hornhoof's calls with.
- A general skill for an assistant's own agent: answer only with the words for the owner, and leave code work to the
  company's agents.

### Fixed

- The orchestrator's database tool can no longer change an assistant's settings, key or events: it only reads them.

## [0.18.13] - 2026-11-12

An employee now knows who runs its department when that person writes to it, the installer shows each step and what to
do in it, and the page of a plan leads its owner from the install command to working agents.

### Added

- The installer for a computer runs in four numbered steps, each with one plain sentence of what happens, and ends with
  a Done line that names the computer and its plans. Before the node image it says the first download can take 10 to 20
  minutes, and the download shows its progress. Before each sign-in a framed block says what to do, how to paste in that
  window, and to sign in in one place only.
- A personal plan that does not work yet shows its owner the steps to agents working on it: run the command, the
  computer connects, sign in, ready. The passed steps are ticked, and the current one says what to do now.
- An agent's terminal has Paste in its right-click menu.

### Changed

- On Windows the installer keeps the window from freezing at a click, so a right-click pastes the sign-in code, opens
  the sign-in page in the Windows browser by itself, shows a clear Restart needed banner, and a window that would close
  by itself waits for Enter first.

### Fixed

- A head took a person given its department for an outsider and asked the CEO before doing what they asked: a message
  from an agent's window carried only the person's name, and the company list agents read showed only people who see
  the whole company. Each message to an employee now says what the person is to it, the company list names everyone
  who runs a department, and the heads' and the orchestrator's rules say to do what such a person asks inside it. The
  approvals panel no longer says that access to a department does not make someone run it.
- Ctrl+V in an agent's terminal on Windows and Linux typed ^V into the program instead of pasting.
- A department's pipeline report answers where the database may only be read, instead of failing on a snapshot it could
  not keep.
- An agent left work to a background helper, ended its answer, and asked the person to write again: Hornhoof's tools
  stop when the answer ends, so the helper lost them halfway. Every agent's rules now say to finish work that uses
  Hornhoof's tools inside the answer.

## [0.18.12] - 2026-11-12

Everyone given a department now runs it in full, as its responsible person does, and a department may have many such
people.

### Changed

- A person whose access lists a department sees every employee of it, also those on someone else's plan, and may change
  them, move them to another plan, write to them, hire into the department, set its repository, sub-units, approvals
  and channels, and answer its decisions. Before, only the one person the CEO named responsible could, and the others saw
  only employees on their own plan. Typing into an employee's terminal and a plan's keys stay with that plan's owner.
  A product or a team of a department alone, and access to the whole company, give no such rights.

## [0.18.11] - 2026-11-12

A person who works in several departments opens each of them again, a plan that was removed connects again without
waiting a day, and a message on a task no longer slips under a wait its holder asks for at the same moment.

### Fixed

- A person given more than one department saw Insufficient permissions on every department page. The page looked for
  them only among each department's own people, while the map shows such a person next to the CEO.
- Connecting a plan again after removing it answered There is an active command for this place, with no command shown,
  until the old command expired a day later. Removing a plan now ends its waiting command, and connecting a plan that
  was removed earlier ends the old one first.
- When a message on a task came into its holder's turn while the holder asked to wait on that task, the wait went in
  after it and held the task until its deadline. Such a wait is now refused once, so the holder reads the message first.

## [0.18.10] - 2026-11-12

OpenClaw and Hermes Agent join a company as a person's assistant with one piece of settings, and an assistant such as
AvaClone takes the company's address and its key in one message. A line on the company map stays on while the agent
under it works, even after it writes to the one above it.

### Added

- Where an assistant's new key is shown once, "Copy for the assistant" copies the company's address and the key in one
  text, for the person to send their assistant, for example in Telegram. The signing secret never goes into it.
- A program that is an MCP client, such as OpenClaw or Hermes Agent, takes what an assistant may do as tools at
  `/api/assistant/mcp` with the assistant's key: who it acts for, whom it may write to, writing to an agent, reading the
  answers and answering the requests that wait for its owner.
- Hermes Agent is a program of its own on an assistant's card. Hornhoof wakes OpenClaw at its wake hook and Hermes Agent
  at its webhook, each in its own form, once an answer is over or a new request waits.
- For OpenClaw and Hermes Agent the window with the new key also shows their settings, ready to copy into their file.
  `docs/assistant-api.md` says how to connect each, step by step.
- The README shows what Hornhoof works with.

### Fixed

- A line on the company map went out while the agent under it still worked, as soon as it wrote to the one above it,
  for example with a question. Now it stays blue until the agent's turn is over, and turns yellow after it.
- The lines of tests and of checks never turned yellow when their result went back to the head. Now they do.
- A wake that failed now joins the next one and starts from the earliest event, as the API document says.

## [0.18.9] - 2026-11-11

A ready-made company comes with every department staffed and starts working once its subscription is on. Every department
keeps its work in a repository, so an earlier version of a letter or a text can be brought back. The company map draws
lines that go together as one road and stays where the person put it, and an agent's window opens its terminal at once
and takes a file of any kind.

### Added

- A company template creates its departments with their whole staff: each employee has a role, skills and the model its
  level asks for. Those with no subscription yet wait for one. A department the orchestrator builds comes with the people
  of its template, and a product added later gets the people its department keeps one of for each product.
- A subscription that is added, or starts to work, takes the employees and the orchestrator that wait for one. One whose
  subscription a person took off by hand stays as it is, and so does one switched off.
- Every department keeps its work in a repository: letters, texts, layouts and tables go in as files, as code does. The
  orchestrator offers one to the CEO or the department's owner and creates it with their word. With a GitHub key saved,
  he creates a department's first repository himself and says where.
- Company settings and a department's Repositories keep the GitHub key repositories are created with: one for the company,
  and one of a department's own that goes first for it. The key is kept encrypted and shown only by its last four
  characters.
- A person can pass an agent a file of any kind, up to 10 MB, by drag, paste or the button, in the chat and in the
  terminal. A file that is no picture downloads under its name.

### Changed

- Lines on the company map that run side by side join into one road and leave it at a fork marked with a dot. A block's
  corner is its grip with nothing drawn on it: the pointer turns into the move cursor there.
- The company map moves only when the person moves it or presses Fit, and opens where they left it after a reload.
- Every agent's window has a Terminal button, and in the terminal a Chat button, from the moment it opens. The terminal
  shows a loader while it opens, and says why in plain words when it cannot show, as when the agent's program is asleep.
- Share access is now called Company settings.

### Fixed

- An agent's terminal could keep the size it first opened with on a machine short of memory, so its lines were cut on the
  right. It now takes the size of its window as soon as it draws.
- The work for assistants stops and starts again cleanly when a server gets and loses the lead.

## [0.18.8] - 2026-11-11

A person can connect their own assistant, a program such as AvaClone or OpenClaw, which does for them in the company all
they may do themselves: it writes to agents and answers requests in their name. The company map shows at a glance how
many departments work in the current turn, and how far each of them has come.

### Added

- The hub of the company map shows one blue sector for each department that works in the current turn. Pointing at a
  department lights its sector and names its role and turn. The card of each such department shows a strip of 20
  squares and how many of its tasks in the turn are done.
- Whoever runs a department chooses on its About panel whether it works in turns, with its tasks counted on the map, or
  all the time, without turns.
- People has an assistant: an agent that works for one person of the company, with that person's rights as they are at
  each moment. Whoever adds a person can tick "This is an agent (assistant)"; someone without the whole company adds
  their own assistant. An assistant has no email, password, invite link, access or Telegram of its own.
- An assistant gets a key and a signing secret, shown once. With the key its program writes to the agents its owner
  writes to in their windows, reads what the agents answer and the requests that wait for its owner, and answers those
  requests. Hornhoof can wake the program at its events address with a signed call. `docs/assistant-api.md` describes
  it all.
- Agents take an assistant's words as its owner's own, and the agent window and the records show that they came
  through the assistant.

### Changed

- The turn's progress no longer stands under the hub, and the words under the count of agents at work are gone; the
  count keeps them as its hint.

## [0.18.6] - 2026-11-11

An agent's window opens as a plain chat, each person arranges the company map as they like, and a department holds
several repositories.

### Before you update

- Migration 0099 adds the table where each person's arrangement of the company map is kept. Nothing old is converted.

### Added

- A department holds more than one repository. Add repository on the department's About panel, or the orchestrator's
  add_repository, brings another one as a new product of the department, named after it, and a task of that product
  works in its repository. Two repositories of one department whose addresses end in the same name are refused, since
  its agents would clone them into one folder.
- Each block of the company map, a person, a department or the orchestrator, has a grip at its top left corner that
  moves it, by mouse, finger or arrow keys. Each person's arrangement is kept on the server for them alone, and Put
  back as it was returns their map to its first look.

### Changed

- An agent's window opens as a chat: the person's words on one side, the agent's on the other, its steps of work folded
  into one line, and its state in plain words above the input. The terminal is one click away on the toolbar, and the
  browser remembers which of the two a person chose last.
- Every line of the company map runs at right angles, the lines from the orchestrator to the departments too, and
  follows a block that moves.

### Fixed

- The person responsible for a department now sees its repository and those of its products, which 0.18.5 let them
  change but not see.

## [0.18.5] - 2026-11-11

People on Windows add a machine or a plan with one PowerShell command, a head or the orchestrator can be written to
through a Telegram bot, and the person responsible for a department runs it as the CEO does. An agent's terminal
scrolls back through its whole conversation, and an agent's program sleeps between its tasks.

### Before you update

- From this release the person responsible for a department hires into it and removes its employees, changes its
  sub-units, products and repositories, and answers its approvals without asking the CEO. Check who is responsible for
  each department.
- Migration 0098 adds the tables of Telegram bots and each person's Telegram. Nothing old is converted.

### Added

- Wherever an install or update command is shown, a command for Windows stands beside the one for a Mac or Linux. It
  runs in PowerShell, says what it installs and then installs WSL 2 and Docker Desktop when they are missing, and goes
  on by itself after a restart Windows asks for.
- A head of a department or the orchestrator may have a Telegram bot. Someone with the whole company, or the person
  responsible for the head's department, connects it on the agent's card with the token from @BotFather. Each person
  sets their Telegram in People. A known person writes to the bot as in the agent's window, the agent learns who they
  are in the company, and its answer comes back to the chat. A stranger is told their Telegram number.

### Changed

- The person responsible for a department runs it as the CEO does: hires into it from its roster, removes its
  employees, stops their turns, makes and changes its sub-units, adds its products and repositories, pauses its tasks
  and says they are urgent, with no approval of the CEO. They see every employee of the department and watch its
  terminals without typing. Departments themselves, people, access, plans, machines and updates stay with the CEO.
- Claude Code and Codex now draw on the terminal's main screen, so an agent's terminal scrolls back through the whole
  conversation, up to its last 5000 lines.
- An agent's program ends once its turn is over and nothing waits for it, and its next task starts it again in the
  same conversation. Its terminal keeps what it printed and says that it sleeps. 20 idle programs held 3.7 GiB on one
  node.
- An invite link opened again after use says to sign in with the email and password set with it, and leads into the
  company, instead of asking for a new link, which resets the password.

### Fixed

- Every screen link opened in the browser wrote "Reply was already sent" into the server log with its whole address,
  invite tokens and setup codes included.
- The node runs under tini, which ends the processes left without a parent; one node kept about a hundred of them.
- Words of a program's earlier run in its terminal no longer pass for a program that is signed out.

## [0.18.4] - 2026-11-10

A second company on a computer that already runs Hornhoof gets a name of its own instead of starting in the first
company's containers.

### Changed

- On a computer that already runs Hornhoof, of this person or of another person on it, `install.sh server` asks a name
  for the new company and sets it up in its own folder, compose project, database and port. Enter sets up again the
  company of this person's folder. `server --name home` gives the name without the question.

### Fixed

- A server installed without a name no longer starts in the containers of a company that runs under the same compose
  project from another folder, which left that company's server unable to open its database. The installer refuses
  such a name, and leaves the port of a stopped company of another person to it.

## [0.18.3] - 2026-11-10

Department templates come with their people, their turnkey team and their own route of checks, and a hire runs the
model its role asks for. Preparing a test environment no longer fails because a machine is slow to stop a service.

### Before you update

- Migration 0097 adds to every task route the skill each of its checks needs. Routes made before it went through the
  stages of Development and get their skills; nothing else is converted.
- Every employee now carries the skill on whom to ask, from its next turn.
- Employees already hired keep their models and skills. The new model rules and team skills apply to new hires, to a
  department built with its people, and to an employee that gets a plan of another program.

### Added

- A department can be created with the people of its template: a tick on the structure card, on by default, brings one
  of each default role, each on a plan that serves it with the model its role's strength asks for. An employee waiting
  for a subscription is drawn grey and says to assign one.
- Every department template has a turnkey team. Its members carry the skills of every check of their department and
  ask for the strongest model. The turnkey team of Development brings the skills of every echelon.
- Every department template has its own route of checks in `templates/echelons`. A department without a repository
  hands its work in as a document, checked by someone of the department who carries the checking skill; where nobody
  does, its work goes as before. Marketing, Sales, Support and Business development get a checker role.
- A fourth strength of role, top, asks for the strongest model. The architect and the security engineer use it.

### Changed

- A hire that names no model runs the model of its role's strength on its plan, by name, instead of the program's
  default, and so does an employee that gets a plan of another program.
- The architect and the test engineer join the default roster of Development, so each echelon has its own employee.

### Fixed

- Preparing a test environment failed when PostgreSQL took longer than 5 seconds to stop on a slow disk. An ordinary
  stop of a service now waits for it however long it takes, bounded only by the preparation's own deadline and
  cancellation; the short graces only finish processes off after a cancellation or an error. The server that prepares
  a template runs without fsync, since its state is synced before the template is published.

## [0.18.2] - 2026-11-10

Code work outside a turn and quick fixes go to a turnkey team, not to the members of the echelons.

### Before you update

- A member of a turnkey team reviews, checks the security of and tests its own work. Turn on the skills of every
  echelon on the cards of a turnkey team's members: plan review, API design, review, security, test gaps, browser
  scenarios, test environment, release checks and release notes.

### Changed

- The orchestrator and the heads give code work outside a turn, and a small, quick fix that need not go through every
  echelon, to a member of a turnkey team, who does it end to end alone with its own review and security check.
  Members who work in the echelons take neither, and where there is no turnkey team such work waits for a turn. It is a
  rule of their instructions: Hornhoof itself refuses no assignment.

## [0.18.1] - 2026-11-10

Less in the way of a turn before turn 19. Code nothing reached is gone with its tables, a quiet program is shown to
someone who sees its screen sooner, three loops that woke agents without end stop, a turnkey turn can close, and the
report of a turn counts its agent turns and the share that went to coordination.

### Before you update

- Migration 0095 drops the staging and task workspace tables and the columns `jobs.assignment_epoch`,
  `jobs.workspace_id`, `jobs.workspace_spec_version` and `tasks.assignment_epoch`. Migration 0096 drops the external
  recovery tables, `computer_access_intents`, `program_operator_actions`, `program_operator_cases.snapshot` and
  `turns.closed_by`. No code read or wrote any of them; take a backup first if you keep rows there.
- Nothing a node and a server send each other changed, so a node of 0.18.0 keeps working with this server.

### Added

- The report of a turn has a section of agent turns: all of them on the turn's tasks and outside them while it ran,
  those of the orchestrator, heads and Operations, turns per task, and the share that went to coordination. They compare
  with the previous and the baseline turn, and a department's part counts the turns on its tasks.

### Changed

- A thinking, retrying or idle program with no sign of life raises an alarm after 10 minutes, and a running tool after
  30, where they were 30 minutes and 2 hours. The call goes to a free program operator, else the head of Operations,
  else an operator at work, who reads the screen and acts on it, and comes again each time the quiet doubles.
- Outbound messages and their model checks are reached through one file of their module, and a lint rule holds the
  server to it.
- Comments that stood above the wrong declaration or described what the code no longer does are moved or rewritten.
- Code nothing reached is removed: the staging and task workspace store, the node's external git, task folders and
  workspace retiring, the test planning history, the hook answer encoder, the teammate message and the protocol shapes
  no side sent, about 3,000 lines of code and 5,000 of their tests.

### Fixed

- A head could not close the task that finished turnkey work was made under, so a turnkey turn could not end.
- Words a program did not record went again every 10 minutes for as long as it stayed stuck. The wait now doubles up
  to four hours.
- An agent whose turns on a task kept failing later than three minutes after they started was woken again without end.
  Five such turns in a row block the task for whoever gave it out.
- One task that waited for a person kept the task watchdog waking every 10 minutes. A task that waits on purpose no
  longer counts as work to look at.

## [0.18.0] - 2026-11-10

Turn 18 and what it showed. A turn now runs in one of two modes: through the echelons, which only go forward, or turnkey,
given to one member of a turnkey team who does it alone; work outside a turn goes through no echelons. Test runs take
less time: tests wait on a clock the test moves, a run is laid out by how long its files take, and a test machine is
shared fairly. A machine shares its processors between the agents' programs and starts no new one while its memory is
short. A program keeps Hornhoof's tools when it connects between turns, and Antigravity's survey no longer takes a turn's words.

### Before you update

- Migration 0092 adds `teams.turnkey`, false for every team, and migration 0093 adds `turns.mode`, `echelons` for every
  turn there is. Migration 0094 adds `companies.task_numbers_used` and `companies.turn_numbers_used`, filled with the
  highest task and turn number each company has. Nothing else is converted.
- `plan_turn` now needs a mode. The orchestrator's instructions in this version name one; an orchestrator still on older
  instructions is refused until it does.
- Open tasks keep the route they have. Only tasks made after the update follow the new rules.
- Update the nodes as well. The fix for tools lost between turns, the survey setting for Antigravity and the share of a
  machine are in the node: a node of 0.17.2 keeps working, but can still lose its tools after a short turn and is not
  held back when memory is short.

### Added

- A turn has a mode, echelons or turnkey, chosen when it is planned (`plan_turn`, `edit_turn`, and a choice on the tasks
  screen and beside the button that puts work into the next turn). The mode can change only while the turn is planned.
  Turns of different modes are not merged.
- A team can be marked as working turnkey on the department's screen. Its members do a task alone from start to finish,
  call nobody of the department onto it and close it with their report. A turnkey turn needs such a team, and its tasks
  go only to its members.
- Each agent program gets its share of the machine's processors and memory as `VITEST_MAX_WORKERS`, unless the machine
  sets one itself. A turn that would start a new program waits while the machine has less than 2 GiB free and goes out
  by itself once memory is free; the agent's window says why, and Operations sees that such an agent is waiting, not
  stuck. Nothing that already runs is stopped.
- The orchestrator, the head of Operations and the program operator see the program of any employee and act on it,
  with only the values of secrets masked. A recovery hold is lifted with `program_recovery_release`, its case and a
  reason.
- A test run's report says which profile passed and which suites and files it left out, and the line of proof in a
  request for approval prefers a run that ran everything again. The release check is a `full` run.
- The testing policy sets a time budget: 1 second a test, 30 seconds a file and 5 minutes for a whole run of the fast
  profile. The pipeline report names what is over it.
- The style book 1.2 and the theme sheet 1.0, with scripts that check them.

### Changed

- The echelons only go forward: each one fixes what it finds itself, and only work built wrong goes to the head. A
  candidate whose own change passed but needs a fix from the main line stays at Tests, whose owner merges the main line
  into it and checks it again.
- Work outside a turn goes through no echelons: its holder does it alone from start to finish.
- Task and turn numbers go on after the highest ones a company gave, even when old tasks and turns are removed by hand,
  so a branch `task-N` or a version `0.N.0` never names two pieces of work.
- The tests of the node, the server and the web wait on a clock the test moves instead of real pauses, and no test
  downloads or starts a browser to check a node's start.
- A run is laid out by the times its files took before, the suites of one part run as one command, the batches of a
  run start beside its preparation, and Vitest gets the processors and memory a test machine has free. The longest test
  files are split so they run side by side.
- The author check runs the tests that read a changed document by its path, and a browser scenario follows every screen
  of the app it drives.
- On GitHub, where no full run follows, a commit runs every test its change reaches, or the whole suite.
- Codex is told that the words of its head, the orchestrator and a person of the company are instructions, and that what
  they quote is data.
- The engineering rules open with what matters most: no push or merge to the main line unless the task names it, a
  report of result and evidence, quality tools only when assigned, and three failed fixes before the premise is
  questioned.

### Fixed

- A program that connected to Hornhoof's tools after a short turn, or between turns, was turned away and lost its tools
  for the rest of its session. The node now answers that connection from what Hornhoof said before, and refuses only a
  tool call outside a turn.
- Antigravity starts with its feedback survey off, so the survey no longer takes the words of a turn.
- Hornhoof's own words left in a program's input are delivered or erased, a Claude Code whose start a busy node refused
  is typed into, recovery does not repeat itself, and a program without tools is not reminded.
- An answer to a colleague's message reaches the one who asked.
- The browser tests of the main line pass again after 0.17.2, and a task can be opened from the table while an agent
  window is open.
- A task's state stays on one line in the task table.
- Node secrets stay out of input intents and audit results.
- The release steps say that the workflow makes the tag itself: a tag made by hand makes the push skip the version.

## [0.17.2] - 2026-11-09

Fix what stalled turn 17 and the release of 0.17.0, so that a turn goes through its stages without waiting for people:
test results are reused, the author check takes minutes, a task can be paused, notices and waits stop repeating, a
message reaches every employee, and nodes check pages in Chromium, Firefox and WebKit.
Let an employee hand in work that adds a database migration: GitHub shows no patch of a migration's large snapshot, and
0.17.0 refused every such handoff. The department schema stands its roles by gates again, and the release tests check
only Hornhoof's own side.

### Before you update

- Migration 0089 adds the empty column `tasks.paused`. Every task starts not paused; nothing is converted.
- `create_task` now asks a code task for the paths its change may touch, and for the product when only the product keeps
  the repository. An open code task made on 0.17.0 without paths keeps its route; its head sets the paths before the
  task moves on, as `docs/development-echelons-release-data.md` describes.
- The node image now brings Firefox and WebKit beside Chromium, so it is larger.
- 0.17.0 kept green test results whatever runtimes a part ran on. After the update, clear the results kept before it
  once, as `docs/development-echelons-release-data.md` describes, so the next full run checks those files again.
- Migration 0091 adds the empty table `backlog_items` for each department's work kept for later turns; nothing is converted.

### Added

- A head, the orchestrator or a person with the CEO's rights can pause a task: nothing wakes its holder until someone
  resumes it (`pause_task`, `resume_task` and a button in the task panel).
- `submit` takes a named branch or commit, and refuses a submission without a commit it can read.
- `run_tests` refuses a command that names a test file its pinned commit does not have, before any part goes out.
- `npm run -s deps` puts the dependencies and builds in place in a new worktree, linking the packages its clone installed
  from the same lockfile.
- Nodes prepare Chromium, Firefox and WebKit and check that each one starts, naming the one that does not.
- `test_run` shows how many fingerprints a run brought and how many green results it kept.
- The tasks screen shows one department at a time as a table by turn, and its list of work kept for later turns, which
  its people add to, order by dragging and put into a turn (`backlog` for the orchestrator). A person sees only the tasks
  and lists of their own departments.

### Changed

- The author check runs the tests near a change with coverage, lists the rest of the import graph as left to the full
  run, and checks the types of only the projects the change reaches. On the same change it took 75 seconds instead of
  about 14.5 minutes.
- Gemini 4 Argon and Kimi K3.1 Pro check and hand in work in the strong band.
- Images build by themselves when a new version reaches main, one run of a branch at a time, so a release needs nobody
  to start them.
- An employee hears once about the waits of one holder on them until the work moves, and nobody hears of a wait on
  themselves.
- A blocked task opens again only on its giver's first comment after the block, and blocking a blocked task is refused.
- Program evidence receipts stay out of the employee feed.
- A message for an Antigravity employee at work goes with its next turn, as Antigravity takes typed words as a turn of
  its own.
- A new Tests owner is woken with its open work, an answered task goes back to the status of its stage, a head is never
  picked as checker by itself, and an independent part takes its parent's paths.
- A worker cannot close a coordination task without accepted subtasks in a department that keeps code.
- A person who sees a task sees the true number of findings at each stage; their details stay with those who see the
  whole task.
- The templates and the guide keep connected work with one owner, drop the release check on live programs, and ask for
  reports in plain words with spaces.
- Release tests check Hornhoof's own side only: what it starts, what it types and what it makes of a program's recorded
  output. They no longer run tmux, the agents' programs, npm or the operating system's refusals, depend on the machine's
  speed, or take random ports: every test port comes from a narrow range of its own. Skills and role templates name this
  principle first.

### Fixed

- A test part is accepted from any machine of the class of runtimes that described its run: the same system, libc and
  major versions, whatever the build or processor, so parts that ran on an arm64 Mac count for a run described on x64
  and are no longer refused by Tests. A part goes only to a machine of that class. A run whose describing node lacks a
  runtime its profile needs ends at once and names the runtime.
- The fingerprints of test files name the class of runtimes, not the build of one machine, and a part keeps its green
  results wherever it ran in that class, so a later run on any machine of the class skips unchanged files.
- A product run is laid out by the pace of each free machine, taken from how long the last parts of the repository ran,
  so its parts end at about the same time, and each part goes to the machine it was laid out for while that machine can
  take it.
- The log of a failed test part ends with the name and error of each test that failed, not with what a service said as
  it stopped.
- Quality tools in a test part read the grammars the machine keeps, and a crapper failure says why.
- A preparation step that hears nothing from Hornhoof for a minute stops, a part waits at most ten minutes for another
  machine's build and then builds it itself, and the part's log says each step.
- The local command rule finds a project's workspaces and named packages, names a missing script, and allows named parts
  of Go, Cargo, .NET, Maven and Gradle suites.
- The check command tests pass when the tests run as root, as in a clean `node:22` container.
- A turn is not reported stalled before its program gives its first sign.
- Tests that read the screen once now wait for the state they need.
- Antigravity's own words on its screen no longer look like a question for the subscription owner.
- The tree and speed views of a department with long turns answer at once.
- A checker's result is refused when its model, plan or ability changed before the result was stored.
- A cancelled task's route shows as cancelled, every stage reason is named, and an owner's raw id is never shown.
- A node describes a candidate for Tests again: the node image now ships TypeScript, which choosing the changed functions to
  mutate needs, so such a run no longer ends with `commit_unavailable` before any part goes out.
- A handoff no longer takes the comparison with its base for unknown when GitHub lists a file but shows no patch of it,
  as it does for a large file such as a migration's snapshot. The file's path stays in the candidate and is checked
  against the task's paths as before, the diff names the file with its added and removed lines, and the count of changed
  lines includes them. A patch GitHub cut short, or a comparison of 300 files or more, is still refused.
- A node describes a candidate for Tests again: the node image now ships TypeScript, which choosing the changed functions to
  mutate needs, so such a run no longer ends with `commit_unavailable` before any part goes out.
- On a busy machine a turn no longer ends with "The program did not take Hornhoof's prompt" when the program took it
  during the node's last look: the node looks once more after its time is up, and so does its wait for a program's screen.
- The department schema stands its roles left to right by gates again, as before 0.17.0: architecture, development, then
  each check in order, with "Gate 1", "Gate 2" between them. An employee always stays in its role's frame, and whoever
  leads a stage now is marked there; only teams such as Matrix and observers stand apart.

### Russian

Исправлено то, что останавливало ход 17 и выпуск 0.17.0, чтобы ход проходил свои этапы без ожидания людей: результаты
тестов используются повторно, проверка автора идет минуты, задачу можно поставить на паузу, уведомления и ожидания не
повторяются, сообщение доходит до каждого сотрудника, а ноды проверяют страницы в Chromium, Firefox и WebKit.
Сотрудник снова может сдать работу с новой миграцией базы: GitHub не показывает patch большого снимка миграции, и 0.17.0
отказывала в каждой такой сдаче. Схема отдела снова ставит роли по рубежам, а тесты выпуска проверяют только сторону
Hornhoof.

- Перед обновлением: миграция 0089 добавляет пустой столбец `tasks.paused`, все задачи начинают без паузы, ничего не
  переводится. `create_task` теперь требует у задачи кода пути, которые может менять правка, и продукт, когда репозиторий
  есть только у продукта. Открытая задача кода с 0.17.0 без путей сохраняет маршрут; глава задает пути до следующего
  этапа, как описано в `docs/development-echelons-release-data.md`. Образ ноды теперь содержит Firefox и WebKit рядом с
  Chromium и поэтому больше. 0.17.0 сохраняла зеленые результаты тестов, на каких бы средах ни шла часть: после
  обновления один раз удалите результаты, сохраненные до него, как описано в том же документе, и следующий полный прогон
  проверит эти файлы заново.
- Глава, оркестратор или человек с правами CEO ставит задачу на паузу: никто не будит ее исполнителя, пока паузу не
  снимут (`pause_task`, `resume_task` и кнопка в панели задачи).
- `submit` принимает названную ветку или коммит и отказывает сдаче без читаемого коммита.
- `run_tests` отказывает команде, которая называет тестовый файл, которого нет в закрепленном коммите, до раздачи частей.
- `npm run -s deps` ставит зависимости и сборки в новой рабочей папке, связывая пакеты, которые клон поставил по тому же
  lockfile.
- Ноды готовят Chromium, Firefox и WebKit и проверяют, что каждый запускается, и называют тот, который не запустился.
- `test_run` показывает, сколько отпечатков пришло в прогон и сколько зеленых результатов сохранено.
- Проверка автора запускает тесты рядом с правкой с покрытием, остальной граф импортов перечисляет как оставленный
  полному прогону и проверяет типы только затронутых проектов: на одной и той же правке 75 секунд вместо примерно 14,5
  минуты.
- Gemini 4 Argon и Kimi K3.1 Pro сдают и проверяют работу в сильной полосе.
- Образы собираются сами, когда новая версия попадает в main, по одному запуску на ветку, и выпуск не ждет человека.
- Сотрудник слышит об ожиданиях одного исполнителя на нем один раз, пока работа не сдвинется; об ожидании на самом себе
  никто не слышит.
- Заблокированная задача открывается снова только первым комментарием того, кому ушла блокировка; повторная блокировка
  отказывается.
- Квитанции о свидетельствах программы не попадают в ленту сотрудника.
- Сообщение сотруднику в Antigravity во время работы уходит с его следующим ходом, потому что Antigravity принимает
  набранные слова отдельным ходом.
- Новый владелец Тестов будится со своей открытой работой, задача после ответа возвращается в статус своего этапа, глава
  не выбирается проверяющим сам, а независимая часть берет пути родителя.
- Исполнитель не закрывает координационную задачу без принятых подзадач в отделе, который хранит код.
- Тот, кто видит задачу, видит настоящее число находок на каждом этапе; подробности видят только те, кто видит задачу
  целиком.
- Шаблоны и руководство держат связанную работу у одного владельца, убирают проверку живыми программами при выпуске и
  просят отчеты обычными словами с пробелами.
- Исправлено: часть сохраняет зеленые результаты везде, где шла на средах того же класса, что описали прогон; quality
  tools читают грамматики машины, а отказ crapper называет причину; шаг подготовки, который минуту ничего не слышит от
  Hornhoof, останавливается, часть ждет чужую сборку не больше десяти минут и потом собирает сама, а журнал части
  называет каждый шаг; локальное правило команд находит рабочие пространства и пакеты по имени, называет отсутствующий
  скрипт и пропускает части наборов Go, Cargo, .NET, Maven и Gradle; тесты check-command проходят под root в чистом
  `node:22`; ход не объявляется застрявшим до первого знака программы; тесты ждут нужного состояния вместо одного чтения
  экрана; собственные слова Antigravity на экране больше не выглядят вопросом владельцу подписки; дерево и скорость
  отдела с длинными ходами отвечают сразу; итог проверяющего отказывает, если его модель, подписка или навык сменились до
  записи; маршрут отмененной задачи показывается отмененным, каждая причина этапа названа, а сырой id владельца не
  показывается.
- Исправлено: Тесты принимают часть с любой машины того класса сред, что описали прогон: та же система, libc и
  основные версии, какими бы ни были сборка и процессор, поэтому части с Mac на arm64 засчитываются прогону, описанному
  на x64. Часть уходит только машине этого класса. Прогон, у описавшей ноды которого нет среды, нужной профилю,
  кончается сразу и называет эту среду. Отпечатки файлов тестов называют класс сред, а не сборку одной машины, и
  следующий прогон на любой машине класса пропускает неизмененные файлы.
- Прогон продукта раскладывается по скорости каждой свободной машины, взятой из того, сколько шли последние части
  репозитория, поэтому его части кончаются примерно вместе, и каждая часть уходит той машине, для которой разложена,
  пока та может ее взять.
- Журнал упавшей части кончается именем и ошибкой каждого упавшего теста, а не тем, что сказал сервис при остановке.
- Исправлено: нода снова описывает кандидата для Тестов: образ ноды теперь несет TypeScript, без которого нельзя выбрать измененные
  функции для мутаций, и такой прогон больше не кончается `commit_unavailable` до раздачи частей.
- Тесты выпуска проверяют только сторону Hornhoof: что он запускает, что вводит и как разбирает записанный вывод
  программы. Они больше не запускают tmux, программы агентов, npm и отказы операционной системы, не зависят от скорости
  машины и не берут случайные порты: каждый тестовый порт берется из своего узкого коридора. Навыки и шаблоны ролей
  называют этот принцип первым.
- Сдача больше не считает сравнение с базой неизвестным, когда GitHub перечисляет файл, но не показывает его patch, как
  бывает с большим файлом вроде снимка миграции. Путь файла остается в кандидате и проверяется по путям задачи, как
  раньше, diff называет файл с числом добавленных и удаленных строк, а число измененных строк их учитывает. Patch, который
  GitHub урезал, и сравнение из 300 файлов и больше по-прежнему отказ.
- Нода снова описывает кандидата для Тестов: образ ноды теперь несет TypeScript, без которого нельзя выбрать измененные
  функции для мутаций, и такой прогон больше не кончается `commit_unavailable` до раздачи частей.
- На загруженной машине ход больше не кончается сообщением "The program did not take Hornhoof's prompt", когда программа
  взяла задание во время последней проверки ноды: нода смотрит еще раз, когда время вышло, и так же ждет нужный экран
  программы.
- Схема отдела снова ставит роли слева направо по рубежам, как до 0.17.0: архитектура, разработка, затем каждая проверка
  по порядку, с пометками «Рубеж 1», «Рубеж 2» между ними. Сотрудник всегда в рамке своей роли, а кто сейчас ведет этап,
  выделен там же; отдельно стоят только подотряды вроде Matrix и наблюдатели.
- Экран задач показывает один отдел: таблицу задач по ходам и список работы на будущие ходы. Люди отдела пополняют
  список, меняют порядок перетаскиванием и ставят пункты в ход (у оркестратора инструмент `backlog`). Человек видит
  задачи и списки только своих отделов.
- Миграция 0091 добавляет пустую таблицу `backlog_items` для работы отдела на будущие ходы; ничего не переносится.

## [0.17.0] - 2026-11-09

Give every executable task of Development one required route with one current owner at each stage, let the checkers
repair what they find in the same branch, and close coordination work with a checked report instead of an invented
commit.

### Before you update

- This version replaces the numbered gates of a task with its route. Migrations 0087 and 0088 add the empty route table
  and drop the old gate, panel, stage, merging and bounces columns of tasks. They convert no existing task.
- Before the update, stop new work on the old server, settle running turns and keep a backup of the database. Record
  what the dropped columns hold for each task, then give every existing task its route by hand, as
  `docs/development-echelons-release-data.md` describes. An open task with no decided route stays held.
- Once the columns are dropped and work has moved through the new route, the old server can no longer read the
  database. Going back means the backup with its matching old server.

### Added

- Each executable task follows one route: Architecture when the task is large, Development, Review, Cleanup only when
  the head turns it on, Security when the head requires it or Review finds the risk, and Tests on the final candidate.
  Each stage has one current owner, and task tools and the work tree show the route and its owner.
- A checker is another employee whose model is at least as capable as the producer's. Another provider is preferred
  when one is free; the same provider, plan or tariff is allowed.
- A task without a repository and with no result kind named finishes with a checked report of its accepted parts, with
  no Git candidate made up for it.

### Changed

- Review and Security repair their own findings in the same branch. An ordinary finding no longer goes back to the
  author; work that pursues the wrong goal goes to the head.
- Tests checks the exact final candidate with every repair in it, reuses only results whose fingerprint matches, and
  mutates only changed pure functions that have fast tests.
- The department skills and guides describe the single route. A change to access, root, permissions or secrets still
  passes an independent Security engineer before it reaches any shared branch.

### Russian

У каждой исполняемой задачи Разработки теперь один обязательный маршрут с одним текущим владельцем на каждом этапе.
Проверяющие сами исправляют найденное в той же ветке, а координационная работа закрывается проверенным отчетом без
выдуманного коммита.

- Исполняемая задача проходит один маршрут: Архитектура для большой задачи, Разработка, Ревью, Очистка только по решению
  главы, Безопасность, когда ее требует глава или риск находит Ревью, и Тесты на итоговом кандидате. У каждого этапа один
  текущий владелец; инструменты задач и дерево работы показывают маршрут и владельца.
- Проверяет другой сотрудник с моделью не слабее, чем у автора. Другой провайдер предпочтителен, когда он свободен; тот же
  провайдер, подписка или тариф допустимы.
- Задача без репозитория и без явно названного вида результата завершается проверенным отчетом о принятых частях, без
  придуманного Git-кандидата.
- Ревью и Безопасность исправляют свои находки в той же ветке. Обычная находка больше не возвращается автору; работа
  с неверной целью идет к главе.
- Тесты проверяют точный итоговый кандидат со всеми исправлениями, повторно используют только результаты с совпадающим
  отпечатком и мутируют только измененные чистые функции с быстрыми тестами.
- Навыки отдела и руководства описывают единый маршрут. Правка доступа, root, прав или секретов по-прежнему проходит
  независимого инженера безопасности до любой общей ветки.

Перед обновлением: версия заменяет нумерованные ворота задачи ее маршрутом. Миграции 0087 и 0088 добавляют пустую таблицу
маршрутов и удаляют старые столбцы задач gates, panel, stage, merging и bounces; существующие задачи они не переводят.
Перед обновлением остановите выдачу новой работы на старом сервере, завершите идущие ходы и сохраните резервную копию базы.
Запишите, что хранят удаляемые столбцы для каждой задачи, затем вручную задайте маршрут каждой существующей задаче, как
описано в `docs/development-echelons-release-data.md`. Открытая задача без решенного маршрута остается на удержании.
После удаления столбцов и работы по новому маршруту старый сервер больше не читает базу; откат возможен только
к резервной копии вместе с ее старым сервером.

## [0.8.4] - 2026-11-08

Let the nodes on every computer follow the server to a new build by themselves, release a version without turns of the
programs on real nodes, let GitHub test each commit once and only where its change reaches, and tell an employee once that
someone waits for them.

### Before you update

- A server on 0.8.0 to 0.8.3 does not offer this version, as it waits for a check on real programs that no longer comes.
  Run the install line once on the server's computer to update it.
- On every computer other than the server's own, run the install line once more after the update. It starts the updater
  of that computer's nodes; from then on they follow the server by themselves.

### Added

- Nodes on every computer move to the server's build by themselves, each once its work ends: the install line starts a
  small updater next to them. It reads what the server serves only as data and runs only Hornhoof's own images, each by
  its digest.

### Changed

- A release no longer needs turns of Claude, Codex, Kimi and Antigravity on real nodes. Once the tests passed on main, the
  images built for that commit go out, every published build is offered and installed, and the nodes follow it. The live
  check, its proof, the live check stand, `install.sh check-node` and `install.sh back-node` are gone.
- GitHub tests each commit once, and runs only the tests its change reaches since the last commit whose tests passed. A
  change that reaches everything, such as one of the lockfile, still runs every test.
- A release no longer runs every test on GitHub because it moves the version in the package files and the lockfile:
  where only our own versions moved, the file counts as unchanged. Any other change of them still runs every test.
- A release builds its images faster. A new version alone no longer installs the dependencies or downloads the browser
  of an image again, and each image keeps its build cache next to it on GitHub, so a builder that dropped its own, or a
  new one, does not build the heavy parts again. GitHub's own cache, which took longer to fill than the build, is no
  longer used.

### Fixed

- An employee hears once that someone waits for them on a task. The one who waits can say its wait again with new words
  or a new date while it stands, or within ten minutes after the employee answered on the task, and that tells the
  employee nothing new. A wait on someone else, one after an older answer, or one after the last ran out or its holder
  ended it still tells them.
- An employee can no longer wait for itself by writing its own id in capitals, and is never told that it waits for itself.
- A push to main whose version is out already no longer shows as a failed run on GitHub: the publish job sees the
  version's tag and moves nothing.
- Two node tests that failed now and then on a busy GitHub runner pass every time. In the shared harness test the other
  machine now holds its claim while it builds, so the waiting machine cannot take the build in between, and the Kimi Code
  test waits for the input line to come back after the new program redraws it.

## [0.8.3] - 2026-11-08

Make every skill a self-contained ability and every role a short identity, give each employee an assignment of its own,
let whoever builds or reviews a change check it in their own workspace with its dependencies already in place, and stop
nodes from spending a whole processor core on their program observer.

### Added

- Give every employee an assignment on its card, apart from its role. A head sets the assignment of a worker in its own
  department with set_employee_assignment, and a reset keeps it.
- Split the orchestrator's company skill into structure, staffing, people and resources abilities.
- Mark the commit on GitHub when a run of the whole product passes, so the GitHub build can skip tests that already passed.

### Changed

- Skills of all departments stand alone: none names or relies on another, and any set of ticked skills works together.
- Roles are one line about who the employee is; how it works lives in its skills.
- The generalist developer role is gone: an employee with the skills that cover the whole chain does that work.
- Whoever builds or reviews a change checks it in their own workspace right away: dependency installs, the named test
  files of the change, types, lint, builds and quality checks. Only a whole test suite goes through run_tests, which
  splits it into groups over the free machines. A node refuses a whole suite, a task runner that runs everything and a
  watch mode in an agent's terminal.
- The architect designs new features and changes that reshape the architecture; one feature goes to one developer end to
  end. Below version 1.0 nothing old is kept for compatibility, and existing records are corrected at release.
- Removing what a change made unneeded is a skill a head can turn on for reviewers and developers; it is off by default.
- install.sh back-node returns a node to 0.8.1.
- A change of the templates or the skills checks only the tests that read them, not the whole server and node suites.
  A rule of a test environment can now name test files with `tests` beside its suites.
- Submitting a task starts no test run. The author runs the author check in their own workspace before submitting, and
  the `AUTHOR_CHECK` setting and the `review.authorCheckPlan` field of a submit are gone.
- `npm run check:author` checks the change in the workspace where it is called, instead of printing a line for run_tests,
  and builds the protocol and the node again when their files changed since their last build; its `--plan` option is gone.
- An agent's worktree gets its commit's dependencies from the company's shared harness before its program starts: one
  machine builds them for a commit and every other takes them, as for the full test runs. A worktree that already holds
  dependencies stays as it is, a repository without a test environment costs nothing, and a program never waits longer
  than ten minutes for them.

### Fixed

- Firefox and WebKit start on every node: the node image carries the system packages they need, not only Chromium's.
- On a busy machine, words a person sends to Kimi Code while an assignment waits stay theirs: the turn no longer ends with the answer to them, as the node now tells whose a prompt is by its words, not by when it hears of it.
- A node checks all its programs in one step a second. Before, it copied its whole observer state once for each program
  and delivery it remembered, and with a few hundred of them it sat at 100% CPU with nothing running, so tool and hook
  calls through it timed out.
- An agent may run the project's whole types and lint when their scripts build a workspace by its package name or lint
  every workspace: the node finds a workspace by name and judges the script in each workspace it runs in.

### Before you update

- Update the server before its nodes. Startup applies migration 0086: generalist developers and pending hires of that role
  become developers with their saved skills, and holders of the company skill get the new orchestrator abilities.
- Agents start a new session with their next turn, since their instructions change.

## [0.8.1] - 2026-11-07

Prepare a product's test environment once for the machines that share it, reuse unchanged green test files, and load each
agent's instructions from shared skills and the skills of its department.

### Added

- Build and share reusable test environments per product and machine architecture, updating the parts whose inputs changed.
- Keep green results by test-file fingerprint, run changed dependencies again, and report a mismatch found by a periodic
  full run without reuse.
- Offer a generalist developer role that takes a whole task through its own checks and cleanup.

### Changed

- Choose affected test groups by changed paths; a shared protocol change also selects its consumers.
- Load common instructions, leadership rules and department knowledge as separate skills. Existing heads and employees
  receive the speed skill without replacing their role text.
- Give heads one shared rule for fitting small work into a turn before its final check and choosing the check it needs.
- Require independent Security review before access, root, permissions or secrets changes reach a shared branch, including
  urgent and small fixes.

### Fixed

- Give a test job a writable copy of saved service state while keeping the protection against job-owned links.
- Declare access to the test environment's sharing routes and include its tool in agent tool lists.
- Bind shared environment uploads and publication to the current authorized lease and build attempt, and ignore stale replies.
- Hide repository tokens in manual preparation failures and reject unsupported Yarn PnP environments before sharing them.
- Include file modes, test helpers, configuration and tested Markdown files in reuse decisions, and validate fully reused
  runs before review.

### Before you update

- Update the server before its nodes. Startup applies migrations 0081 through 0085 for saved skills, test results and
  shared test environments. Keep a backup from 0.8.0; there is no down-migration command.
- Nodes must support skill files before agents restart with the new instructions. Older nodes cannot start a role whose
  instructions exceed their inline limit. Applying the generalist role to existing employees is a separate action.
- Nodes without the new sharing contract prepare their environments locally. Shared bundles are rebuilt for the new build
  attempts, and the new fingerprint format invalidates previously cached test results.

### Russian

Среда тестирования продукта готовится один раз для машин, которые ее используют. Неизмененные файлы с зеленым результатом
не запускаются повторно, а инструкции сотрудников собираются из общих навыков и знаний отдела.

- Готовая среда передается между машинами одной архитектуры; при изменении ее входных файлов обновляются затронутые части.
- Результат файла тестов хранится с отпечатком зависимостей. Изменение зависимости запускает файл снова, а периодический
  полный прогон без кэша показывает расхождения с сохраненным результатом.
- Добавлена роль разработчика-универсала, который ведет задачу целиком, проверяет ее и убирает лишнее.
- Группы тестов выбираются по измененным путям. Правка общего протокола выбирает также его потребителей.
- Общие инструкции, правила руководителя и знания отдела подключаются отдельными навыками. Действующие главы и сотрудники
  получают навык быстрой работы без замены текста их роли.
- Главы получают общее правило, как включать мелкую работу в ход до итоговой проверки и выбирать нужную ей проверку.
- Правки доступа, root, прав и секретов проходят независимую проверку безопасности до общей ветки, включая срочные
  и малые исправления.
- Копия сохраненного состояния сервиса доступна тестовому заданию на запись с сохранением защиты от подмены ссылками.
- Для маршрутов общей среды явно заданы правила доступа, а ее инструмент включен в списки инструментов сотрудников.
- Загрузка и публикация общей среды привязаны к действующему доступу, сроку аренды и попытке сборки; запоздалые ответы
  не меняют актуальное состояние.
- Токены репозитория скрываются при сбоях ручной подготовки. Неподдерживаемая среда Yarn PnP не передается другим машинам.
- Повторное использование тестов учитывает права файлов, вспомогательный код тестов, настройки и проверяемые Markdown-файлы.
  Полностью сохраненный результат проверяется перед ревью.

Перед обновлением: сначала обновите сервер, затем ноды. При старте применяются миграции 0081–0085. Сохраните резервную копию
0.8.0: команды обратных миграций нет. Перед перезапуском сотрудников ноды должны поддерживать файлы навыков; старые ноды
не запускают роли, чьи инструкции превышают их предел. Применение роли универсала к действующим сотрудникам идет отдельно.
Ноды без нового протокола обмена готовят среду локально. Общие пакеты среды пересобираются для новых попыток сборки,
а новый формат отпечатков сбрасывает ранее сохраненные результаты тестов.

## [0.8.0] - 2026-11-06

Turn 8: agents on Codex and Kimi Code get their assignments again, and a release reaches machines only after a live check of its
exact build on all four programs. Departments get an owner and approval rules, messages to the outside go through one checked
way, a test run checks one pinned commit, and terminals and panels hold their content on every screen.

### Added

- Give each department an owner and approval rules for each channel, and see and change them in its panel.
- Send messages to people outside the company through one checked way: admission, a last look, exact approvals and model checks,
  also for support replies, on the Outbound screen.
- See how any turn went on the third tab of the speed panel: stages, the critical path and waits, by department.
- Every wait says who answers for it and until when, and one past its date goes to its owner and then to their head.
- The people of a machine hear at once when it goes away, with no agent in between.
- Small tasks take a short way through the checks of a turn, are marked as small, and the speed panel shows how fast they close.
- A task that comes after another gives out at once the part of it that does not depend on the other, and task views show it.
- A team that takes only urgent work refuses the rest.
- Send free-form feedback on a choice request.
- Show and change a repository's full test command on its screen.
- A product can describe its tests in a file of its own, with their services and profiles, and a run prepares them in isolation.

### Changed

- Everyone who may write to an agent writes in its terminal, with no second line under it, and control of the program stays with
  the owner of its plan.
- People see only the agents on their own plans in their departments, and only their work.
- A stuck task goes to its head or the orchestrator, never to the CEO. A turn that failed or ran no program no longer counts
  towards being stuck.
- What a person types or a letter that comes at the end of a turn opens its own turn, in the sender's name.
- How hard a turn thinks follows from why it starts.
- Every part of a test run checks one pinned commit, and review, approval and release are tied to it.
- Machines share one queue for heavy checks, so a machine's own load decides when the next one starts.
- Turn reviews are assigned by the changes in a task, to independent vendors, and bound to the exact commit and evidence.
- The task watchdog tells a head when people stand free while work waits.
- A machine says on the Versions screen what each node waits for before an update, and until when.

### Fixed

- Agents on Codex and Kimi Code receive their assignments again: a node reads the real empty prompt of these programs, also
  after a long session has moved everything else off the screen, and keeps out of a draft a person left there.
- Words a program lost are typed again in the same turn, and words on hold go on by themselves once as soon as the program
  stands ready with an empty input.
- A turn cut off by a node restart runs once more in its own session and for whoever asked for it, also outside a task, and
  never twice.
- Your Enter at an agent's terminal sends its saved words on, also for a session that goes on.
- Operations hears of words on hold within five minutes and can release them with a checked tool that logs who did it and why.
- An update is offered and installed only when its exact build passed a live check on Claude, Codex, Kimi Code and
  Antigravity. Without one, a machine stays on the version it runs, and asking for that version says why.
- The installer holds to that check too: joining a machine, moving its nodes, `--urgent` and `install.sh server` stop with the
  reason and change nothing for a build without one. Only a new server of its own, set up to run a live check, runs such a build.
- Codex no longer asks near the limits of a plan whether to switch to a cheaper model. Nobody was there to answer: the next words were
  lost, Enter answered for them, the turn failed after two minutes and the agent changed model until it started again.
- A turn on Codex ends when Codex says so in its log, so the next words no longer go into a turn that is still closing and run twice.
- The live check of a release runs on real nodes one at a time: `install.sh check-node` moves one named node to the build, and
  `install.sh back-node` puts it back on 0.6.1 at once if its turn fails.
- Words someone left in a program's input are kept before a new assignment or a restart, and the agent's log names who typed there.
- Agent terminals show all their columns, keep your place in the history while output grows, and keep what you type while the
  view reconnects.
- Panels, tables, dialogs and the Notebook hold their content at any width, with room for the scrollbar and buttons in one row
  under the text.
- Long reports stay whole, and a person's feedback may be 12,000 characters long.

## [0.7.0] - 2026-11-05

Turn 7: planned node updates wait for running turns to finish; nodes reconnect on their own and keep Chromium ready in a
read-only cache; direct browser links open every screen; the agent window takes pasted and dropped pictures, and the
program operator handles stuck agent programs from masked screen snapshots.

### Added

- Open any screen, panel or agent window directly from its browser address, share the link and step back with the
  browser's Back button.
- Drag or paste screenshots and images into the agent window so the agent sees them in its turn.
- Change your own display name from your account menu, with a history of name changes.
- Inspect a machine's connection history with disconnect reasons, and see on its card when it waits for running turns to
  finish before a planned update or warns how many turns an immediate update would stop.
- Recover stuck CLI programs through Operations' program operator, which receives masked PNG snapshots of the program
  screen and sends keys when delivery receipts stall, with Operations staffed in full across companies.

### Changed

- Planned node updates now stop assigning new turns to the machine, wait up to a bounded deadline for active turns to
  finish before restarting, and postpone the update with a signal to Operations if a turn is still running at the
  deadline; task watchdogs and the program operator treat update waiting as normal waiting, not a hang.
- Nodes detect silent connection drops on their own and reconnect immediately, and `install.sh` installs the node image
  matching the server's build.
- Worker nodes prepare and verify Playwright Chromium ahead of time in a root-owned read-only cache so checks use it
  without downloading a browser, while regular agent turns keep running even if a node's browser check fails.
- On the home screen, the circle now shows the turn number and a task progress bar instead of the turn goal text, and
  cards in the work tree keep their natural size without squishing.
- In the agent window, the close, minimize and maximize buttons sit on the left of the header, every small panel slides
  out beside the terminal through one shared mechanism, minimized windows stay as edge strips across all screens, the
  yellow "no task" banner is gone, the message box stays visible alongside the terminal for everyone allowed to write,
  and machine access in the orchestrator window is a compact strip supporting multiple machines.
- Notifications always show who sent them, to whom and why, without bare "From Hornhoof" headers, and collapse duplicate
  notices of the same event into one message.
- Every wait now rests on a specific holder, waiting cycles are surfaced to the orchestrator, quiet departments alert
  Operations, and task comments reach the active executor or review panel with delivery receipts.

### Fixed

- Task messages sent with `message_employee` deliver reliably to the holder or queue for its next turn when no live
  terminal is open, and a task's executor can reply about its own task.
- Stale turns now keep their reason, program state and last output lines instead of losing diagnostics, and a cancelled
  wake that never started is recorded as obsolete rather than an agent failure.
- Antigravity and other subscription limits refresh reliably when readings succeed without change and stop showing a
  cached timestamp as fresh when a reading fails.

### Before you update

- Update the server first, then the nodes: the server applies database migrations 0052 through 0060 on startup and adds
  the protocol messages for node update draining, connection history, browser readiness, limit freshness and program
  operator receipts that 0.7.0 nodes send.

## [0.6.2] - 2026-11-04

Words typed into a running turn are no longer lost or delivered twice, and a turn keeps answering the CEO when Hornhoof
or another agent writes into it.

### Fixed

- Live words stay with the turn they were typed into until the program's own record shows it took them, also across a
  restart of the program. Words it never took come back as unheard and go with its next turn, in the same session.
- A paste of several lines is erased from the input box only when the box still shows exactly what the paste left
  there, so the words are neither sent twice nor wiped while a person types.
- The next turn waits for the words of the one before at most 15 seconds after it ended, and stops waiting when the
  machine reconnects, disconnects or no longer runs the agent.
- Notices from Hornhoof and messages from other agents no longer take computer access away from the CEO or the CEO's
  deputy in a turn they started.

### Changed

- The agent doing a task, the agent it is assigned to and the reviewers at its gate can all write about it to other
  employees.

### Before you update

- Update the server first, then the nodes: a node from 0.6.2 tells the server when a finished turn's words settled, and
  an older server does not know that message.

## [0.6.1] - 2026-11-04

Urgent fixes for Antigravity: a new machine no longer fails every turn at its
first-run setup, and its agents have Hornhoof's tools from their first turn.

### Fixed

- Antigravity no longer fails every turn on a machine where it never ran. The
  node picks its colors itself and never accepts its terms or the consent to
  use interactions data for a person: the plan shows "Waiting for the first
  setup", its agents wait without spending retries, and its owner accepts the
  terms by running the install command on that machine again. The choice stays
  on the node's volume across updates.
- Antigravity agents have Hornhoof's tools from their first turn again, so they
  hand in work and give verdicts without detours through subagents. Antigravity
  connects to them only once it takes its first message or opens its MCP panel,
  and that first message works without them. The node now opens the MCP panel
  first, waits until Antigravity has listed Hornhoof's tools, closes the panel
  and only then types the work. If they are not listed within 15 seconds, the
  turn fails as "Hornhoof's tools missing" and is tried again in a new
  Antigravity.
- A turn that is tried again says in one short line why the last try failed,
  without the program's screen, and repeats the work its first try was given,
  not the text of the previous retry.

### Before you update

- Update the server first, then the nodes: a server older than 0.6.1 cannot
  read how a 0.6.1 node ends an Antigravity turn that stopped at the first-run
  setup or without Hornhoof's tools, and that turn can hang.

## [0.6.0] - 2026-11-04

Turn 6: one agent window you can open from anywhere, with the agent's current
task beside its terminal; side panels on the left; a work tree you can move and
zoom.

### Added

- Open the same agent window by clicking an agent on the map, in the work tree,
  in Subscriptions or in Machines, also for an agent that is asleep, and write to
  it from there.
- Open the task the agent is working on now with Task in the window header. On a
  wide screen it opens to the left of the terminal; on a narrow one it takes the
  terminal's place, and you can go back to the terminal.
- Close, minimize and maximize the agent window with the three buttons in its
  corner. A minimized window waits as a thin strip at the right edge and slides
  back out when you click it.
- Move and zoom the work tree with the same gestures and buttons as the map.

### Changed

- Every side panel other than the agent window, Speed included, now opens on the
  left, in the same place.
- Agents you cannot open are shown as plain names in Subscriptions and Machines
  instead of buttons that led to an empty window.
- Developers, code reviewers and security engineers now install a project's
  dependencies before they run its checks, so they no longer lose turns on tools
  that seem to be missing.
- The node image includes ShellCheck 0.11.0, so agents can check shell scripts.

### Fixed

- Task in the agent window opens the agent's actual current task, also for the
  orchestrator and for employees of a product.
- Pressing Escape to close a side panel, the account menu or a dialog no longer
  stops a busy agent.
- A minimized agent window no longer hides the live line of a department or
  keeps room for itself on the map.
- Ctrl+O right after new messages appear folds or unfolds the log instead of
  being lost.
- If the company could not be loaded, opening an agent from Subscriptions or
  Machines now shows the error instead of doing nothing.

## [0.5.1] - 2026-11-04

An urgent fix: a message that reached an agent during its turn no longer comes
to it a second time.

### Fixed

- Count a message as delivered when the agent reads it during a turn in Claude
  Code. Claude Code records words pasted over several lines in its own wrapper,
  the node did not recognize them, and Hornhoof gave the agent the same message
  again as a new turn.

## [0.5.0] - 2026-11-04

Turn 5: one work tree for the whole turn, closed tasks that stay quiet, clearer
plan and machine screens, and node restarts that say why they happened.

### Added

- See the whole turn in one work tree: every task, every review and the final
  check, what each agent's program is doing, and who waits for whom since when.
- Mark a task as waiting for an outside event, with a reason and a deadline, so
  it is not reported as stuck while it waits.
- Get a plan's connect command at once in two places: a block on top and the
  plan's row "Waiting for a machine", with the time it stays valid. "Done" hides
  only the block; the command works until it is used or 24 hours pass.
- Make a deputy CEO in "Edit" on the People screen: a deputy sees the whole
  company and takes the CEO's decisions. A short "Dep" badge marks the name.
- Put a person alone in a sub-unit of a department, with a direct line from the
  head (used for urgent fixes).
- Open "About" from the account menu: what Hornhoof is, its version, developer,
  license and links.
- See why a node restarted: which node, planned or not, and the end of its log.
- See the node build: machines whose nodes run another build than the server
  are marked "Other build", with the update command.
- Choose Antigravity models and use Antigravity's own terminal screen.

### Changed

- A plan that does not work shows one full-width block on its card: what is
  wrong and where, the action that fixes it (copy the update command, sign in or
  make a new command) and "Remove". Limits, agents and controls come back once
  it works.
- Signing in on a node that is too old names the machine and gives the update
  command with "Copy".
- Nodes update agent programs when they start and on the update button, never
  in the middle of a turn.
- A second connect command for the same place is refused while the first one
  is still valid.
- Retry and continue send the text that was asked for, without later additions
  from the queue.
- Versions follow turns: turn N is version 0.N.0, urgent fixes between turns
  are 0.N.1, 0.N.2.
- The node image includes the GitHub CLI (gh).

### Fixed

- A closed task no longer wakes anyone: no late comments, no "merge after
  gates" and no retries after an interrupted turn.
- When a task it waited for is cancelled, the waiting task's creator is told.
- A reviewer moved into a sub-unit leaves the reviews it was on.
- Text pasted into an agent's terminal can no longer end the paste early.
- An agent's answer after Stop goes to the right turn.
- A turn on the built-in node cut off by a server restart gets its real reason
  instead of "unknown".
- Reconnecting a plan no longer leaves an old record behind, and a node silent
  for a day is no longer shown as ready.
- After a plan reconnects, the old machine's connection is closed and can no
  longer act for the new node.
- Dots on the map lines no longer vanish with "reduce motion".
- Agents no longer receive the node machine's CLAUDE_CODE_AUTO_COMPACT_WINDOW.
- The server log no longer shows the FSTDEP023 warning.

### Before you update

- Database migrations 0045, 0047 and 0049 to 0052 run on start. They add
  indexes and columns. 0051 clears leftovers of earlier plan reconnects: an
  older plan still waiting for a machine, with no agents and no work, is
  removed with its nodes and saved sign-in when the same owner has a newer
  ready plan of that provider; nodes shown as ready without a key, or of a
  removed plan, are set to "needs sign-in". Removed rows do not come back if
  you return to 0.4.
- Every node restarts once on the new image.
- Update a node on a Mac with the command from the machine card, without
  `--join`.
- Install commands made before this version keep working until a new command
  is made for the same place or 24 hours pass.
