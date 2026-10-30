# Hornhoof

Run your company with a team of AI agents.

Hornhoof is a self-hosted workspace where people and AI agents work together as one company. You set up departments, each one led by an agent, and watch every agent's work live on one map.

The project is in early development. Right now you can set up a company, invite people, connect subscriptions from your machines, have the orchestrator build departments and staff them with agents, and talk to every agent. Agents take tasks in a later version.

## Quick start

You need Docker with Compose.

```sh
git clone https://github.com/Invariant0x/hornhoof.git
cd hornhoof
echo "HORNHOOF_SECRET=$(openssl rand -base64 32)" > .env
echo "NODE_KEY=$(openssl rand -base64 32)" >> .env
docker compose up -d --build
```

Open http://localhost:8080 and follow the setup: name your company, create your account and connect the orchestrator's subscription.

Keep `.env` safe. `HORNHOOF_SECRET` encrypts the API keys stored in the database, and without it they cannot be read back. `NODE_KEY` lets the built-in node, which runs the company's API keys, connect to Hornhoof.

If people will open Hornhoof from other machines, add `PUBLIC_URL=https://your.domain` to `.env`. Invite links and the node command use it, and sign-in cookies are marked secure when it starts with `https://`. Hornhoof itself serves plain HTTP, so put something that handles TLS in front of it, like Caddy, nginx or a Cloudflare tunnel. Without TLS the browser drops the secure cookie and you stay on the login screen.

Errors go to the container log: `docker compose logs app`.

If the owner forgets the password, run `docker compose exec app node apps/server/dist/cli.js owner-link` next to `compose.yaml`. It prints a one-time link that works for 7 days and sets a new password. The old password and open sessions stop working at once.

## Install with one command

On a Linux or macOS server:

```sh
curl -fsSL https://raw.githubusercontent.com/Invariant0x/hornhoof/main/scripts/install.sh | bash -s -- server
```

It installs Docker if it is missing (Colima through Homebrew on macOS), puts `compose.yaml` and a `.env` with fresh secrets into `~/hornhoof`, asks for the address people will open Hornhoof at, then downloads the images and starts them. Run it again to update; it keeps the existing `.env`.

### Several companies on one computer

Each company is its own Hornhoof. To run a second one next to the first, give it a name:

```sh
curl -fsSL https://raw.githubusercontent.com/Invariant0x/hornhoof/main/scripts/install.sh | bash -s -- server --name acme
```

It goes into `~/hornhoof-acme` as its own compose project, on the first free port from 8080, which it keeps in `.env` as `HORNHOOF_PORT`. Run the same command again to update that company. Machines can carry nodes for several companies too: each node remembers the address of its Hornhoof, and an update or `--uninstall` from one Hornhoof touches only that company's nodes.

## Connecting machines

Agents run on machines that hold the subscriptions. Company API keys run on the built-in node that comes with the server. A personal plan runs on its owner's machine, and only on Linux or macOS.

Open Subscriptions, choose Connect a subscription, tick the plans this machine will carry and copy the command. Run it in a terminal on that machine. The command installs Docker if needed, starts one small locked-down container per subscription and signs each one in:

- Claude opens the claude.ai login for your Claude plan.
- Codex opens the ChatGPT device login for your ChatGPT plan.
- Kimi opens the Kimi Code login.
- GLM asks you to paste your GLM Coding Plan key from z.ai.

Every node carries git, ripgrep and a headless Chromium with Playwright, so agents can open and check web pages; anything else they need they install into their own folder.

Agents will run on that machine with your subscription, and people with access to this Hornhoof can give them work. Agents that share one subscription run as one user on its machine, so they can read each other's folders and, while they work, each other's tokens; give departments whose work must stay apart subscriptions of their own. To update the nodes on a machine later, run `curl -fsSL <your Hornhoof address>/install.sh | bash` on it. To remove them, end the same command with `bash -s -- --uninstall`.

## Running the company

The orchestrator is the circle in the middle of the map. Click it and tell him about the company: he proposes departments on a card, and one click creates them.

Click a department to fly into it. "+ Hire" asks the orchestrator to staff it: he proposes people, each with a role, a subscription and a model, and "Hire" creates the ticked ones. When he cannot answer, the card comes from the department's default roster. Roles and their skills come from the templates in `templates/`.

Click an employee to open its card. It shows where the employee runs and on which model, with every subscription and key that may serve its department, its skills as a checklist, and its prompt by skill or as the raw text it receives. Any change applies from the employee's next turn, and the card keeps who made it and when. "Open terminal" talks to the employee.

Each person sees the whole company, or the departments and teams ticked for them. Someone who reaches more than one department shows next to the CEO on the map as a deputy.

## Tasks and turns

Work moves as tasks. The Tasks tab lists every task a person reaches, grouped by where it stands, with what agents wait for from people on top: questions to answer, commits to approve, and tasks an agent got stuck on.

A turn is the goal the whole company works on now. Someone who sees the whole company starts it on the Tasks tab; the orchestrator gets it as a task, splits it into one task per department and hands each to the department's head. The head breaks it into tasks for members, and gives each task its gates: the reviewers, testers or security people who check the work in order. A member works the task in a branch, hands it in with evidence, and each gate passes it on or sends it back with a reason. When all gates pass, the head reports to the orchestrator, and he reports the turn's task once every department is done. Closing the turn is the CEO's click.

Hornhoof wakes an agent when there is something for it: a task given to it, work at its gate, a task sent back, an answer from a person. An agent that ends three turns in a row without moving its task stops and asks a person how to go on.

Anyone whose access lists a department can give it a task from inside the department with "New task"; it goes to the department's head. Nothing reaches the main branch until someone who sees the whole company approves the exact commit; the department's people see it waiting.

## Repositories

A department, or a product inside it, can name the git repository its agents work in. Inside the department, people who see the whole company set its address, branch and a token. The token is kept encrypted and shows only its last four characters; it never reaches a command line or the clone's settings, and git gets it only for the repository's own host. A new address on another host needs a new token. Each turn carries it to the machine that runs the agent, so it lands on the machines of whoever's subscriptions serve the department: give it a fine-grained token for this one repository. A product's repository goes to the agents of that product instead of the department's. A commit author (a name and an email) makes every agent commit under that name: Hornhoof sets it in each clone and asks the agents to add no co-author lines. Without one, each agent's program picks its own.

Each agent gets its own clone in its own folder on the node before its first turn, keeps it between turns, and works in a branch per task. Nodes from 0.5.0 on take turns with a repository; an older node keeps them waiting until it is updated.

## Updates

Hornhoof checks for a newer build every 30 minutes. People who see the whole company get a banner when one is out: "Update" moves to it now, "Update when agents finish" waits until no agent is working. Versions in the account menu lists the published builds with the one running now and goes back to an earlier one the same way.

The updater runs next to the server. It saves the database, starts the new build with the installer inside it, and puts the previous build back if the new server does not answer. A server installed before the updater existed gets it when you run the install command once more.

## Development

You need Node 22.

```sh
npm install
npm test
```

Run Postgres, then start the server with `DATABASE_URL` and `HORNHOOF_SECRET` set (`npm run dev`) and the web app with `npm run dev -w apps/web`. The web app proxies `/api` to port 8080.
