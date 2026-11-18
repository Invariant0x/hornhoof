# Machines and plans

> In short: agents run on machines that hold the AI plans. You connect a plan with one command on your own computer and sign it in once in Hornhoof. It then runs on any of your machines, and Hornhoof keeps the sign-in sealed so that only those machines read it. A machine can also join with no plan, just to lend itself to test runs.

## Where do agents run?

Agents run on machines that hold the subscriptions.

- Company API keys run on the built-in node that comes with the server.
- A personal plan runs on its owner's machines: Linux, macOS, or Windows with Docker Desktop.

## Connect your plans

1. Open Subscriptions and click "Connect a subscription".
2. Tick the plans this machine will carry, click "Get the command" and copy it.
3. Run it in a terminal on that machine. The command works once, for 24 hours.

On Windows, copy the command shown for Windows and run it in PowerShell. Nodes on Windows run in Docker Desktop. When it is missing, the command installs it, with WSL 2 it runs on if Windows lacks that: it first says what it installs and that Docker Desktop has its own terms (free for personal use and small companies), and Windows asks once to allow the changes. When Windows then needs a restart, the command says so, and after you sign in again it goes on by itself in a PowerShell window. When Docker Desktop is there but not running, the command starts it and waits for it. Hornhoof needs no Docker account. The command then does the same as on a Mac or Linux, in a container of Hornhoof's own image, and a sign-in link appears in PowerShell for you to open. A Windows computer that runs the Hornhoof server itself, in WSL, adds its plans with the Mac and Linux command in the Ubuntu terminal of WSL.

The command installs Docker if needed and starts one small locked-down container per subscription. A plan you already signed in once in Hornhoof reaches the new machine by itself within seconds. The command signs the others in there:

- Claude opens the claude.ai login for your Claude plan.
- Codex opens the ChatGPT device login for your ChatGPT plan.
- Kimi opens the Kimi Code login.
- GLM asks you to paste your GLM Coding Plan key from z.ai.
- Antigravity, Google's agent program for a Google AI Pro or Ultra plan, opens the Google sign-in. Google then shows a code: paste it into the terminal where the command runs. On a machine where it runs for the first time, Antigravity then asks you to accept its terms of service and to choose whether Google may use your interactions data: read its screen and choose Done. Hornhoof picks its colors but never accepts the terms for you. Until you do, the plan shows "Waiting for the first setup" and its agents wait; to do it later, run the install command again without --join.

![Connecting AI plans](../.github/assets/subscriptions.gif)

## Sign in once for all your machines

On Subscriptions, the owner of a plan signs it in once, and it runs on any of their machines:

- Claude and Codex: click "Sign in". A terminal opens under the plan's row, on one of your machines that is online. Only you see it and type into it, the CEO neither. Follow the steps in it. Claude gives a sign-in that lasts a year.
- Kimi and GLM: click "Paste the key", get the key from the provider's page and save it. The browser seals the key before it leaves, so Hornhoof never sees it.
- "Sign in with another account" replaces the sign-in on all your machines of the plan.

Each machine has a key of its own. The sign-in is sealed to every machine of the plan with that machine's key, so Hornhoof stores it and passes it on without reading it. A machine you connect later gets it from one of your machines that has it.

Codex renews its sign-in as it works, and the old one stops working. So a Codex plan runs on one of your machines at a time, and the tab says which. When that machine has been away for 10 minutes, another machine of the plan that is online takes over.

The tab also names the tier each plan runs on, as "Codex, Pro". A free Codex plan cannot use the newer models. When machines of one plan are signed in to different accounts, the tab says so.

## What can agents use on a machine?

Every node carries git, ripgrep and headless Chromium, Firefox and WebKit with Playwright, so agents can open and check web pages in all three browser engines. Anything else they need they install into their own folder.

## Who can give work to my agents?

Agents will run on that machine with your subscription. People with access to this Hornhoof can give them work.

## How are agents kept apart on one machine?

Inside its container the node runs as root, and its agents run as a user of their own. That means:

- no agent reads the node's key or changes its programs;
- no agent types into another agent's terminal;
- the node takes a tool call only from the program of the agent it belongs to.

Agents that share one subscription still share that user and its sign-in. So they can read each other's folders and the repository tokens they work with. Give departments whose work must stay apart subscriptions of their own.

## Update or remove the nodes on a machine

- The nodes on a machine move to the node image of your server's own build by themselves, each once its work ends (see [Updates](updates.md)), so update the server to get newer nodes. A machine set up before 0.8.4 does so only after you run `curl -fsSL <your Hornhoof address>/install.sh | bash` on it once.
- The same command updates them now. It waits for what each node runs to finish, and tells you what it waits for; if you stop it, nothing changes. For a security update, end the command with `bash -s -- --urgent` instead of `bash` to replace them now, which stops what they run.
- To remove them and their updater, end the same command with `bash -s -- --uninstall`.
- On Windows, the same in PowerShell is `powershell -ExecutionPolicy Bypass -c "irm <your Hornhoof address>/install.ps1 | iex"`. To replace them now or to remove them, run `powershell -ExecutionPolicy Bypass -c "& ([scriptblock]::Create((irm <your Hornhoof address>/install.ps1))) --urgent"`, or the same with `--uninstall`.

## Update agent programs

Open a machine's card to see the versions of Claude Code, Codex and Kimi Code its nodes run. GLM uses Claude Code and follows its updates. The machine's owner, or a person with access to the whole company, can click "Update programs".

The node updates its configured programs when it starts and when you press that button. There is no scheduled update. The programs' own automatic updates are disabled inside agent sessions, and agent users cannot change the shared program files.

An active turn keeps running. After the update, the next turn sent by Hornhoof resumes the same session using the installed version. These turns wait for an update in progress, even when it leaves the version unchanged. Typing directly into an already open program keeps using that process until Hornhoof starts its next turn there. A failed update is marked on the card and can be retried.

Versions are available only while the node is connected. An older node that does not report versions needs a Hornhoof node update first. The built-in node's programs appear on its physical server's card when that machine is registered, or on the separate built-in card for people with company access.

## Can a machine join without a plan?

Yes. Open Machines, click "Connect a machine" and run the command on that machine.

It starts one container with nothing to sign in to. The machine lends itself to the company's test runs like any other machine. Machines lists it as its owner's, with no plan.

## Add a plan to a machine that already joined

The owner clicks "Add my plan" on the machine's card. That gives a command for this machine only. It starts the plan's node there. A plan signed in once in Hornhoof gets its sign-in by itself; any other is signed in there.

One plan can run on several machines of its owner this way.

## Which machine does an employee work on?

- An employee stays on the machine it started on while that machine is online and signed in. So it keeps its folder, session and terminal there.
- A new employee, or one whose machine went away, starts on whichever machine of its plan its nodes say is freest. Among machines about as free, it takes the one with the fewest agents.
- Such an employee starts in a fresh session that catches up from the conversation.
- The employee's card shows the machine it works on.

## When does a new agent program wait?

Hornhoof sets no memory or processor limits of its own for agents. A machine's node reports every 20 seconds whether the machine's system had to kill a program for want of memory since its report before.

- After such a report, a turn that would start a new agent program on that machine waits, and so does a one-shot call there. The machine's card and the agent's window say "The machine reported a shortage of memory".
- The turns and calls wait in their order and start by themselves with the first report that finds no new kill.
- Programs that already run there go on and take their turns as before, the orchestrator's and the heads' as everyone's.
- A machine that does not count such kills, a Mac for one, never holds a program for memory.

## What happens when I disconnect a machine?

Disconnecting a machine stops everything on it. A plan that runs nowhere else waits for a machine again.

## Why did my machine drop off?

Open the machine's card on the Machines screen. **Connection to the server** sums up the last 24 hours in plain words, such as "5 drops in the last 24 hours, 40 s on average. Most often: the network cut the connection.", and lists the latest drops: when each one happened, how long the machine was away, why, and the close code.

- Each plan on a machine has its own connection, so a router going down breaks them all at once. Connections that break within a minute of each other count as one drop.
- **The machine saw** is what the machine itself reported once it was back, such as a failed DNS lookup, how many tries it took, sleep or a change of network. A machine on an older build reports nothing, and only what the server saw is shown.
- Taking a plan or a machine off in Hornhoof is not a drop.
- The card is for the machine's owner and for people who see the whole company. The built-in node has no history here, as it has no machine of its own; its connections go to the server's log.
- Hornhoof keeps this history for 14 days and at most 2000 connections per machine. The orchestrator can read it from the database, table `node_connections`, and only Hornhoof writes it.

## Can the orchestrator make these commands?

Yes, when the CEO asks. The command then shows on the CEO's screen, as a card in the orchestrator's window. The orchestrator itself gets only a line saying that it is there.

The command's code never reaches an agent, its terminal or its conversation. A conversation that holds such a command keeps it with the code hidden.

## What happens when a plan hits its limit?

A plan at its usage limit holds its agents' turns until the limit starts over, and their tasks go on after it. An agent's turn is one round of its work: [Tasks and turns](tasks-and-turns.md#what-is-a-turn) explains it.

When an employee's turn on a task ends without moving the task while the employee's plan is at its limit, the task can go to another employee. It goes only when all of this holds:

- The task was given to this employee, is open or in work, goes through stages and is still at Architecture or Development, with nothing handed in for checking yet.
- None of the employee's turns on the task did any work: each one that started, the plan refused for its limit within three minutes. What a turn did lives in the employee's folder on its machine and may not be pushed, so work that was begun stays with the employee.
- The employee is not in a sub-unit.
- The other employee has the same role in the same department, is switched on, is not in a sub-unit, works on a plan of another provider, and works for the task's product or for no product.
- The other employee's turn would go out now: signed in, on a machine that is on and not winding down for an update, with its plan neither at its limit nor past its "Tasks may use" share.

Of those who fit, the one hired first takes the task. The task gets one note: whose plan is at its limit until when, who takes the work over, and on which plan. Otherwise the employee goes on with the task once the limit starts over. Heads and the orchestrator always keep their work and wait for the reset.

Hornhoof learns about the limit from the plan's own figures, or from the error its program prints, like Kimi's 429 or Codex's "hit your usage limit". When the program names no time, Hornhoof waits for the reset the plan's own figures named, if that is still ahead, and otherwise tries again after a quarter of an hour.

## Keep part of a plan for yourself

Next to each plan's limits, "Tasks may use" sets the share of every limit window that task turns may spend: from 50 to 90 percent, or the whole limit.

Past that share, an employee's task turns wait for that window to start over. Its turns outside tasks, like answers to people, still go. The share holds back only employees: heads and the orchestrator go on coordinating above it.

[Back to the guide](README.md)
