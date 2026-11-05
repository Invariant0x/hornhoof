![Hornhoof](.github/assets/logo.svg)

# Hornhoof

**Your own company of AI agents, on your own computers.**

Hornhoof turns the AI plans you already pay for, like Claude, ChatGPT, Kimi, GLM or Google AI, into a company that works for you.

You write what you want in plain words. The orchestrator, the main agent, splits it into tasks and gives them to departments. Every department has a head and employees, and every employee is an AI agent. You watch all of them on one map, see what each one is doing right now, and step in only when someone asks you.

It all runs on your own computers. There is no account to make, nothing to sign up for, and no Hornhoof server that holds your company.

Hornhoof is young. It works, and it changes fast. Expect rough edges, and tell us about them.

## Hornhoof is for you if

- ✅ You pay for more than one AI plan and want all of them working, not waiting.
- ✅ You have ten Claude Code or Codex windows open and no longer remember which one does what.
- ✅ You want to give a goal and get the result, not watch every step.
- ✅ You and a few friends each have a plan and want to build something together.
- ✅ You have an old laptop, a home server or a spare Mac that sits idle most of the day.
- ✅ You want the company to keep going when one of your computers turns off.
- ✅ You want to look in from your phone, wherever you are.
- ✅ You want it all on your own machines, under your own control.

## What changes

| | AI programs on their own | With Hornhoof |
| --- | :---: | :---: |
| All your AI plans work at the same time, on one job | ❌ | ✅ |
| Work goes on when a plan hits its limit | ❌ | ✅ |
| Agents hand work to each other, without you copying it over | ❌ | ✅ |
| Every change is reviewed by an AI of another maker | ❌ | ✅ |
| Nothing reaches the main branch before its exact commit is approved | ❌ | ✅ |
| One map shows what every agent is doing right now | ❌ | ✅ |
| Spare computers take tests and heavy jobs | ❌ | ✅ |
| The company keeps running when one of your computers stops | ❌ | ✅ |
| Friends join with their own plans | ❌ | ✅ |
| Runs on your own machines, with no sign-up | ✅ | ✅ |

"AI programs on their own" means Claude Code, Codex, Kimi Code and the like, each in its own window. Hornhoof runs them for you as one team.

## How it works

The pictures show Moonfern, a made-up company. Its people, plans and work are invented for the demo.

1. Install Hornhoof with one line in the terminal.

2. Open the link it shows. Name your company and pick a template, or start empty.

   ![Setting up a company](.github/assets/setup.gif)

3. Connect your AI plans. Each runs on your own computer, in a small locked box of its own, and you sign it in once in Hornhoof for all your machines.

   ![Connecting AI plans](.github/assets/subscriptions.png)

4. Tell the orchestrator about your company. He proposes departments and people for them. You tick what you want and click once.

   ![Building the departments](.github/assets/build.gif)

5. Write what you need. The orchestrator packs it into a turn of tasks, the heads hand out the work, and you watch it move on the map.

   ![The company map](.github/assets/map.gif)

## What people do with it

### Many AI plans working as one team

Say you have Claude, ChatGPT and Kimi. Usually you work in one of them while the others wait. In Hornhoof each plan carries its own employees, so developers on Claude, on Codex and on Kimi take different tasks of the same job at the same time.

A change written on one maker's model is checked by reviewers on the others, because each of them catches mistakes the others miss. When one plan reaches its limit, its task goes to an employee of the same role on another plan, or waits until the limit resets and then goes on by itself. You set how much of each plan's limit the tasks may use, so some is always left for you.

![The Development department at work](.github/assets/development.gif)

### Too many windows

Instead of a dozen chats you have one company. You write to the orchestrator once, he turns it into tasks, and each department's head gives them out. Every employee works in its own terminal, which you can open and watch live, and type into when the plan is yours. When an agent needs you, its question waits for you at the top of Tasks, so you answer everything in one place.

![An employee's terminal](.github/assets/terminal.gif)

![Tasks and turns](.github/assets/tasks.gif)

### A company that keeps itself moving

Operations, a department in every company template, keeps the work going so you do not have to. Its task watchdog wakes every 10 minutes while there is work, nudges any agent that is stuck on a task, and tells the head when a nudge did not help. Every three hours another agent reads what failed and where agents stumbled, and proposes fixes. They wait for you under Improvements.

### All your computers in one pool

Connect your work laptop, an old one and a home server, each with one command. A computer needs no AI plan to join: it can simply lend its power.

The Machines tab shows every machine of the company as one pool: how many are online, their processor cores and free memory together, and how busy they are right now. Each machine's card shows its owner, system, processor, memory, free disk and load, and the employees and test runs on it at the moment.

The pool does the heavy lifting. When an agent runs the tests, Hornhoof sends them to the freest machine, and splits a big test suite over several machines at once when the test runner can split it. Builds, reports and other heavy commands go out the same way, and their results come back to the task. The agents keep working where they are meanwhile. A machine whose processors are busy 90% of the time or more gets no new work. If a machine goes away in the middle of a test run, its part starts again on another one. A new employee starts on the freest machine of its plan.

Every machine is lent to the pool at first. Its owner keeps it out with one tick on its card, "Lend to test runs".

![The pool of machines](.github/assets/machines.png)

### One company on all your machines

Your company does not live on one computer. One of your machines leads, and up to two more keep a full copy of the company's data. If the leading machine stops, an up-to-date copy takes over within about a minute, by itself, under the same link. Every machine of the company opens it at `localhost`, and the public link always reaches it.

Hornhoof picks each machine's role by itself and shows it on the Machines tab: Leader, Copy, Voter, or Worker, which only does work. Copies go only to machines of the CEO and of people who see the whole company. Every 6 hours and before each update, the leading machine makes an encrypted backup, and up to three other company machines keep the latest two. They cannot open them: only the machines that may hold the data, and the recovery file you save in Settings, can.

If your machines lose sight of each other, each side with internet keeps working, and Hornhoof merges the two sides when they meet again. A real conflict goes to the orchestrator, who tells you.

You sign in to a plan once, and it runs on any of your machines. A ChatGPT plan runs on one machine at a time and moves by itself when that machine goes offline. Antigravity still signs in on each machine.

### Building something with friends

Invite each friend with a link. Everyone connects their own plan on their own computer, so their agents work for the shared company. Their sign-in is sealed to their own machines: Hornhoof keeps it locked with each machine's key and cannot read it. Give each person the departments they work in, and they see only those. Someone who works across several departments shows up next to the CEO on the map as a deputy.

### Several products

Put a product under a department for each thing you build, each with its own git repository. The "Studio with products" template sets this up: one development department with several products under it.

### A home full of devices

The Home template gives you a department that looks after the Wi-Fi, the router and the smart home, and a household department for shopping lists, bills and the family calendar. Anything that touches a real device or spends money waits for a person to say yes.

More examples, from a cybersecurity company to several companies on one computer, are in [EXAMPLES.md](EXAMPLES.md).

## Your company stays yours

- It runs on your machines. There is no Hornhoof cloud, no account with us, and no Hornhoof server that holds your company.
- Its database sits only on machines of the CEO and of people who see the whole company. Backups are encrypted, so only those machines and your recovery file open them.
- Every agent works in a locked box: a Docker container with no folder of your computer in it, where the agent runs as a user of its own and cannot read the machine's keys.
- Root on a machine opens only when that machine's owner allows it, for a day at most. Nobody else can allow it, the CEO included.
- A plan's sign-in opens only on its owner's machines. Keys and tokens show as `[hidden]` in every terminal and every output.
- Stored keys are encrypted, passwords are hashed, and each person sees only the departments they are given.
- The hornhoof.org link is optional. It passes traffic to your company through a tunnel your own server opens, and keeps no copy of it.

[SECURITY.md](SECURITY.md) explains each point, and how to report a problem.

## Install

You need a computer with macOS or Linux. Windows is not supported yet. Docker is installed for you if it is missing.

1. Open a terminal. On a Mac, press `Cmd` and `Space`, type `Terminal` and press `Enter`. On Linux, like Ubuntu, press `Ctrl`, `Alt` and `T`.

2. Copy this line, paste it into the terminal and press `Enter`:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Invariant0x/hornhoof/main/scripts/install.sh | bash -s -- server
   ```

3. It may ask for your computer's password, to install Docker. If Docker Desktop is installed but not running, it starts it.

4. Wait a few minutes. The first time, it downloads Hornhoof. At the end it shows a link like `http://localhost:8080/setup?code=...`.

5. Open that link in your browser and follow the steps. Name your company, pick a template, and create your account: you become the CEO. Then choose how the orchestrator runs. "My subscription" gives you one more command to run in the terminal. It opens your plan's sign-in page, and the orchestrator starts as soon as you sign in.

Now you are on the map, with the orchestrator in the middle. Click him and tell him about your company.

### Add more later

- To add another computer, open Machines, click "Connect a machine", then "Copy", and run the command in a terminal on that computer.
- To add your AI plans, open Subscriptions, click "Connect a subscription", tick your plans, click "Get the command" and run it on the computer that will carry them. Each plan opens its own sign-in there, or you sign it in once on the Subscriptions tab, and it reaches every machine of yours.
- To invite a friend, open People, click "Invite person", fill in their name and email and tick what they may see, click "Send invite", then "Copy link", and send them the link yourself.
- When a new version is out, Hornhoof shows a banner with an "Update" button. Running the install line again updates too.

### Remove it

- To remove what Hornhoof put on a connected computer, run `curl -fsSL <your Hornhoof address>/install.sh | bash -s -- --uninstall` on it.
- To remove the server, run `docker compose down -v` in the `~/hornhoof` folder and delete the folder. This deletes all of the company's data.

## Questions

**Does Hornhoof cost anything?**
No. You use the AI plans you already have. Hornhoof itself is free.

**Which AI plans work?**
Claude plans through Claude Code, ChatGPT plans through Codex, Kimi Code, the GLM Coding Plan from z.ai, and Google AI Pro or Ultra through Antigravity. A company can also use Anthropic or OpenAI API keys.

**Does my data go to you?**
No. There is no Hornhoof server that holds your company: it lives on your own machines. The AI programs send your prompts and code to their makers, as they always do. The optional hornhoof.org link passes the traffic on to your company and keeps no copy of it. It has no accounts. [SECURITY.md](SECURITY.md) says exactly what it sees and what it keeps.

**Is it safe to let agents work on their own?**
Every agent works in a locked box on the machine: a Docker container of its plan, as a user of its own, and it cannot read the keys of the machine or of other plans. Code passes reviews, nothing reaches the main branch before its exact commit is approved, and in the Home template anything that acts on a real device or spends money waits for a person. Agents still make mistakes, so give them access only to what they need, like a token for one repository.

**What happens when a computer turns off?**
If it led the company, an up-to-date copy takes over within about a minute, under the same link. Its employees move to another machine with the same plan, or wait until it comes back. A test run it was doing starts again on another machine.

**How is this different from Claude Code or Codex?**
Hornhoof uses them. They are the employees, and Hornhoof is the company around them: departments, tasks, reviews and one view of it all.

**Can I use my phone?**
You can open and run your company from the phone's browser. Phones that do work themselves, like an old Android on a charger, are coming next.

**What if the hornhoof.org link stops opening after an update?**
Put `ACME_DIRECTORY=off` in the `.env` file in the `~/hornhoof` folder and run `docker compose up -d app` there. The link opens again within a minute, with its https ending at hornhoof.org as before. Then tell us in an issue.

## What Hornhoof is not

- It is not a cloud service. There is no sign-up and no account with us. It is yours, on your machines.
- It is not a new AI. It runs the AI programs you already use.
- It is not a chat. Work is tasks, each with someone who owns it, a review and a result.
- It is not only for code. There are templates for marketing, sales, support, research, finance and the home.

## Help build Hornhoof

Hornhoof is built by a few people and a lot of agents, and we are looking for more of both. If you want a company of agents of your own and want to shape how it works, join us. You can:

- try it and tell us what broke or what confused you;
- bring ideas for what would make your own company of agents work better;
- translate the screens, which are in English and Russian now;
- write templates for departments, roles and skills that fit any company;
- fix and build things, starting with an issue marked "good first issue".

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Please read the [code of conduct](CODE_OF_CONDUCT.md), and report security problems privately, as [SECURITY.md](SECURITY.md) says.

## Learn more

The [guide](guide/README.md) explains how Hornhoof works, in detail, one topic per page:

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
