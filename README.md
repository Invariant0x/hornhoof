![Hornhoof](.github/assets/logo.svg)

# Hornhoof

**Your own company of AI agents: any models, your own computers.**

Hornhoof is a system for running AI agents as one company. It works with any models: through subscriptions like Claude, ChatGPT, Kimi, GLM or Google, through API keys, and with new models as they come out. You describe the task in plain words. The orchestrator, the main agent, splits it between departments, each with a head and employees, and agents on different models check each other's work. You see everything on one map and get the finished result.

It is your own virtual cloud. It runs on the computers you connect, one or many, yours or your team's. No cloud provider, no third-party servers, no account to make. Free and open source.

## Hornhoof is for you if

- ✅ You have many Claude Code or Codex windows open and no longer remember which one does what.
- ✅ You and a few friends want to build something together, and each of you has your own AI plans.
- ✅ You pay for more than one AI plan and want all of them working, not waiting.
- ✅ You have a spare laptop, a home server or an old Mac that sits idle most of the day.
- ✅ You want to give a goal and get a checked result, not watch every step.
- ✅ You want your home looked after too: devices, network, shopping, bills.
- ✅ You want it all on your own machines, under your own control.

## What changes

| | AI programs on their own | With Hornhoof |
| --- | :---: | :---: |
| Your plans and your friends' plans work on one job at the same time | ❌ | ✅ |
| Work goes on when a plan hits its limit | ❌ | ✅ |
| Every change is reviewed by AI of other makers, then security, then tests | ❌ | ✅ |
| One map shows every agent, what it does now and who stands idle | ❌ | ✅ |
| Spare computers take the tests and heavy jobs | ❌ | ✅ |
| The company keeps running when one of your computers stops | ❌ | ✅ |
| Nothing reaches your main branch without your approval | ❌ | ✅ |
| Departments beyond code: design, marketing, sales, the home | ❌ | ✅ |
| Runs on your own machines, with no sign-up | ✅ | ✅ |

"AI programs on their own" means Claude Code, Codex, Kimi Code and the like, each in its own window. Hornhoof runs them for you as one team.

## How it starts

The pictures show Moonfern, a made-up startup of three friends with seven AI plans and ten computers. Its people and work are invented for the demo.

1. Install Hornhoof with one line in the terminal. On a Mac, press `Cmd` and `Space`, type `Terminal` and press `Enter`. On Linux, press `Ctrl`, `Alt` and `T`. On Windows, open the Ubuntu terminal of WSL. Docker installs itself if it is missing.

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Invariant0x/hornhoof/main/scripts/install.sh | bash -s -- server
   ```

2. Open the link it shows, name your company and pick one of nine templates. You are the CEO.

   ![Setting up a company](.github/assets/setup.gif)

3. Connect your AI plans, add your computers with one command each, and invite friends with a link so they bring theirs.

   ![Connecting AI plans](.github/assets/subscriptions.png)

4. Tell the orchestrator what you are building. He proposes departments, and you create them with one click.

   ![Building the departments](.github/assets/build.gif)

5. Give a goal, like "Launch the iOS beta by Friday", and watch the company work on the map.

   ![The company map](.github/assets/map.gif)

Works with **Claude Code**, **Codex** (ChatGPT plans), **Kimi Code**, the **GLM Coding Plan** and **Google Antigravity**, and with Anthropic and OpenAI API keys. New programs and models are added as they come out. When a new version is out, one "Update" button moves every machine to it.

## For a startup or a team of friends

*Everyone brings what they have. The company uses all of it.*

- **Plans add up.** Each person connects their own plans on their own computer. All of them work on the same goal at once, and when one runs out, its task goes to the same role on another plan.
- **Computers add up.** Laptops, a Mac mini and an old server become one pool. Tests go to the freest machine and split across several. If the computer with the server turns off, the next one takes over within a minute, at the same link.
- **Everyone sees their part.** Each person gets the departments they work in, and inside them the agents on their own plans. Someone who runs several departments sits next to the CEO as a deputy.
- **Sign-ins stay with their owners.** Your plan's sign-in is sealed to your own machines. Nobody else can read it, the CEO included.
- **Real departments from day one.** Development, design, marketing, sales, support, finance. Nine company templates, each department with a head and employees who know their job.

![The Development department at work](.github/assets/development.gif)

![The pool of machines](.github/assets/machines.png)

## For your home

*Your home is a company too.*

- **Every device, watched.** One agent looks after the Wi-Fi and the router, another keeps the smart devices updated and tuned, and the department always knows the state of every device.
- **No junk on your devices.** Apps, extensions and settings that should not be there get found, and you get a list of what to remove.
- **The household runs itself.** One agent keeps the shopping list and supplies and drafts the orders, one tracks bills and subscriptions, one keeps the family calendar and chores.
- **Nothing happens behind your back.** Anything that changes a real device, buys something or pays for it waits for a person to say yes.
- **Runs on what you have.** An old laptop or a home server carries the work.

![A home run by Hornhoof](.github/assets/home.gif)

## See the work live

*Who works, who waits and who stands idle, right now.*

- **A work tree for every department.** Each agent is a line with its task, and each state has its own color: working, waiting for another task, waiting for a person, standing idle. Work that is handed in merges into the turn's branch before your eyes.
- **The speed of every turn.** How long each agent worked, waited and stood idle, and every wait with since when, so you see where the time goes.
- **A live terminal for every agent.** The real Claude Code, Codex, Kimi or Antigravity screen in your browser, whichever machine it runs on. Any line of the tree opens it.

![The work tree of a department](.github/assets/tree.gif)

![Where the time of a turn goes](.github/assets/speed.gif)

![An employee's terminal](.github/assets/terminal.gif)

## You decide, they do

- **One list for everything that needs you.** Questions, design choices and approvals wait in one place, and you answer from any device, your phone too.
- **Work in turns.** A goal becomes a turn of tasks, and each turn ends in a numbered release.
- **Nothing ships without you.** Work reaches your main branch only after the review of the turn, the final test run and your approval.

![Tasks and turns](.github/assets/tasks.gif)

## It gets better by itself

Hornhoof does not stay the way you installed it. Every company has an Operations department whose job is to make the company work better in your own setup:

- **A task watchdog** wakes every 10 minutes while there is work, nudges an agent that is stuck, and tells its head when that did not help.
- **A weak point collector** reads every three hours what failed and where agents stumbled, and writes each finding up with its facts and a fix.
- **Improvements** collect those fixes. You take one with a click, and the orchestrator does it or turns it into a task.
- **A program operator** looks after the AI programs themselves: it passes harmless screens, refuses what a program may not do, and brings you sign-ins and payments.
- **A reliability engineer** restores broken machines, tools and integrations, finds the cause, and writes down how to handle it next time.

## Next to the alternatives

"Parallel agent apps" run several coding agents side by side, each on its own copy of the code.

| | One AI program | Parallel agent apps | Hornhoof |
| --- | :---: | :---: | :---: |
| Agents of different makers work on one job at the same time | ❌ | ⚠️ side by side, you coordinate | ✅ |
| A main agent splits the work and hands it out | ❌ | ⚠️ some | ✅ |
| Each change reviewed by the other makers at once, then security, then tests | ❌ | ❌ | ✅ |
| Work goes on when a plan hits its limit | ❌ | ❌ | ✅ |
| Tests go to the freest of your computers | ❌ | ❌ | ✅ |
| Keeps running when the server's computer turns off | ❌ | ❌ | ✅ |
| Live terminal of every agent in the browser, on any machine | ❌ | ⚠️ this computer only | ✅ |
| Several people, each with their own plans and departments | ❌ | ❌ | ✅ |
| Departments beyond code, and the home | ❌ | ❌ | ✅ |

## Hornhoof builds itself

Hornhoof is developed inside Hornhoof. Its own company of agents on Claude, ChatGPT, Kimi and Google plans takes the tasks, writes the code, reviews it across makers, tests it and ships every turn as a release, the way large companies run on their own products.

## Let's build it together

I built Hornhoof for myself, to make working with AI convenient: several plans, several computers and far too many terminal tabs, working as one team. On the way I gathered what actually works: how to split work so agents do not wait on each other, which checks catch real bugs and which only slow things down, how to keep agents moving without babysitting them. All of it is in the templates, 50 roles and over 150 skills that every company starts with.

Let's join forces and make it the best way to run AI agents: the fastest, the most reliable, safe, and fully yours. The code is open under MIT, and Hornhoof's own company puts what you add to work right away. Try it and tell me what broke, bring the practices that work for you, write templates for departments and roles, translate the screens, or pick an issue marked "good first issue".

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Please read the [code of conduct](CODE_OF_CONDUCT.md), and report security problems privately, as [SECURITY.md](SECURITY.md) says.

## Good to know

- **It spends your plans.** A busy company uses its limits much faster than one person in one chat. You choose how much of each plan the company may take, from 50 to 90%, so some is always left for you.
- **Agents still make mistakes.** Reviews catch many of them, not all, so nothing ships without approval. Give agents only the access they need, like a token for one repository.
- **Read your AI plan's terms.** Each maker has its own rules for how its plan may be used.
- **Each agent is a real program on your machine.** More agents need more memory. Spare computers help.
- **Hornhoof is young.** It works and changes fast. Expect rough edges, and tell me about them.

## Your company stays yours

- It runs on your machines. No Hornhoof cloud, no account with us.
- Its data sits only on machines of the CEO and of people who see the whole company, and backups are encrypted.
- Every agent works in a locked box: a container with no folder of your computer in it, as a user of its own, unable to read the machine's keys or other plans.
- Root on a machine opens only when that machine's owner allows it, for a day at most.
- Keys and tokens show as `[hidden]` in every terminal and output.
- The hornhoof.org link is optional, and it passes your traffic on encrypted, unable to read it.

[SECURITY.md](SECURITY.md) explains each point.

## What comes next

- **Machines in different homes, connected directly**, without going through the public link.
- **More machines holding the company's data**, five out of ten instead of three.
- **Phones as workers.** An old Android phone on a charger runs work, and any device with a browser lends its power by keeping a page open.
- **Departments on their own turns.** Development on turn 8 while marketing is on turn 3, each with its own progress on the map.
- **Styles for the interface.** Pick the look you like in Settings.

## Questions

**Does it cost anything?** No. You use the AI plans you already have. Hornhoof is free and open source.

**How is it different from Claude Code or Codex?** Hornhoof uses them. They are the employees, Hornhoof is the company around them.

**Is it only for code?** No. There are templates for marketing, sales, support, research, finance and the home.

**Does my data go to you?** No. The AI programs talk to their makers as always, and nothing goes to us.

**Can I use my phone?** Yes, to watch, answer and approve from the browser.

## What Hornhoof is not

- Not a cloud service. There is no sign-up and no account with us.
- Not a new AI. It runs the AI programs you already use.
- Not a chat. Work is tasks, each with an owner, a review and a result.

## Learn more

The [guide](guide/README.md) explains every part, one topic per page: [install](guide/install.md), [the public link](guide/public-link.md), [machines and plans](guide/machines-and-plans.md), [the orchestrator](guide/orchestrator.md), [departments and employees](guide/departments-and-employees.md), [tasks and turns](guide/tasks-and-turns.md), [repositories](guide/repositories.md), [tests on free machines](guide/free-machines.md), [updates](guide/updates.md) and [security](SECURITY.md). More examples are in [EXAMPLES.md](EXAMPLES.md).

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Ivan Korol. The templates in `templates/` and the programs every node carries come from projects with their own licences, listed in `templates/SOURCES.md`.
