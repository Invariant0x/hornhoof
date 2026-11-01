# Hornhoof

Run your company with a team of AI agents.

Hornhoof is a self-hosted workspace where people and AI agents work together as one company. You set up departments, each one led by an agent, and watch every agent's work live on one map.

The project is in early development. Right now you can set up a company, invite people, connect subscriptions from your machines, have the orchestrator build departments, staff them with agents and lay the work out in turns, and talk to every agent.

## Quick start

You need Docker with Compose.

```sh
git clone https://github.com/Invariant0x/hornhoof.git
cd hornhoof
echo "HORNHOOF_SECRET=$(openssl rand -base64 32)" > .env
echo "NODE_KEY=$(openssl rand -base64 32)" >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
docker compose up -d --build
```

Hornhoof writes a setup link to its log, like `http://localhost:8080/setup?code=...`. Find it with `docker compose logs app` (or print it with `docker compose exec app node apps/server/dist/cli.js setup-link`), open it and follow the setup: name your company, create your account and connect the orchestrator's subscription. Until a company is set up, only that link sets it up, so nobody else who reaches the port first can make the company their own.

Keep `.env` safe. `HORNHOOF_SECRET` encrypts the API keys stored in the database, and without it they cannot be read back. `NODE_KEY` lets the built-in node, which runs the company's API keys, connect to Hornhoof. `POSTGRES_PASSWORD` becomes the database's password when the database is first made, so keep it as it is afterwards.

If people will open Hornhoof from other machines, the simplest way is a link at hornhoof.org, described below. To use your own domain instead, add `PUBLIC_URL=https://your.domain` to `.env`. Invite links and the node command use it, and sign-in cookies are marked secure when it starts with `https://`. Hornhoof itself serves plain HTTP, so put something that handles TLS in front of it, like Caddy, nginx or a Cloudflare tunnel. Without TLS the browser drops the secure cookie and you stay on the login screen.

Errors go to the container log: `docker compose logs app`.

If the owner forgets the password, run `docker compose exec app node apps/server/dist/cli.js owner-link` next to `compose.yaml`. It prints a one-time link that works for 7 days and sets a new password. The old password and open sessions stop working at once.

## Install with one command

On a Linux or macOS server:

```sh
curl -fsSL https://raw.githubusercontent.com/Invariant0x/hornhoof/main/scripts/install.sh | bash -s -- server
```

It installs Docker if it is missing (Colima through Homebrew on macOS), puts `compose.yaml` and a `.env` with fresh secrets into `~/hornhoof`, asks for the address people will open Hornhoof at, then downloads the images, starts them and shows the link that sets Hornhoof up. Run it again to update; it keeps the existing `.env`. A Colima it sets up gets all of the Mac's processors and three quarters of its memory, and every node gets 2 GB of shared memory for the browsers agents run.

### Several companies on one computer

Each company is its own Hornhoof. To run a second one next to the first, give it a name:

```sh
curl -fsSL https://raw.githubusercontent.com/Invariant0x/hornhoof/main/scripts/install.sh | bash -s -- server --name acme
```

It goes into `~/hornhoof-acme` as its own compose project, on the first free port from 8080, which it keeps in `.env` as `HORNHOOF_PORT`. Run the same command again to update that company. Machines can carry nodes for several companies too: each node remembers the address of its Hornhoof, and an update or `--uninstall` from one Hornhoof touches only that company's nodes.

## A link on the internet

Setup offers the company a public link, like `https://acme.hornhoof.org`, so people open Hornhoof from anywhere. As you type the company's name, it shows the link the company will get, written in Latin letters. You can write another name or take a long random one, and Hornhoof tells you at once whether the name is free. The link is on unless you untick "Open Hornhoof on the internet"; then Hornhoof stays on your own computer and network, and you can open the link later.

With a link, invite links and the commands for new machines use it, and Hornhoof still opens at its own address as well. Anyone who learns the link reaches the sign-in page. A name like the company's own is easy to guess, so only the company's sign-ins protect what is inside; a random name is hard to guess.

hornhoof.org only passes the traffic on and has no accounts of its own. A small tunnel container next to the server keeps the connection to it, so nothing has to be opened on your router. It waits while the company has no link.

People who see the whole company find the link under Settings in the account menu: they copy it, move it to another name or remove it. The orchestrator does the same when asked. When the name changes or the link goes, machines that were connected through it lose the connection; connect them again under Subscriptions.

A link made earlier at hornhoof.org can be kept instead of getting a new one. Put its key in a file and run `docker compose exec -T app node apps/server/dist/cli.js link <name> < key-file` next to `compose.yaml`. hornhoof.org carries one tunnel per link, so stop any other tunnel for that link first.

## Connecting machines

Agents run on machines that hold the subscriptions. Company API keys run on the built-in node that comes with the server. A personal plan runs on its owner's machine, and only on Linux or macOS.

Open Subscriptions, choose Connect a subscription, tick the plans this machine will carry and copy the command. Run it in a terminal on that machine. The command installs Docker if needed, starts one small locked-down container per subscription and signs each one in:

- Claude opens the claude.ai login for your Claude plan.
- Codex opens the ChatGPT device login for your ChatGPT plan.
- Kimi opens the Kimi Code login.
- GLM asks you to paste your GLM Coding Plan key from z.ai.
- Antigravity, Google's agent program for a Google AI Pro or Ultra plan, opens the Google sign-in. Google then shows a code: paste it into the terminal where the command runs.

Every node carries git, ripgrep and a headless Chromium with Playwright, so agents can open and check web pages; anything else they need they install into their own folder.

Agents will run on that machine with your subscription, and people with access to this Hornhoof can give them work. Inside its container the node runs as root and its agents as a user of their own, so no agent reads the node's key, changes its programs or types into another agent's terminal, and the node takes a tool call only from the program of the agent it belongs to. Agents that share one subscription still share that user and its sign-in, so they can read each other's folders and the repository tokens they work with; give departments whose work must stay apart subscriptions of their own. To update the nodes on a machine later, run `curl -fsSL <your Hornhoof address>/install.sh | bash` on it. To remove them, end the same command with `bash -s -- --uninstall`.

A plan at its usage limit holds its agents' turns until the limit starts over, and their tasks go on after it. An employee's task it was doing goes instead to another employee of the same role in the department who is on, on a plan of another provider that is not at its limit, with one note in the task; heads and the orchestrator wait for the reset. Hornhoof learns it from the plan's own figures, or from the error its program prints, Kimi's 429 or Codex's "hit your usage limit"; a program that names no time is tried again every quarter of an hour. Next to each plan's limits, "Tasks may use" sets the share of every limit window that task turns may spend, from 50 to 90 percent: past it they wait for that window to start over, while messages from people still go.

## Running the company

The orchestrator is the circle in the middle of the map. Click it and tell him about the company: he proposes departments on a card, and one click creates them. He runs the company the way the CEO does in the screens, so you can also just tell him what to do: add or remove a department, hire, rename or fire an employee, switch employees off or on, change their models, skills and prompts, write to an employee, answer what an employee asked, rewrite or cancel a task, invite people, and manage subscriptions, machines, updates and the public link. Answering what an employee asked includes approving or declining a commit. Each of these goes through the same check as the CEO's click, so what is refused to the CEO is refused to him too: nobody can fire the orchestrator or disable the owner, for example. He also does one thing only he does: he puts what an employee asks people into plain words, shown above their answer. For what no screen reaches, like a stuck row or a wrong field, he also reads and changes Hornhoof's database directly, as a database role of his own: it reaches the rows of every table but sign-ins, invites, install codes, the public link and passwords, cannot change the tables themselves, and nothing outside the database. The head of Operations has the same tool, since keeping the company running is its job. When work goes wrong he looks there and in the screens first, then fixes the cause himself or gives it to Operations as one task, instead of asking the CEO. A few things stay with people. He does not open the live feed, the pictures agents send, terminals, or the sign-in and invite pages, and cannot type into an employee's terminal. He does not take improvements into work or set them aside; the CEO decides, and he does the ones the CEO gives him. When he writes to an employee, his words do not answer what the employee asked people. The employee's card and window say the orchestrator did it.

Click a department to fly into it. Its schema shows the head on top and a frame for each role, with work going left to right through the gates and an amber line for what a gate sent back; every employee shows what it does now (working, queued, handed on, waiting for a decision, free) and the task it is about. On the map, a department's card has one square per employee in the same colors. "Department tasks" and "About the department" open its tasks, repository, products and people at the left. "+ Hire" asks the orchestrator to staff it: he proposes people, each with a role, a subscription and a model, and "Hire" creates the ticked ones. When he cannot answer, the card comes from the department's default roster. Roles and their skills come from the templates in `templates/`.

Click an employee to open its window, with its terminal or its log; a small mark next to its name says whether it works in Claude, Codex, Kimi, GLM or Antigravity. "Card" in the window shows where the employee runs and on which model, with every subscription and key that may serve its department, its skills as a checklist, and its prompt by skill or as the raw text it receives. Any change applies from the employee's next turn, and the card keeps who made it and when.

The tick on each employee and on the head switches it off for now, without opening it. An employee that is off ends the turn it runs, then takes no task turns until it is on again; people can still write to it. The work it was doing goes back to its head, who gives it to someone who is on. The head spreads tasks over the implementers that are on, a different task for each. Reviewers of different models find different things, so at each gate one employee of the gate's role for each maker of models checks the same work at once, such as one on Claude and one on Codex: of each, the one that is on with the fewest tasks at a gate. The gate passes when all of them pass, and a send-back gives the executor all their reasons in one list. The work handed in again goes straight back to that gate, and only to the reviewers who sent it back, each checking the fixes for its own findings. The tick on a role's frame switches all of its employees off or on at once. A role with nobody on takes no part: it gets no tasks, and work passes its gate by on to the next one, or is done after the last. A gate whose role has people on, none of whom can check it, for example without a subscription, waits with the head and says who they are: it starts again once one of the role who is on can check it, or the head gives it other gates. A department whose head is off, or whose employees are all off, gets no work from the orchestrator.

An employee on a personal Claude Code, Codex, Kimi Code or Antigravity plan works in its own terminal session on its owner's machine, and its window shows that session live, as the program draws it. Antigravity's own screen tells Hornhoof neither its answers nor its steps, so there each message goes to Antigravity's print mode, and the window shows its answer and steps as they come: a line typed while it works goes after the running turn. The plan's owner can type into it as into any terminal: a line sent there becomes a turn of the conversation, with Hornhoof's tools, and Escape stops it as it stops the program. Only a line a person sent from this window opens such a turn; the agent's program cannot open one for itself. Opening the window of an employee whose program does not run starts it, so the owner can type to it at once. Everyone else who reaches the employee watches. "Log" shows the conversation as Hornhoof keeps it, and "Stop" ends the running turn. Employees on company API keys show the log.

Each person sees the whole company, or the departments and teams ticked for them. Someone who reaches more than one department shows next to the CEO on the map as a deputy.

## Tasks and turns

Work moves as tasks, and tasks come in turns. Nobody fills the tracker by hand: people write to the orchestrator, and he lays the work out. A turn has a short title, its main point, and one task for each goal the CEO gave it, whole, for the department that owns it; the people's own words it came from open on a click. The Tasks tab shows what agents wait for from people on top (questions to answer, commits to approve, tasks an agent got stuck on), then the running turn with its tasks, the planned turns in order, and the finished ones folded away.

One turn runs at a time. When the orchestrator lays out a turn while one runs, it waits as planned, with its tasks planned too. When people add to the work, he puts it into the next planned turn or into a new turn after them, and into the running turn, where it starts at once, only when the CEO says now; he says where it went. Each task of a running turn goes to its department's head, who gives it out at once in two to four large pieces, in Development a whole feature for each developer of the pool, after a short design note by an architect when the feature is new or large. Each piece gets only the gates its size and risk need: none for research, reports, plans and docs, one review stage for code, where a reviewer of each provider checks the same change in parallel, and security only when the change touches access, sign-in, secrets or permissions. Acceptance runs once per turn, on the turn's branch. A member works the task in a branch, hands it in with evidence, and each gate passes it on, with notes for the rest, or sends it back only for what blocks: a failing test, an unmet requirement, a security hole or data loss. When all gates pass, where the department works in a repository, the task goes back to its member, who merges the branch into the turn's branch and reports it, or says what blocks the merge. The head hears once, when every task it gave out under its department's task is closed, and reports to the orchestrator. A task can come after other tasks of its turn: it waits, and its member is woken by itself once the last of them is done. When one of them is cancelled, whoever made the waiting task is told. Once every task of the turn is closed, the turn ends and the next planned one starts by itself.

Hornhoof wakes an agent when there is something for it: a task given to it, work at its gate, a task sent back, an answer from a person. An agent that ends a turn without moving its task is reminded; after three such turns in a row it stops and a person is asked how it should go on. A turn that broke, one in which the agent wrote in the task how far it got, or one that worked until its time ran out counts as going on instead: a person is asked only after eight such turns in a row, about six hours of work without handing anything in. A turn that ended at the plan's limit counts for neither, and the agent goes on once the limit starts over. Three turns in a row on a task that break within minutes of starting stop Hornhoof waking the agent there: whoever gave the task out hears it once, with the error, and the task waits for them. A turn a person stopped does not count, and nothing is counted while the agent has another turn waiting on the task or while the task waits for the tasks it gave out or for people.

An agent on a task can put a file on it, such as a build, a log or a data set of up to 50 MB, with `hh-attach --task 12 FILE` on its machine. Any agent of the company downloads it by its name with `hh-fetch 12 FILE`, on any machine, and the task's view lists its files. A comment, message, report or reason that carries a file pasted as a long run of base64 or hex is refused with that way to put the file on the task.

Anyone whose access lists a department can give it a task from inside the department with "New task"; it goes to the department's head and joins the running turn, if one runs. Nothing reaches the main branch until someone who sees the whole company, or the orchestrator, approves the exact commit; the department's people see it waiting.

## Repositories

A department, or a product inside it, can name the git repository its agents work in. Inside the department, people who see the whole company set its address, branch and a token. The token is kept encrypted and shows only its last four characters; it never reaches a command line or the clone's settings, and git gets it only for the repository's own host. A new address on another host needs a new token. Each turn carries it to the machine that runs the agent, so it lands on the machines of whoever's subscriptions serve the department: give it a fine-grained token for this one repository. A product's repository goes to the agents of that product instead of the department's. A commit author (a name and an email) makes every agent commit under that name: Hornhoof sets it in each clone and asks the agents to add no co-author lines. Without one, each agent's program picks its own.

Each agent gets its own clone in its own folder on the node before its first turn, keeps it between turns, and works in a branch per task. Nodes from 0.5.0 on take turns with a repository; an older node keeps them waiting until it is updated.

## Updates

Hornhoof checks for a newer build every 30 minutes. People who see the whole company get a banner when one is out: "Update" moves to it now, "Update when agents finish" waits until no agent is working. Versions in the account menu lists the published builds with the one running now and goes back to an earlier one the same way.

The updater runs next to the server. It downloads exactly the build Hornhoof found, by its digest, and the node and updater images of the same build, by theirs, while the old server keeps working. Then it saves the database, starts exactly these images with the installer inside the build, and puts the images that ran before back if the new server does not answer. `.env` names the images compose starts, so a tag that moves in the registry later changes nothing. When the new build had already changed the database, the database goes back to the saved copy too. An updater that restarts in the middle of an update goes on with it. A server installed before the updater existed gets it when you run the install command once more.

## Development

You need Node 22, and bash and jq for the tests of the installer and the updater (`brew install jq` on a Mac, `apt install jq` on Debian or Ubuntu).

```sh
npm install
npm test
```

Run Postgres, then start the server with `DATABASE_URL` and `HORNHOOF_SECRET` set (`npm run dev`) and the web app with `npm run dev -w apps/web`. The web app proxies `/api` to port 8080.
