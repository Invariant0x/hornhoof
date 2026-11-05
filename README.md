![Hornhoof](.github/assets/logo.svg)

# Hornhoof

**All your AI plans. One company. Every computer you own.**

You pay for Claude, ChatGPT and maybe Kimi or Google, and use one at a time. Twelve terminal tabs, no idea which agent is doing what, and every change waits for you to read it.

Hornhoof turns those plans into one company of AI agents: an orchestrator, departments, heads and employees. You say what you want in plain words. They split it into tasks, work at the same time on all your plans and all your computers, check each other's work, and bring you the result to approve.

It runs on your own machines. No sign-up, no account with us, no Hornhoof cloud. Free and open source.

![The company map](.github/assets/map.gif)

```sh
curl -fsSL https://raw.githubusercontent.com/Invariant0x/hornhoof/main/scripts/install.sh | bash -s -- server
```

Works with Claude Code, Codex (ChatGPT plans), Kimi Code, the GLM Coding Plan and Google Antigravity, plus Anthropic and OpenAI API keys. macOS and Linux.

> **Hornhoof is built by a Hornhoof company.** Its development runs inside Hornhoof itself: 32 agents on Claude, ChatGPT, Kimi and Google plans, in Development and Operations, on two computers, with the CEO approving each release. So far they have run 8 turns and closed more than 330 tasks.

## What you get

- **All your plans at work, at once.** Developers on Claude, Codex, Kimi and Google take different parts of the same job at the same time. While one plan waits for its limit, the others keep going.
- **All your computers as one.** Your laptop, an old Mac and a home server share the work and run the tests. If the computer with the server turns off, another one takes over within a minute, at the same link.
- **Every change checked by a different AI.** Code written on one maker's model is reviewed by the models of the other makers at the same time, then by security, then by one test run of the whole turn.
- **One map instead of twelve tabs.** Every agent, what it is doing right now, and its real terminal live in your browser, whichever machine it runs on.
- **You decide, they do.** Questions, approvals and stuck tasks wait for you in one list. Each turn of work ends in a numbered release, and nothing reaches your main branch until you approve the exact commit.
- **It stays yours.** Agents run in locked boxes on your machines, sign-ins stay sealed to their owners' computers, and the optional public link cannot read your traffic.

## Hornhoof is for you if

- ✅ You pay for more than one AI plan, and most of them sit idle while you work in one.
- ✅ You have ten Claude Code or Codex windows open and no longer remember which one does what.
- ✅ You want to give a goal and get a checked result, not babysit every step.
- ✅ You and a few friends each have a plan and want to build something together.
- ✅ You have a spare laptop, a home server or an old Mac doing nothing most of the day.
- ✅ You want to look in, answer and approve from your phone, wherever you are.

## Why it is faster

- **A pool of developers, not one.** A department gets as many developers as your plans can carry, eight or more, each on its own branch and its own copy of the code. The head gives each of them a whole feature, so they do not wait on each other.
- **Tests run on your freest computer.** When an agent runs the tests, Hornhoof sends them to the machine with the most room, and splits a big suite over several machines at once. The agent keeps working meanwhile. A machine busy at 90% or more gets no new work.
- **Limits do not stop the job.** When a plan hits its limit, the task goes to an employee of the same role on another plan, or waits and resumes by itself when the limit resets. You choose how much of each plan the company may use, from 50 to 90%, so some is always left for you.
- **Checks only where they matter.** Research and docs pass with none. Code gets one review stage, where a reviewer of each maker reads the same change at the same time. Security review joins only when a change touches sign-in, access or secrets. The whole suite runs once per turn, not once per task.
- **The company keeps itself moving.** A watchdog in Operations wakes every 10 minutes while there is work, nudges a stuck agent, and tells its head when the nudge did not help.

## Why the result is better

- **A real pipeline.** Architect, then developers, then code reviewers of every maker, then security, then one final test run of the whole turn. The schema on the screen shows it, and a yellow line shows every piece sent back.
- **Different makers, different blind spots.** Claude, GPT, Kimi and Gemini fail in different ways. Hornhoof puts them in the same review, so a change passes only when all of them agree.
- **Fixes start with a failing test.** A bug is first reproduced by a test, then fixed. Before a release, the riskiest logic is checked with mutation testing, so tests that would pass on broken code get caught.
- **Design you pick by eye.** A design team of two or three designers on different models draws variants of the same screen. You get them side by side and pick one with a click.
- **It learns from its own mistakes.** Every three hours an agent in Operations reads what failed and where agents stumbled, and proposes fixes. They wait for you under Improvements, and one click turns a proposal into a task.

## Why you stay in control

- **One place to answer.** Every question, approval and stuck task waits at the top of Tasks. You answer there, or write to any agent's terminal directly.
- **Turns and versions.** Your words become a turn: a title, the main point and separate tasks. Each turn ends in a release with its own version number, and the Versions tab shows the git tree.
- **Watch any agent live.** Open an employee and you see its real Claude Code, Codex, Kimi or Antigravity terminal, as it happens.
- **Switch agents on and off.** One tick on the schema. The head spreads the work over the agents that are on.
- **The orchestrator can do what you can.** Hire, move, rename, change a plan or a model, open a task, take an improvement: just ask him. Only people and access stay yours.

## Built for teams

- **Access by department.** Give each person a list of departments. They see only those, and inside them only the agents that run on their own plans.
- **A deputy next to the CEO.** Someone who runs several departments shows up beside you on the map.
- **Each department's owner approves its own work**, for every change, by template, or not at all. The CEO hears only about missed goals.
- **Friends bring their own plans.** Each connects their plan on their own computer. Their sign-in is sealed to their machines, and their agents work for the shared company.
- **Several products, several companies.** Put each product under a department with its own repository. Run two or three separate companies side by side on one computer.

## All your computers, one company

- **One pool.** Connect any Mac or Linux machine with one command. It does not need an AI plan: it can simply lend its power. The Machines tab shows the whole pool: cores, free memory and load, and what runs where right now.
- **No single point of failure.** Your machines get numbers: 1 runs the company server, 2 and 3 keep a full copy of its data. If machine 1 stops, machine 2 takes over within about a minute, by itself, under the same link. You can move the server to any machine with one click.
- **Every machine opens the company.** It is at `localhost` on each of your computers, and at your public link from anywhere.
- **Sign in once, run anywhere.** A plan you sign in to works on any of your machines. A ChatGPT plan moves by itself when its machine goes offline.
- **Encrypted backups on your other machines.** Every 6 hours and before each update. The machines that keep them cannot open them: only the company's own machines and the recovery file you save can.
- **Cut off? It keeps going.** If your machines lose sight of each other, each side with internet goes on, and Hornhoof merges both sides when they meet. A real conflict goes to the orchestrator, who asks you.

![The pool of machines](.github/assets/machines.png)

## Hornhoof next to the alternatives

"Parallel agent apps" are the tools that run several coding agents side by side, each on its own copy of the code.

| | One AI program | Parallel agent apps | Hornhoof |
| --- | :---: | :---: | :---: |
| Agents of different makers work on one job at the same time | ❌ | ⚠️ side by side, you coordinate | ✅ |
| A main agent splits the work and hands it out | ❌ | ⚠️ some | ✅ |
| Each change is reviewed by models of the other makers at once, then security, then one test run of the whole turn | ❌ | ❌ | ✅ |
| Work goes on when a plan hits its limit | ❌ | ❌ | ✅ |
| Tests go to the freest of your computers, split across several | ❌ | ❌ | ✅ |
| Keeps running when the computer with the server turns off | ❌ | ❌ | ✅ |
| Live terminal of every agent in the browser, on any machine | ❌ | ⚠️ this computer only | ✅ |
| Several people, each with their own plans and departments | ❌ | ❌ | ✅ |
| Departments beyond code: marketing, sales, support, home | ❌ | ❌ | ✅ |

## How it works

The pictures show Moonfern, a made-up company. Its people, plans and work are invented for the demo.

1. **Install and pick a template.** One line in the terminal, then name your company and pick one of nine templates, from a startup to a home, or start empty.

   ![Setting up a company](.github/assets/setup.gif)

2. **Connect your plans and computers.** Each plan signs in once and runs in a locked box of its own. Each computer joins with one command.

   ![Connecting AI plans](.github/assets/subscriptions.png)

3. **Tell the orchestrator what you need.** He proposes departments and people, and you click once to build them. Then each request becomes a turn, a batch of tasks like a sprint: the heads hand out the work, you watch it move, and you approve the result.

   ![Building the departments](.github/assets/build.gif)

   ![The Development department at work](.github/assets/development.gif)

   ![An employee's terminal](.github/assets/terminal.gif)

   ![Tasks and turns](.github/assets/tasks.gif)

## What people build with it

- **A solo developer with three plans.** Claude, ChatGPT and Kimi stop taking turns. Eight developers work through the backlog overnight, reviewers of the other two makers check each change, and in the morning one approval ships the turn.
- **A two-founder startup.** Development, design, marketing and business development from the Startup template. The founders split the departments between them, each sees their own, and both bring their own plans.
- **An agency.** Sales, delivery and support for client work, with each client's product in its own repository.
- **A cybersecurity company.** Development with security reviewers and a red team, plus operations, sales and support.
- **A home.** A department for the Wi-Fi, router and smart home, and a household department for shopping, bills and the family calendar. Anything that touches a real device or spends money waits for a person to say yes.

More, with what to set up for each, is in [EXAMPLES.md](EXAMPLES.md).

## Good to know before you start

- **It spends your plans.** A busy company uses its limits much faster than one person in one chat. Set how much the tasks may use, and watch the limits on the Subscriptions tab.
- **Agents still make mistakes.** Reviews catch many of them, not all. That is why nothing ships without your approval. Give agents only the access they need, like a token for one repository.
- **Read your AI plan's terms.** Each maker has its own rules for how its plan may be used.
- **Each agent is a real program on your machine.** More agents need more memory and processor. Spare computers help.
- **macOS and Linux only.** Windows is not supported.
- **Machines in different homes talk through the public link.** If the way to it is down, they wait and catch up later. Machines in the same home keep working directly.
- **Hornhoof is young.** It works and changes fast. Expect rough edges, and tell us about them.

## Your company stays yours

- It runs on your machines. There is no Hornhoof cloud, no account with us, and no Hornhoof server that holds your company.
- Its database sits only on machines of the CEO and of people who see the whole company. Backups are encrypted.
- Every agent works in a locked box: a Docker container with no folder of your computer in it, where it runs as a user of its own and cannot read the machine's keys or other plans.
- Root on a machine opens only when that machine's owner allows it, for a day at most. Nobody else can allow it, the CEO included.
- A plan's sign-in opens only on its owner's machines. Keys and tokens show as `[hidden]` in every terminal and every output.
- The hornhoof.org link is optional. Your traffic stays encrypted all the way to your own machines: the link passes it on without being able to read it, and keeps no copy.

[SECURITY.md](SECURITY.md) explains each point, and how to report a problem.

## What comes next

- **Machines in different homes, connected directly**, without going through the public link.
- **More machines holding the company's data**, five out of ten instead of three.
- **Faster updates of the copies**, without remaking them from scratch.
- **Phones as workers.** An old Android phone on a charger runs work as a machine of its own, and any device with a browser lends itself by keeping a page open.
- **Departments on their own turns.** Development on turn 8 while marketing is on turn 3, each with its own progress on the map.
- **Styles for the interface.** Pick the look you like in Settings, from today's cyberpunk to something calmer.

## Install

You need a computer with macOS or Linux. Docker is installed for you if it is missing.

1. Open a terminal. On a Mac, press `Cmd` and `Space`, type `Terminal` and press `Enter`. On Linux, like Ubuntu, press `Ctrl`, `Alt` and `T`.

2. Copy this line, paste it into the terminal and press `Enter`:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Invariant0x/hornhoof/main/scripts/install.sh | bash -s -- server
   ```

3. It may ask for your computer's password, to install Docker. If Docker Desktop is installed but not running, it starts it.

4. Wait a few minutes. At the end it shows a link like `http://localhost:8080/setup?code=...`.

5. Open that link and follow the steps. Name your company, pick a template, and create your account: you become the CEO. Then choose how the orchestrator runs. "My subscription" gives you one more command to run. It opens your plan's sign-in page, and the orchestrator starts as soon as you sign in.

Now you are on the map, with the orchestrator in the middle. Click him and tell him about your company.

### Add more later

- **Another computer:** Machines, "Connect a machine", "Copy", and run the command on that computer.
- **Your AI plans:** Subscriptions, "Connect a subscription", tick your plans, "Get the command", and run it on the computer that will carry them. Or sign a plan in once on the Subscriptions tab, and it reaches every machine of yours.
- **A friend:** People, "Invite person", fill in their name and email, tick what they may see, "Send invite", then "Copy link", and send them the link.
- **Updates:** when a new version is out, Hornhoof shows a banner with an "Update" button, and every machine moves to it.

### Remove it

- From a connected computer: `curl -fsSL <your Hornhoof address>/install.sh | bash -s -- --uninstall`.
- The server: run `docker compose down -v` in the `~/hornhoof` folder and delete the folder. This deletes all of the company's data.

## Questions

**Does Hornhoof cost anything?**
No. You use the AI plans you already have. Hornhoof itself is free and open source.

**Which AI plans work?**
Claude plans through Claude Code, ChatGPT plans through Codex, Kimi Code, the GLM Coding Plan from z.ai, and Google AI Pro or Ultra through Antigravity. A company can also use Anthropic or OpenAI API keys.

**Does my data go to you?**
No. Your company lives on your own machines. The AI programs send your prompts and code to their makers, as they always do. The optional hornhoof.org link passes encrypted traffic on to your machines and cannot read it. [SECURITY.md](SECURITY.md) says exactly what it sees.

**How is this different from Claude Code or Codex?**
Hornhoof uses them. They are the employees, and Hornhoof is the company around them: departments, tasks, reviews, machines and one view of it all.

**Is it only for code?**
No. There are templates for marketing, sales, support, research, finance and the home.

**What happens when a computer turns off?**
If it ran the company server, the next machine in line takes over within about a minute, under the same link. Its agents move to another machine with the same plan, or wait until it comes back. A test run it was doing starts again on another machine.

**Can I use my phone?**
Yes, to watch, answer and approve from the phone's browser. Phones that do work themselves are coming next.

## What Hornhoof is not

- It is not a cloud service. There is no sign-up and no account with us.
- It is not a new AI. It runs the AI programs you already use.
- It is not a chat. Work is tasks, each with an owner, a review and a result.

## Help build Hornhoof

Hornhoof is built by a few people and a lot of agents, and we are looking for more of both. You can:

- try it and tell us what broke or what confused you;
- bring ideas for what would make your own company of agents work better;
- translate the screens, which are in English and Russian now;
- write templates for departments, roles and skills;
- fix and build things, starting with an issue marked "good first issue".

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Please read the [code of conduct](CODE_OF_CONDUCT.md), and report security problems privately, as [SECURITY.md](SECURITY.md) says.

## Learn more

The [guide](guide/README.md) explains how Hornhoof works, one topic per page:

- [Install and run the server](guide/install.md): what the install line does, several companies on one computer, running from source, your own domain, and a forgotten password.
- [The link on the internet](guide/public-link.md): how people open your company from anywhere, and who can reach it.
- [Machines and plans](guide/machines-and-plans.md): how to connect your AI plans and computers, how agents are kept apart, and what happens when a plan hits its limit.
- [The orchestrator](guide/orchestrator.md): what the main agent can do for you, and what stays with people.
- [Departments and employees](guide/departments-and-employees.md): the department schema, hiring, an employee's window and terminal, switching agents off, and reviews at a gate.
- [Tasks and turns](guide/tasks-and-turns.md): how your words become tasks, which checks they pass, and what happens when an agent gets stuck.
- [Repositories](guide/repositories.md): how a department gets a git repository, and where its token goes.
- [Tests and heavy work on free machines](guide/free-machines.md): where tests run, which machines take them, and what happens when a machine goes away.
- [Updates](guide/updates.md): how a new version arrives, how to go back, and how to take back a public link after an update went back.
- [Security](SECURITY.md): how Hornhoof keeps your company safe, and how to report a problem.

## License

Hornhoof is free and open source under the [MIT License](LICENSE). Copyright (c) 2026 Ivan Korol.

The templates in `templates/` and the programs every node carries come from projects with their own licences, which `templates/SOURCES.md` lists.
