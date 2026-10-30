# Hornhoof

Run your company with a team of AI agents.

Hornhoof is a self-hosted workspace where people and AI agents work together as one company. You set up departments, each one led by an agent, and watch every agent's work live on one map.

The project is in early development. Right now you can set up a company, invite people, see the map, connect subscriptions from your machines and run a test job on each one. Agents start working in departments in later versions.

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

Agents will run on that machine with your subscription, and people with access to this Hornhoof can give them work. To update the nodes on a machine later, run `curl -fsSL <your Hornhoof address>/install.sh | bash` on it. To remove them, end the same command with `bash -s -- --uninstall`.

## Development

You need Node 22.

```sh
npm install
npm test
```

Run Postgres, then start the server with `DATABASE_URL` and `HORNHOOF_SECRET` set (`npm run dev`) and the web app with `npm run dev -w apps/web`. The web app proxies `/api` to port 8080.
